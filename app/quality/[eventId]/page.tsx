import Link from "next/link";
import { headers } from "next/headers";
import { notFound } from "next/navigation";
import { db } from "@/lib/db";
import { getQualityEvent, listQualityEventTimeline } from "@/lib/quality/events";

function formatDate(value: string | Date | null | undefined) {
  if (!value) return "—";
  const iso = value instanceof Date ? value.toISOString() : value;
  return `${iso.replace("T", " ").slice(0, 16)} UTC`;
}

function eventDetail(afterJson: string | null) {
  if (!afterJson) return "";
  try {
    const value = JSON.parse(afterJson) as Record<string, unknown>;
    const containment = value.containment as Record<string, unknown> | null | undefined;
    if (containment && typeof containment.summary === "string") return containment.summary;
    if (typeof value.title === "string") return value.title;
  } catch {
    return "";
  }
  return "";
}

export default async function QualityEventDetailPage({
  params,
}: {
  params: Promise<{ eventId: string }>;
}) {
  const { eventId } = await params;
  const requestHeaders = await headers();
  const organizationId = requestHeaders.get("x-organization-id") ?? "";
  const siteId = requestHeaders.get("x-site-id") ?? "";

  if (!organizationId || !siteId) {
    return (
      <section className="card">
        <p>Select an organization and site to view this quality event.</p>
      </section>
    );
  }

  const qualityEvent = await getQualityEvent({ organizationId, siteId, eventId });
  if (!qualityEvent) notFound();
  const timeline = (await listQualityEventTimeline({ organizationId, siteId, eventId })) ?? [];

  const userIds = [qualityEvent.detectedById, qualityEvent.containment?.ownerId].filter(
    (value): value is string => Boolean(value),
  );
  const users = userIds.length
    ? await db.user.findMany({
        where: { id: { in: userIds } },
        select: { id: true, displayName: true },
      })
    : [];
  const userNames = new Map(users.map((user) => [user.id, user.displayName]));

  return (
    <>
      <div className="header asset-header">
        <div>
          <Link className="muted" href="/quality">← Quality</Link>
          <div className="title">{qualityEvent.eventNumber} · {qualityEvent.title}</div>
          <div className="muted">Detected {formatDate(qualityEvent.detectedAt)}</div>
        </div>
        <div className="asset-status">
          <span className="badge">{qualityEvent.type}</span>
          <span className="badge">{qualityEvent.severity}</span>
          <span className="badge">{qualityEvent.status}</span>
        </div>
      </div>

      <div className="grid grid-2">
        <section className="card">
          <h2>Event record</h2>
          <dl className="detail-list">
            <div><dt>Detected by</dt><dd>{userNames.get(qualityEvent.detectedById) ?? qualityEvent.detectedById}</dd></div>
            <div><dt>Occurred</dt><dd>{formatDate(qualityEvent.occurredAt)}</dd></div>
            <div><dt>Detected</dt><dd>{formatDate(qualityEvent.detectedAt)}</dd></div>
            <div><dt>Type</dt><dd>{qualityEvent.type}</dd></div>
            <div><dt>Severity</dt><dd>{qualityEvent.severity}</dd></div>
            <div><dt>Status</dt><dd>{qualityEvent.status}</dd></div>
          </dl>
          <h3>Description</h3>
          <p>{qualityEvent.description ?? "No description supplied."}</p>
        </section>

        <section className="card">
          <h2>Immediate containment</h2>
          {qualityEvent.containment ? (
            <>
              <p>{qualityEvent.containment.summary}</p>
              <dl className="detail-list">
                <div>
                  <dt>Owner</dt>
                  <dd>{userNames.get(qualityEvent.containment.ownerId) ?? qualityEvent.containment.ownerId}</dd>
                </div>
                <div><dt>Started</dt><dd>{formatDate(qualityEvent.containment.startedAt)}</dd></div>
                <div><dt>Due</dt><dd>{formatDate(qualityEvent.containment.dueAt)}</dd></div>
                <div><dt>Completed</dt><dd>{formatDate(qualityEvent.containment.completedAt)}</dd></div>
              </dl>
              {qualityEvent.containment.completionNote ? (
                <>
                  <h3>Completion note</h3>
                  <p>{qualityEvent.containment.completionNote}</p>
                </>
              ) : null}
            </>
          ) : (
            <p className="muted">Containment has not been started.</p>
          )}
        </section>
      </div>

      <section className="card section">
        <h2>Quality event timeline</h2>
        {timeline.length ? (
          <ol className="timeline">
            {timeline.map((entry) => {
              const detail = eventDetail(entry.afterJson);
              return (
                <li key={entry.id}>
                  <time>{formatDate(entry.createdAt)}</time>
                  <strong>{entry.action}</strong>
                  <span>{entry.actor?.displayName ?? "System"}{detail ? ` · ${detail}` : ""}</span>
                </li>
              );
            })}
          </ol>
        ) : (
          <p className="muted">No activity recorded.</p>
        )}
      </section>
    </>
  );
}
