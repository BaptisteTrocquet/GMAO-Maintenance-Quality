import Link from "next/link";
import { headers } from "next/headers";
import { notFound } from "next/navigation";
import { getQualityEvent } from "@/lib/quality/events";
import { getRootCauseAnalysis, listRootCauseTimeline } from "@/lib/quality/root-cause";
import { RootCauseWorkspace } from "./root-cause-workspace";

function formatDate(value: string | Date | null | undefined) {
  if (!value) return "—";
  const iso = value instanceof Date ? value.toISOString() : value;
  return `${iso.replace("T", " ").slice(0, 16)} UTC`;
}

export default async function RootCausePage({
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
        <p>Select an organization and site to use root-cause analysis.</p>
      </section>
    );
  }

  const qualityEvent = await getQualityEvent({ organizationId, siteId, eventId });
  if (!qualityEvent) notFound();

  const [analysis, timeline] = await Promise.all([
    getRootCauseAnalysis({ organizationId, siteId, eventId }),
    listRootCauseTimeline({ organizationId, siteId, eventId }),
  ]);

  return (
    <>
      <div className="header asset-header">
        <div>
          <Link className="muted" href={`/quality/${eventId}`}>← {qualityEvent.eventNumber}</Link>
          <div className="title">Root-cause workspace · {qualityEvent.title}</div>
          <div className="muted">
            5 Why analysis is editable only while the quality event is INVESTIGATING.
          </div>
        </div>
        <div className="asset-status">
          <span className="badge">{qualityEvent.status}</span>
          <span className="badge">{analysis?.status ?? "NOT STARTED"}</span>
        </div>
      </div>

      <RootCauseWorkspace
        organizationId={organizationId}
        siteId={siteId}
        eventId={eventId}
        initialAnalysis={analysis}
      />

      <section className="card section">
        <h2>Root-cause audit trail</h2>
        {timeline.length ? (
          <ol className="timeline">
            {timeline.map((entry) => (
              <li key={entry.id}>
                <time>{formatDate(entry.createdAt)}</time>
                <strong>{entry.action}</strong>
                <span>
                  {entry.actorName}
                  {entry.after ? ` · v${entry.after.version} · ${entry.after.status}` : ""}
                </span>
              </li>
            ))}
          </ol>
        ) : (
          <p className="muted">No root-cause analysis activity recorded yet.</p>
        )}
      </section>
    </>
  );
}
