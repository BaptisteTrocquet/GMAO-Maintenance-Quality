import { db } from "@/lib/db";

const CAPA_ENTITY = "QualityCapa";
const EFFECTIVENESS_ENTITY = "QualityCapaEffectiveness";

export class CapaClosureError extends Error {
  constructor(
    public readonly code: "CAPA_INCOMPLETE",
    message: string,
  ) {
    super(message);
    this.name = "CapaClosureError";
  }
}

function scopedSnapshot(
  value: string | null,
  input: { organizationId: string; siteId: string },
) {
  if (!value) return null;
  try {
    const parsed = JSON.parse(value) as {
      organizationId?: unknown;
      siteId?: unknown;
      status?: unknown;
      result?: unknown;
    };
    if (
      parsed.organizationId !== input.organizationId ||
      parsed.siteId !== input.siteId
    ) {
      return null;
    }
    return parsed;
  } catch {
    return null;
  }
}

export async function assertEffectiveCapaForEvent(input: {
  organizationId: string;
  siteId: string;
  eventId: string;
}) {
  const capaLog = await db.auditLog.findFirst({
    where: { entityType: CAPA_ENTITY, entityId: input.eventId },
    orderBy: { createdAt: "desc" },
    select: { afterJson: true },
  });
  if (!capaLog) return;

  const capa = scopedSnapshot(capaLog.afterJson, input);
  // Keep cross-tenant event IDs opaque. The normal quality-event transition
  // remains responsible for returning the scoped not-found result.
  if (!capa) return;
  if (capa.status !== "READY_FOR_EFFECTIVENESS") {
    throw new CapaClosureError(
      "CAPA_INCOMPLETE",
      "Quality event cannot close while its CAPA actions are incomplete",
    );
  }

  const effectivenessLog = await db.auditLog.findFirst({
    where: { entityType: EFFECTIVENESS_ENTITY, entityId: input.eventId },
    orderBy: { createdAt: "desc" },
    select: { afterJson: true },
  });
  const effectiveness = scopedSnapshot(effectivenessLog?.afterJson ?? null, input);
  if (
    !effectiveness ||
    effectiveness.status !== "VERIFIED" ||
    effectiveness.result !== "EFFECTIVE"
  ) {
    throw new CapaClosureError(
      "CAPA_INCOMPLETE",
      "Quality event cannot close until CAPA effectiveness is verified as effective",
    );
  }
}
