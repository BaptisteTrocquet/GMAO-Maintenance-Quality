import Link from "next/link";
import { headers } from "next/headers";
import { listQualityEvents } from "@/lib/quality/events";

function formatDate(value: string | null | undefined) {
  return value ? value.replace("T", " ").slice(0, 16) : "—";
}

export default async function QualityPage() {
  const requestHeaders = await headers();
  const organizationId = requestHeaders.get("x-organization-id") ?? "";
  const siteId = requestHeaders.get("x-site-id") ?? "";

  if (!organizationId || !siteId) {
    return (
      <>
        <div className="header">
          <div>
            <div className="title">Quality</div>
            <div className="muted">Nonconformities, containment and investigation workflows.</div>
          </div>
        </div>
        <section className="card">
          <p>Select an organization and site to view quality events.</p>
        </section>
      </>
    );
  }

  const events = await listQualityEvents({ organizationId, siteId });
  const counts = {
    OPEN: events.filter((event) => event.status === "OPEN").length,
    CONTAINED: events.filter((event) => event.status === "CONTAINED").length,
    INVESTIGATING: events.filter((event) => event.status === "INVESTIGATING").length,
    CLOSED: events.filter((event) => event.status === "CLOSED").length,
  };

  return (
    <>
      <div className="header">
        <div>
          <div className="title">Quality</div>
          <div className="muted">
            Nonconformities, immediate containment, RCA, CAPA and 8D for the selected site.
          </div>
        </div>
      </div>

      <div className="grid asset-summary-grid">
        <section className="card"><div className="muted">Open</div><div className="title">{counts.OPEN}</div></section>
        <section className="card"><div className="muted">Contained</div><div className="title">{counts.CONTAINED}</div></section>
        <section className="card"><div className="muted">Investigating</div><div className="title">{counts.INVESTIGATING}</div></section>
        <section className="card"><div className="muted">Closed</div><div className="title">{counts.CLOSED}</div></section>
      </div>

      <section className="card responsive-table section">
        <h2>Quality events</h2>
        {events.length === 0 ? (
          <p className="muted">No quality events recorded for the selected site.</p>
        ) : (
          <table className="table">
            <thead>
              <tr>
                <th>Event</th>
                <th>Type</th>
                <th>Title</th>
                <th>Severity</th>
                <th>Status</th>
                <th>Asset</th>
                <th>Work order</th>
                <th>Detected</th>
                <th>Containment due</th>
                <th>8D</th>
                <th>Evidence</th>
              </tr>
            </thead>
            <tbody>
              {events.map((event) => (
                <tr key={event.id}>
                  <td><Link href={`/quality/${event.id}`}>{event.eventNumber}</Link></td>
                  <td>{event.type}</td>
                  <td>{event.title}</td>
                  <td><span className="badge">{event.severity}</span></td>
                  <td><span className="badge">{event.status}</span></td>
                  <td>{event.asset?.code ?? "—"}</td>
                  <td>{event.workOrder?.number ?? "—"}</td>
                  <td>{formatDate(event.detectedAt)}</td>
                  <td>{formatDate(event.containment?.dueAt)}</td>
                  <td><Link className="table-link" href={`/quality/${event.id}/8d`}>Open 8D →</Link></td>
                  <td><Link className="table-link" href={`/quality/${event.id}/evidence`}>Evidence →</Link></td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </section>
    </>
  );
}
