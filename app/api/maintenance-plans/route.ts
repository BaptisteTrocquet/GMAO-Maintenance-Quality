import { z } from "zod";
import { apiData, apiError } from "@/lib/api-response";
import { AccessDeniedError, assertSitePermission } from "@/lib/access-control";
import { authenticateRequest } from "@/lib/auth/request-auth";
import { db } from "@/lib/db";
import { advanceCalendarDue, type CalendarFrequencyUnit } from "@/lib/maintenance/calendar";

const checklistItemSchema = z.object({
  label: z.string().trim().min(1).max(500),
  mandatory: z.boolean().default(true),
});

const createSchema = z
  .object({
    organizationId: z.string().min(1),
    siteId: z.string().min(1),
    assetId: z.string().min(1),
    name: z.string().trim().min(1).max(200),
    description: z.string().max(5000).nullable().optional(),
    frequencyValue: z.number().int().min(1).max(10_000),
    frequencyUnit: z.enum(["DAY", "WEEK", "MONTH", "YEAR"]),
    firstDueAt: z.coerce.date(),
    estimatedMinutes: z.number().int().min(0).max(1_000_000).nullable().optional(),
    checklist: z.array(checklistItemSchema).max(200).optional(),
    cloneChecklistFromPlanId: z.string().min(1).optional(),
  })
  .refine(
    (value) => !(value.checklist?.length && value.cloneChecklistFromPlanId),
    { message: "Provide either checklist or cloneChecklistFromPlanId, not both" },
  );

function denied(error: unknown) {
  if (error instanceof AccessDeniedError) {
    return apiError(403, "ACCESS_DENIED", error.message);
  }
  throw error;
}

async function scopedSite(organizationId: string, siteId: string) {
  return db.site.findFirst({
    where: { id: siteId, organizationId, active: true, organization: { active: true } },
    select: { id: true, organization: { select: { timezone: true } } },
  });
}

export async function GET(request: Request) {
  const url = new URL(request.url);
  const organizationId = url.searchParams.get("organizationId");
  const siteId = url.searchParams.get("siteId");
  if (!organizationId || !siteId) {
    return apiError(400, "INVALID_SCOPE", "organizationId and siteId are required");
  }

  const auth = await authenticateRequest(request, organizationId);
  if ("error" in auth) return auth.error;

  try {
    assertSitePermission(auth.tenant.scope, siteId, "maintenance:read");
  } catch (error) {
    return denied(error);
  }

  const site = await scopedSite(organizationId, siteId);
  if (!site) return apiError(404, "SITE_NOT_FOUND", "Site not found");

  const plans = await db.maintenancePlan.findMany({
    where: { asset: { siteId } },
    include: {
      asset: { select: { id: true, code: true, name: true } },
      checklistItems: { orderBy: { sequence: "asc" } },
    },
    orderBy: [{ active: "desc" }, { nextDueAt: "asc" }, { name: "asc" }],
  });

  return apiData(
    plans.map((plan) => ({
      ...plan,
      followingDueAt:
        plan.nextDueAt && plan.frequencyUnit !== "METER"
          ? advanceCalendarDue({
              currentDueAt: plan.nextDueAt,
              frequencyValue: plan.frequencyValue,
              frequencyUnit: plan.frequencyUnit as CalendarFrequencyUnit,
              timeZone: site.organization.timezone,
            })
          : null,
    })),
  );
}

export async function POST(request: Request) {
  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return apiError(400, "INVALID_JSON", "Request body must be valid JSON");
  }

  const parsed = createSchema.safeParse(body);
  if (!parsed.success) {
    return apiError(400, "INVALID_PAYLOAD", "Invalid maintenance plan payload", parsed.error.flatten());
  }

  const auth = await authenticateRequest(request, parsed.data.organizationId);
  if ("error" in auth) return auth.error;

  try {
    assertSitePermission(auth.tenant.scope, parsed.data.siteId, "maintenance:manage");
  } catch (error) {
    return denied(error);
  }

  const site = await scopedSite(parsed.data.organizationId, parsed.data.siteId);
  if (!site) return apiError(404, "SITE_NOT_FOUND", "Site not found");

  const asset = await db.asset.findFirst({
    where: { id: parsed.data.assetId, siteId: parsed.data.siteId, archivedAt: null },
    select: { id: true },
  });
  if (!asset) return apiError(404, "ASSET_NOT_FOUND", "Asset not found in site scope");

  let checklist = parsed.data.checklist ?? [];
  if (parsed.data.cloneChecklistFromPlanId) {
    const source = await db.maintenancePlan.findFirst({
      where: {
        id: parsed.data.cloneChecklistFromPlanId,
        asset: { site: { organizationId: parsed.data.organizationId } },
      },
      include: { checklistItems: { orderBy: { sequence: "asc" } } },
    });
    if (!source) {
      return apiError(404, "SOURCE_PLAN_NOT_FOUND", "Checklist source plan not found in organization scope");
    }
    checklist = source.checklistItems.map((item) => ({
      label: item.label,
      mandatory: item.mandatory,
    }));
  }

  const created = await db.maintenancePlan.create({
    data: {
      assetId: asset.id,
      name: parsed.data.name,
      description: parsed.data.description ?? null,
      frequencyValue: parsed.data.frequencyValue,
      frequencyUnit: parsed.data.frequencyUnit,
      nextDueAt: parsed.data.firstDueAt,
      active: true,
      estimatedMinutes: parsed.data.estimatedMinutes ?? null,
      checklistItems: {
        create: checklist.map((item, index) => ({
          sequence: index + 1,
          label: item.label,
          mandatory: item.mandatory,
        })),
      },
    },
    include: { checklistItems: { orderBy: { sequence: "asc" } } },
  });

  const followingDueAt = advanceCalendarDue({
    currentDueAt: parsed.data.firstDueAt,
    frequencyValue: parsed.data.frequencyValue,
    frequencyUnit: parsed.data.frequencyUnit,
    timeZone: site.organization.timezone,
  });

  await db.auditLog.create({
    data: {
      actorId: auth.session.user.id,
      entityType: "MaintenancePlan",
      entityId: created.id,
      action: "CREATED",
      afterJson: JSON.stringify({ ...created, followingDueAt }),
    },
  });

  return apiData({ ...created, followingDueAt }, { status: 201 });
}
