import Link from "next/link";
import { headers } from "next/headers";
import { notFound } from "next/navigation";
import { getQualityEvent } from "@/lib/quality/events";
import { listQualityEvidence } from "@/lib/quality/evidence";
import EvidenceWorkspace from "./evidence-workspace";

function formatBytes(value: number) {
  if (value < 1024) return `${value} B`;
  if (value < 1024 * 1024) return `${(value / 1024).toFixed(1)} KiB`;
  return `${(value / (1024 * 1024)).toFixed(1)} MiB`;
}

function formatDate(value: string) {
  return `${value.replace("T", " ").slice(0, 16)} UTC`;
}

export default async function QualityEvidencePage({
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
        <p>Select an organization and site to view quality evidence.</p>
      </section>
    );
  }

  const [qualityEvent, evidence] = await Promise.all([
    getQualityEvent({ organizationId, siteId, eventId }),
    listQualityEvidence({ organizationId, siteId, eventId }),
  ]);
  if (!qualityEvent) notFound();

  return (
    <>
      <div className="header asset-header">
        <div>
          <Link className="muted" href={`/quality/${eventId}`}>← Quality event</Link>
          <div className="title">Evidence · {qualityEvent.eventNumber}</div>
          <div className="muted">Immutable files supporting containment, RCA, CAPA and effectiveness decisions.</div>
        </div>
        <div className="asset-status">
          <span className="badge">{qualityEvent.status}</span>
          <span className="badge">{evidence.length} FILE{evidence.length === 1 ? "" : "S"}</span>
        </div>
      </div>

      <EvidenceWorkspace
        organizationId={organizationId}
        siteId={siteId}
        eventId={eventId}
        eventStatus={qualityEvent.status}
      />

      <section className="card responsive-table section">
        <h2>Evidence register</h2>
        {evidence.length ? (
          <table className="table">
            <thead>
              <tr>
                <th>File</th>
                <th>Kind</th>
                <th>Uploaded</th>
                <th>Size</th>
                <th>SHA-256</th>
              </tr>
            </thead>
            <tbody>
              {evidence.map((item) => (
                <tr key={item.id}>
                  <td>
                    <Link
                      className="table-link"
                      href={`/api/quality/events/${eventId}/evidence/${item.id}?organizationId=${encodeURIComponent(organizationId)}&siteId=${encodeURIComponent(siteId)}`}
                    >
                      {item.fileName}
                    </Link>
                    {item.description ? <div className="muted">{item.description}</div> : null}
                  </td>
                  <td>{item.kind}</td>
                  <td>{formatDate(item.createdAt)} · {item.uploaderName}</td>
                  <td>{formatBytes(item.sizeBytes)}</td>
                  <td><code title={item.checksumSha256}>{item.checksumSha256.slice(0, 12)}…</code></td>
                </tr>
              ))}
            </tbody>
          </table>
        ) : (
          <p className="muted">No evidence files have been attached yet.</p>
        )}
      </section>
    </>
  );
}
