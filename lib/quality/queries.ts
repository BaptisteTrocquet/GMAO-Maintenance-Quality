import { db } from "@/lib/db";
import {
  getQualityEvent,
  type QualityEventStatus,
  type QualityEventType,
  type QualitySeverity,
} from "@/lib/quality/events";

export async function queryQualityEvents(input: {
  organizationId: string;
  siteId: string;
  status?: QualityEventStatus;
  type?: QualityEventType;
  severity?: QualitySeverity;
}) {
  const ids = await db.auditLog.findMany({
    where: { entityType: "QualityEvent" },
    distinct: ["entityId"],
    select: { entityId: true },
  });

  const events = await Promise.all(
    ids.map(({ entityId }) =>
      getQualityEvent({
        organizationId: input.organizationId,
        siteId: input.siteId,
        eventId: entityId,
      }),
    ),
  );

  return events
    .filter((event): event is NonNullable<typeof event> => Boolean(event))
    .filter((event) => !input.status || event.status === input.status)
    .filter((event) => !input.type || event.type === input.type)
    .filter((event) => !input.severity || event.severity === input.severity)
    .sort((left, right) => right.updatedAt.localeCompare(left.updatedAt));
}
