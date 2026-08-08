import { db } from "@/lib/db";

export class CapaClosureError extends Error {
  constructor(
    public readonly code: "CAPA_INCOMPLETE",
    message: string,
  ) {
    super(message);
    this.name = "CapaClosureError";
  }
}

export async function assertCapaClosedForEvent(input: {
  organizationId: string;
  siteId: string;
  eventId: string;
}) {
  const log = await db.auditLog.findFirst({
    where: { entityType: "QualityCapa", entityId: input.eventId },
    orderBy: { createdAt: "desc" },
    select: { afterJson: true },
  });
  if (!log?.afterJson) return;

  try {
    const snapshot = JSON.parse(log.afterJson) as {
      organizationId?: unknown;
      siteId?: unknown;
      status?: unknown;
    };
    if (
      snapshot.organizationId !== input.organizationId ||
      snapshot.siteId !== input.siteId
    ) {
      return;
    }
    if (snapshot.status !== "CLOSED") {
      throw new CapaClosureError(
        "CAPA_INCOMPLETE",
        "Quality event cannot close while its CAPA is incomplete",
      );
    }
  } catch (error) {
    if (error instanceof CapaClosureError) throw error;
    throw new CapaClosureError(
      "CAPA_INCOMPLETE",
      "Quality event cannot close because its CAPA state is invalid",
    );
  }
}
