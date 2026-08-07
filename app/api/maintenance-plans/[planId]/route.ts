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

const updateSchema = z.object({
  organizationId: z.string().min(1),
  siteId: z.string().min(1),
  name: z.string().trim().min(1).max(200).optional(),
  description: z.string().max(5000).nullable().optional(),
  frequencyValue: z.number().int().min(1).max(10_000_000).optional(),
  frequencyUnit: z.enum(["DAY", "WEEK", "MONTH", "YEAR", "METER"]).optional(),
  nextDueAt: z.coerce.date().nullable().optional(),
  nextDueMeterValue: z.number().finite().min(0).nullable().optional(),
  estimatedMinutes: z.number().int().min(0).max(1_000_000).nullable().optional(),
  active: z.boolean().optional(),
  checklist: z.array(checklistItemSchema).max(200).optional(),
});

function hasOwn(input: object, key: string) {
  return Object.prototype.hasOwnProperty.call(input, key);
}

function denied(error: unknown) {
  if (error instanceof AccessDeniedError) return apiError(403, "ACCESS_DENIED", error.message);
  throw error;
}

export async function PATCH(
  request: Request,
  context: { params: Promise<{ planId: string }> },
) {
  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return apiError(400, "INVALID_JSON", "Request body must be valid JSON");
  }

  const parsed = updateSchema.safeParse(body);
  if (!parsed.success) {
    return apiError(400, "INVALID_PAYLOAD", "Invalid maintenance plan update", parsed.error.flatten());
  }

  const changeFields = [
    "name",
    "description",
    "frequencyValue",
    "frequencyUnit",
    "nextDueAt",
    "nextDueMeterValue",
    "estimatedMinutes",
    "active",
    "checklist",
  ];
  if (!changeFields.some((field) => hasOwn(parsed.data, field))) {
    return apiError(400, "NO_CHANGES", "At least one maintenance plan field must change");
  }

  const auth = await authenticateRequest(request, parsed.data.organizationId);
  if ("error" in auth) return auth.error;

  try {
    assertSitePermission(auth.tenant.scope, parsed.data.siteId, "maintenance:manage");
  } catch (error) {
    return denied(error);
  }

  const { planId } = await context.params;
  const existing = await db.maintenancePlan.findFirst({
    where: {
      id: planId,
      asset: {
        siteId: parsed.data.siteId,
        site: { organizationId: parsed.data.organizationId, active: true, organization: { active: true } },
      },
    },
    include: {
      checklistItems: { orderBy: { sequence: "asc" } },
      meter: { select: { id: true, code: true, name: true, unit: true } },
      asset: { include: { site: { include: { organization: { select: { timezone: true } } } } } },
    },
  });
  if (!existing) return apiError(404, "PLAN_NOT_FOUND", "Maintenance plan not found in site scope");

  const currentMode = existing.frequencyUnit === "METER" ? "METER" : "CALENDAR";
  const requestedMode =
    parsed.data.frequencyUnit === undefined
      ? currentMode
      : parsed.data.frequencyUnit === "METER"
        ? "METER"
        : "CALENDAR";
  if (requestedMode !== currentMode) {
    return apiError(
      409,
      "RECURRENCE_MODE_IMMUTABLE",
      "Calendar and meter recurrence modes cannot be converted in-place; create a new plan",
    );
  }

  if (currentMode === "METER") {
    if (hasOwn(parsed.data, "nextDueAt")) {
      return apiError(400, "INVALID_METER_PLAN_UPDATE", "nextDueAt is not valid for meter plans");
    }
    if (hasOwn(parsed.data, "nextDueMeterValue") && parsed.data.nextDueMeterValue === null) {
      return apiError(400, "INVALID_METER_PLAN_UPDATE", "Meter plans require a nextDueMeterValue");
    }
  } else if (hasOwn(parsed.data, "nextDueMeterValue")) {
    return apiError(400, "INVALID_CALENDAR_PLAN_UPDATE", "nextDueMeterValue is only valid for meter plans");
  }

  const updated = await db.$transaction(async (tx) => {
    if (parsed.data.checklist) {
      await tx.maintenancePlanCheckItem.deleteMany({ where: { maintenancePlanId: existing.id } });
      if (parsed.data.checklist.length) {
        await tx.maintenancePlanCheckItem.createMany({
          data: parsed.data.checklist.map((item, index) => ({
            maintenancePlanId: existing.id,
            sequence: index + 1,
            label: item.label,
            mandatory: item.mandatory,
          })),
        });
      }
    }

    const plan = await tx.maintenancePlan.update({
      where: { id: existing.id },
      data: {
        ...(parsed.data.name !== undefined ? { name: parsed.data.name } : {}),
        ...(hasOwn(parsed.data, "description") ? { description: parsed.data.description ?? null } : {}),
        ...(parsed.data.frequencyValue !== undefined
          ? { frequencyValue: parsed.data.frequencyValue }
          : {}),
        ...(parsed.data.frequencyUnit !== undefined
          ? { frequencyUnit: parsed.data.frequencyUnit }
          : {}),
        ...(hasOwn(parsed.data, "nextDueAt") ? { nextDueAt: parsed.data.nextDueAt ?? null } : {}),
        ...(hasOwn(parsed.data, "nextDueMeterValue")
          ? { nextDueMeterValue: parsed.data.nextDueMeterValue ?? null }
          : {}),
        ...(hasOwn(parsed.data, "estimatedMinutes")
          ? { estimatedMinutes: parsed.data.estimatedMinutes ?? null }
          : {}),
        ...(parsed.data.active !== undefined ? { active: parsed.data.active } : {}),
      },
      include: {
        meter: { select: { id: true, code: true, name: true, unit: true } },
        checklistItems: { orderBy: { sequence: "asc" } },
      },
    });

    const action =
      parsed.data.active === false && existing.active
        ? "PAUSED"
        : parsed.data.active === true && !existing.active
          ? "RESUMED"
          : "UPDATED";
    await tx.auditLog.create({
      data: {
        actorId: auth.session.user.id,
        entityType: "MaintenancePlan",
        entityId: existing.id,
        action,
        beforeJson: JSON.stringify(existing),
        afterJson: JSON.stringify(plan),
      },
    });
    return plan;
  });

  const followingDueAt =
    updated.frequencyUnit !== "METER" && updated.nextDueAt
      ? advanceCalendarDue({
          currentDueAt: updated.nextDueAt,
          frequencyValue: updated.frequencyValue,
          frequencyUnit: updated.frequencyUnit as CalendarFrequencyUnit,
          timeZone: existing.asset.site.organization.timezone,
        })
      : null;
  const followingDueMeterValue =
    updated.frequencyUnit === "METER" && updated.nextDueMeterValue !== null
      ? updated.nextDueMeterValue + updated.frequencyValue
      : null;

  return apiData({ ...updated, followingDueAt, followingDueMeterValue });
}
