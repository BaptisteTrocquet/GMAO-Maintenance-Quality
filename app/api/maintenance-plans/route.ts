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
    frequencyValue: z.number().int().min(1).max(10_000_000),
    frequencyUnit: z.enum(["DAY", "WEEK", "MONTH", "YEAR", "METER"]),
    firstDueAt: z.coerce.date().optional(),
    meterId: z.string().min(1).optional(),
    firstDueMeterValue: z.number().finite().min(0).optional(),
    estimatedMinutes: z.number().int().min(0).max(1_000_000).nullable().optional(),
    checklist: z.array(checklistItemSchema).max(200).optional(),
    cloneChecklistFromPlanId: z.string().min(1).optional(),
  })
  .superRefine((value, context) => {
    if (value.checklist?.length && value.cloneChecklistFromPlanId) {
      context.addIssue({
        code: "custom",
        path: ["checklist"],
        message: "Provide either checklist or cloneChecklistFromPlanId, not both",
      });
    }

    if (value.frequencyUnit === "METER") {
      if (!value.meterId) {
        context.addIssue({ code: "custom", path: ["meterId"], message: "meterId is required for meter plans" });
      }
      if (value.firstDueMeterValue === undefined) {
        context.addIssue({
          code: "custom",
          path: ["firstDueMeterValue"],
          message: "firstDueMeterValue is required for meter plans",
        });
      }
      if (value.firstDueAt) {
        context.addIssue({ code: "custom", path: ["firstDueAt"], message: "firstDueAt is not used for meter plans" });
      }
    } else {
      if (!value.firstDueAt) {
        context.addIssue({ code: "custom", path: ["firstDueAt"], message: "firstDueAt is required for calendar plans" });
      }
      if (value.meterId || value.firstDueMeterValue !== undefined) {
        context.addIssue({
          code: "custom",
          path: ["meterId"],
          message: "Meter fields are only valid for meter plans",
        });
      }
    }
  });

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
      meter: {
        select: {
          id: true,
          code: true,
          name: true,
          unit: true,
          readings: { orderBy: { readingAt: "desc" }, take: 1, select: { value: true, readingAt: true } },
        },
      },
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
      followingDueMeterValue:
        plan.frequencyUnit === "METER" && plan.nextDueMeterValue !== null
          ? plan.nextDueMeterValue + plan.frequencyValue
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

  let meter: { id: string } | null = null;
  if (parsed.data.frequencyUnit === "METER") {
    meter = await db.meter.findFirst({
      where: { id: parsed.data.meterId, assetId: asset.id, allowRollover: false },
      select: { id: true },
    });
    if (!meter) {
      return apiError(
        404,
        "METER_NOT_FOUND",
        "Monotonic meter not found on the selected asset; rollover meters are not supported for recurrence",
      );
    }
  }

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
      meterId: meter?.id ?? null,
      name: parsed.data.name,
      description: parsed.data.description ?? null,
      frequencyValue: parsed.data.frequencyValue,
      frequencyUnit: parsed.data.frequencyUnit,
      nextDueAt: parsed.data.frequencyUnit === "METER" ? null : parsed.data.firstDueAt!,
      nextDueMeterValue:
        parsed.data.frequencyUnit === "METER" ? parsed.data.firstDueMeterValue! : null,
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
    include: {
      meter: { select: { id: true, code: true, name: true, unit: true } },
      checklistItems: { orderBy: { sequence: "asc" } },
    },
  });

  const followingDueAt =
    parsed.data.frequencyUnit === "METER"
      ? null
      : advanceCalendarDue({
          currentDueAt: parsed.data.firstDueAt!,
          frequencyValue: parsed.data.frequencyValue,
          frequencyUnit: parsed.data.frequencyUnit,
          timeZone: site.organization.timezone,
        });
  const followingDueMeterValue =
    parsed.data.frequencyUnit === "METER"
      ? parsed.data.firstDueMeterValue! + parsed.data.frequencyValue
      : null;

  await db.auditLog.create({
    data: {
      actorId: auth.session.user.id,
      entityType: "MaintenancePlan",
      entityId: created.id,
      action: "CREATED",
      afterJson: JSON.stringify({ ...created, followingDueAt, followingDueMeterValue }),
    },
  });

  return apiData({ ...created, followingDueAt, followingDueMeterValue }, { status: 201 });
}
