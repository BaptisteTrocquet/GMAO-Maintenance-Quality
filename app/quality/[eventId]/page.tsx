import Link from "next/link";
import { headers } from "next/headers";
import { notFound } from "next/navigation";
import { db } from "@/lib/db";
import { getQualityEvent, listQualityEventTimeline } from "@/lib/quality/events";
import {
  getRootCauseWorkspace,
  listRootCauseTimeline,
  type IshikawaCategory,
} from "@/lib/quality/root-cause";

type QualityTimeline = NonNullable<Awaited<ReturnType<typeof listQualityEventTimeline>>>;
type QualityTimelineEntry = QualityTimeline[number];

const ishikawaCategories: Array<{ key: IshikawaCategory; label: string }> = [
  { key: "PEOPLE", label: "People" },
  { key: "METHOD", label: "Method" },
  { key: "MACHINE", label: "Machine" },
  { key: "MATERIAL", label: "Material" },
  { key: "MEASUREMENT", label: "Measurement" },
  { key: "ENVIRONMENT", label: "Environment" },
];

function formatDate(value: string | Date | null | undefined) {
  if (!value) return "—";
  const iso = value instanceof Date ? value.toISOString() : value;
  return `${iso.replace("T", " ").slice(0, 16)} UTC`;
}

function timelineDetail(entry: QualityTimelineEntry) {
  const after = entry.after;
  if (!after) return "";
  if (entry.action === "CONTAINMENT_RECORDED" || entry.action === "CONTAINMENT_UPDATED") {
    return after.containment?.summary ?? "";
  }
  if (entry.action === "CLOSED") return after.resolutionSummary ?? "";
  return after.title;
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

  const [timeline, rootCauseWorkspace, rootCauseTimeline] = await Promise.all([
    listQualityEventTimeline({ organizationId, siteId, eventId }),
    getRootCauseWorkspace({ organizationId, siteId, eventId }),
    listRootCauseTimeline({ organizationId, siteId, eventId }),
  ]);
  const qualityTimeline = timeline ?? [];
  const rootCause = rootCauseWorkspace?.rootCause ?? null;
  const rootCauseAudit = rootCauseTimeline ?? [];

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
          <h2>Linked context</h2>
          <dl className="detail-list">
            <div>
              <dt>Asset</dt>
              <dd>{qualityEvent.asset ? `${qualityEvent.asset.code} · ${qualityEvent.asset.name}` : "—"}</dd>
            </div>
            <div>
              <dt>Work order</dt>
              <dd>{qualityEvent.workOrder ? `${qualityEvent.workOrder.number} · ${qualityEvent.workOrder.title}` : "—"}</dd>
            </div>
            <div>
              <dt>Documents</dt>
              <dd>
                {qualityEvent.documents.length
                  ? qualityEvent.documents.map((document) => `${document.code} · ${document.title}`).join(", ")
                  : "—"}
              </dd>
            </div>
          </dl>
          <p className="muted">These labels are frozen in the quality-event snapshot for historical stability.</p>
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
                <div><dt>Due</dt><dd>{formatDate(qualityEvent.containment.dueAt)}</dd></div>
                <div><dt>Completed</dt><dd>{formatDate(qualityEvent.containment.completedAt)}</dd></div>
              </dl>
            </>
          ) : (
            <p className="muted">Immediate containment has not been recorded.</p>
          )}
        </section>

        <section className="card">
          <h2>Resolution</h2>
          <p>{qualityEvent.resolutionSummary ?? "Investigation or resolution is not complete."}</p>
          <dl className="detail-list">
            <div><dt>Closed</dt><dd>{formatDate(qualityEvent.closedAt)}</dd></div>
          </dl>
        </section>
      </div>

      <section className="card section">
        <div className="header asset-header">
          <div>
            <h2>Root-cause analysis</h2>
            <div className="muted">Structured 5 Why and Ishikawa investigation workspace.</div>
          </div>
          <div className="asset-status">
            {rootCause ? (
              <>
                <span className="badge">{rootCause.method}</span>
                <span className="badge">{rootCause.status}</span>
              </>
            ) : null}
            <Link className="table-link" href={`/quality/${eventId}/root-cause`}>
              Open workspace →
            </Link>
          </div>
        </div>

        {rootCause ? (
          <>
            <h3>Problem statement</h3>
            <p>{rootCause.problemStatement}</p>

            {rootCause.fiveWhys.length ? (
              <div className="responsive-table section">
                <h3>5 Why</h3>
                <table className="table">
                  <thead>
                    <tr><th>Step</th><th>Question</th><th>Answer</th></tr>
                  </thead>
                  <tbody>
                    {rootCause.fiveWhys.map((step) => (
                      <tr key={step.sequence}>
                        <td>{step.sequence}</td>
                        <td>{step.prompt}</td>
                        <td>{step.answer}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            ) : null}

            {rootCause.ishikawa.length ? (
              <div className="section">
                <h3>Ishikawa</h3>
                <div className="grid grid-2">
                  {ishikawaCategories.map((category) => {
                    const causes = rootCause.ishikawa.filter(
                      (cause) => cause.category === category.key,
                    );
                    if (!causes.length) return null;
                    return (
                      <section className="card" key={category.key}>
                        <strong>{category.label}</strong>
                        <div className="stack-list">
                          {causes.map((cause, index) => (
                            <div key={`${category.key}-${index}-${cause.cause}`}>
                              <span>{cause.cause}</span>
                              {cause.evidence ? <span className="muted"> · Evidence: {cause.evidence}</span> : null}
                            </div>
                          ))}
                        </div>
                      </section>
                    );
                  })}
                </div>
              </div>
            ) : null}

            <div className="section">
              <h3>Root-cause summary</h3>
              <p>{rootCause.rootCauseSummary ?? "Root cause has not been summarized yet."}</p>
              <div className="muted">
                Updated {formatDate(rootCause.updatedAt)}
                {rootCause.confirmedAt ? ` · Confirmed ${formatDate(rootCause.confirmedAt)}` : ""}
              </div>
            </div>
          </>
        ) : (
          <p className="muted">
            No root-cause workspace has been recorded. Start the event investigation before adding 5 Why or Ishikawa analysis.
          </p>
        )}
      </section>

      {rootCauseAudit.length ? (
        <section className="card section">
          <h2>Root-cause audit trail</h2>
          <ol className="timeline">
            {rootCauseAudit.map((entry) => (
              <li key={entry.id}>
                <time>{formatDate(entry.createdAt)}</time>
                <strong>{entry.action}</strong>
                <span>{entry.actorName}{entry.after?.rootCauseSummary ? ` · ${entry.after.rootCauseSummary}` : ""}</span>
              </li>
            ))}
          </ol>
        </section>
      ) : null}

      <section className="card section">
        <div className="header asset-header" style={{ marginBottom: 0 }}>
          <div>
            <h2 style={{ marginBottom: 6 }}>CAPA</h2>
            <div className="muted">Corrective and preventive actions, ownership, due dates and effectiveness verification.</div>
          </div>
          <Link className="table-link" href={`/quality/${eventId}/capa`}>
            Open CAPA workspace →
          </Link>
        </div>
      </section>

      <section className="card section">
        <h2>Quality event timeline</h2>
        {qualityTimeline.length ? (
          <ol className="timeline">
            {qualityTimeline.map((entry) => {
              const detail = timelineDetail(entry);
              return (
                <li key={entry.id}>
                  <time>{formatDate(entry.createdAt)}</time>
                  <strong>{entry.action}</strong>
                  <span>{entry.actorName}{detail ? ` · ${detail}` : ""}</span>
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
