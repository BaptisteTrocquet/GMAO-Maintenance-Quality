import Link from "next/link";
import { headers } from "next/headers";
import { notFound } from "next/navigation";
import { getQualityEvent } from "@/lib/quality/events";
import {
  getQualityRca,
  listQualityRcaTimeline,
  type IshikawaCategory,
} from "@/lib/quality/root-cause";

const categories: Array<{ key: IshikawaCategory; label: string }> = [
  { key: "PEOPLE", label: "People" },
  { key: "MACHINE", label: "Machine" },
  { key: "METHOD", label: "Method" },
  { key: "MATERIAL", label: "Material" },
  { key: "MEASUREMENT", label: "Measurement" },
  { key: "ENVIRONMENT", label: "Environment" },
];

function formatDate(value: string | Date | null | undefined) {
  if (!value) return "—";
  const iso = value instanceof Date ? value.toISOString() : value;
  return `${iso.replace("T", " ").slice(0, 16)} UTC`;
}

export default async function RootCauseWorkspacePage({
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
        <p>Select an organization and site to view root-cause analysis.</p>
      </section>
    );
  }

  const qualityEvent = await getQualityEvent({ organizationId, siteId, eventId });
  if (!qualityEvent) notFound();
  const rca = await getQualityRca({ organizationId, siteId, eventId });
  const timeline = rca
    ? ((await listQualityRcaTimeline({ organizationId, siteId, eventId })) ?? [])
    : [];
  const selected = new Set(
    rca?.rootCauses.map((reference) => `${reference.source}:${reference.refId}`) ?? [],
  );

  return (
    <>
      <div className="header asset-header">
        <div>
          <Link className="muted" href={`/quality/${eventId}`}>← {qualityEvent.eventNumber}</Link>
          <div className="title">Root-cause analysis</div>
          <div className="muted">{qualityEvent.title}</div>
        </div>
        <div className="asset-status">
          <span className="badge">EVENT {qualityEvent.status}</span>
          <span className="badge">RCA {rca?.status ?? "NOT STARTED"}</span>
        </div>
      </div>

      {!rca ? (
        <section className="card">
          <h2>RCA workspace</h2>
          <p className="muted">
            No root-cause analysis has been saved yet. The API accepts structured 5 Why and Ishikawa data once containment or investigation has started.
          </p>
        </section>
      ) : (
        <>
          <section className="card">
            <h2>Problem statement</h2>
            <p>{rca.problemStatement || "No problem statement recorded."}</p>
            <dl className="detail-list">
              <div><dt>Status</dt><dd>{rca.status}</dd></div>
              <div><dt>Updated</dt><dd>{formatDate(rca.updatedAt)}</dd></div>
              <div><dt>Finalized</dt><dd>{formatDate(rca.finalizedAt)}</dd></div>
            </dl>
          </section>

          <div className="grid grid-2 section">
            <section className="card responsive-table">
              <h2>5 Why</h2>
              {rca.fiveWhys.length ? (
                <table className="table">
                  <thead><tr><th>Level</th><th>Answer</th><th>Root cause</th></tr></thead>
                  <tbody>
                    {rca.fiveWhys.map((step) => (
                      <tr key={step.id}>
                        <td>Why {step.sequence}</td>
                        <td>{step.answer}</td>
                        <td>{selected.has(`FIVE_WHY:${step.id}`) ? "✓" : "—"}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              ) : <p className="muted">No 5 Why steps recorded.</p>}
            </section>

            <section className="card">
              <h2>Ishikawa</h2>
              <div className="stack-list">
                {categories.map(({ key, label }) => {
                  const causes = rca.ishikawaCauses.filter((cause) => cause.category === key);
                  return (
                    <div key={key}>
                      <strong>{label}</strong>
                      {causes.length ? (
                        <ul>
                          {causes.map((cause) => (
                            <li key={cause.id}>
                              {selected.has(`ISHIKAWA:${cause.id}`) ? "✓ " : ""}{cause.statement}
                            </li>
                          ))}
                        </ul>
                      ) : <span className="muted"> · No causes</span>}
                    </div>
                  );
                })}
              </div>
            </section>
          </div>

          <section className="card section">
            <h2>Selected root causes</h2>
            {rca.rootCauses.length ? (
              <div className="stack-list">
                {rca.rootCauses.map((reference) => {
                  const label = reference.source === "FIVE_WHY"
                    ? rca.fiveWhys.find((step) => step.id === reference.refId)?.answer
                    : rca.ishikawaCauses.find((cause) => cause.id === reference.refId)?.statement;
                  return <div key={`${reference.source}:${reference.refId}`}><strong>{reference.source}</strong> · {label ?? reference.refId}</div>;
                })}
              </div>
            ) : <p className="muted">No analyzed cause has been selected as a root cause.</p>}
          </section>

          <section className="card section">
            <h2>RCA audit timeline</h2>
            {timeline.length ? (
              <ol className="timeline">
                {timeline.map((entry) => (
                  <li key={entry.id}>
                    <time>{formatDate(entry.createdAt)}</time>
                    <strong>{entry.action}</strong>
                    <span>{entry.actorName}</span>
                  </li>
                ))}
              </ol>
            ) : <p className="muted">No RCA activity recorded.</p>}
          </section>
        </>
      )}
    </>
  );
}
