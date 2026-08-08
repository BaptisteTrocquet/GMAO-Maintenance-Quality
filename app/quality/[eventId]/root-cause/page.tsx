import Link from "next/link";
import { headers } from "next/headers";
import { notFound } from "next/navigation";
import { getQualityEvent } from "@/lib/quality/events";
import { getRootCauseWorkspace, listRootCauseTimeline } from "@/lib/quality/root-cause";
import RootCauseWorkspace from "./root-cause-workspace";

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
        <p>Select an organization and site to open root-cause analysis.</p>
      </section>
    );
  }

  const [qualityEvent, workspace, timeline] = await Promise.all([
    getQualityEvent({ organizationId, siteId, eventId }),
    getRootCauseWorkspace({ organizationId, siteId, eventId }),
    listRootCauseTimeline({ organizationId, siteId, eventId }),
  ]);
  if (!qualityEvent || !workspace) notFound();

  return (
    <>
      <div className="header asset-header">
        <div>
          <Link className="muted" href={`/quality/${eventId}`}>← Quality event</Link>
          <div className="title">Root-cause analysis · {qualityEvent.eventNumber}</div>
          <div className="muted">{qualityEvent.title}</div>
        </div>
        <div className="asset-status">
          <span className="badge">{qualityEvent.status}</span>
          <span className="badge">{workspace.rootCause?.status ?? "NOT STARTED"}</span>
          {workspace.rootCause ? <span className="badge">{workspace.rootCause.method}</span> : null}
        </div>
      </div>

      <RootCauseWorkspace
        organizationId={organizationId}
        siteId={siteId}
        eventId={eventId}
        eventStatus={qualityEvent.status}
        initialRootCause={workspace.rootCause}
      />

      <section className="card section">
        <h2>Root-cause revision timeline</h2>
        {timeline?.length ? (
          <ol className="timeline">
            {timeline.map((entry) => (
              <li key={entry.id}>
                <time>{formatDate(entry.createdAt)}</time>
                <strong>{entry.action}</strong>
                <span>
                  {entry.actorName}
                  {entry.after?.rootCauseSummary ? ` · ${entry.after.rootCauseSummary}` : ""}
                </span>
              </li>
            ))}
          </ol>
        ) : (
          <p className="muted">No root-cause revisions recorded yet.</p>
        )}
      </section>
    </>
  );
}
