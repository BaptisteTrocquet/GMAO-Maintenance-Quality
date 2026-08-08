import Link from "next/link";
import { headers } from "next/headers";
import { listPurchaseRequests } from "@/lib/inventory/purchase-requests";

function date(value: string | null) {
  return value ? new Date(value).toISOString().slice(0, 10) : "—";
}

export default async function PurchaseRequestsPage() {
  const requestHeaders = await headers();
  const organizationId = requestHeaders.get("x-organization-id") ?? "";
  const siteId = requestHeaders.get("x-site-id") ?? "";

  if (!organizationId || !siteId) {
    return (
      <>
        <div className="header">
          <div>
            <Link className="muted" href="/inventory">← Inventory</Link>
            <div className="title">Purchase requests</div>
            <div className="muted">Select an organization and site to continue.</div>
          </div>
        </div>
        <div className="card">Purchase requests are site-scoped.</div>
      </>
    );
  }

  const requests = await listPurchaseRequests({ organizationId, siteId });

  return (
    <>
      <div className="header">
        <div>
          <Link className="muted" href="/inventory">← Inventory</Link>
          <div className="title">Purchase requests</div>
          <div className="muted">Audited spare-parts replenishment workflow.</div>
        </div>
      </div>

      <div className="card responsive-table">
        <table className="table">
          <thead>
            <tr>
              <th>Request</th><th>Status</th><th>Reason</th><th>Needed by</th>
              <th>Lines</th><th>Supplier</th><th>Version</th>
            </tr>
          </thead>
          <tbody>
            {requests.map((request) => (
              <tr key={request.id}>
                <td>{request.requestNumber}</td>
                <td><span className="badge">{request.status}</span></td>
                <td>{request.reason ?? "—"}</td>
                <td>{date(request.neededBy)}</td>
                <td>{request.lines.map((line) => `${line.quantity} ${line.unit} × ${line.sku}`).join(", ")}</td>
                <td>{[...new Set(request.lines.map((line) => line.supplierName).filter(Boolean))].join(", ") || "Supplier TBD"}</td>
                <td>v{request.version}</td>
              </tr>
            ))}
          </tbody>
        </table>
        {requests.length === 0 ? <p className="muted">No purchase requests for this site.</p> : null}
      </div>
    </>
  );
}
