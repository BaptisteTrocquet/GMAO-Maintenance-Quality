import Link from "next/link";
import { headers } from "next/headers";
import { listPurchaseRequests } from "@/lib/inventory/purchase-requests";

function formatDate(value: string | null) {
  if (!value) return "—";
  return new Date(value).toISOString().slice(0, 10);
}

function estimatedTotal(lines: Awaited<ReturnType<typeof listPurchaseRequests>>[number]["lines"]) {
  return lines.reduce((sum, line) => sum + (line.unitCost ?? 0) * line.quantity, 0);
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
            <div className="muted">Select an organization and site to review purchasing demand.</div>
          </div>
        </div>
        <div className="card">A site context is required.</div>
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
          <div className="muted">
            Draft, submit and approve replenishment requests with supplier references frozen into each snapshot.
          </div>
        </div>
      </div>

      {requests.length === 0 ? (
        <div className="card">
          <strong>No purchase requests for the selected site.</strong>
          <p className="muted">Create a draft through the inventory API or from a reorder workflow.</p>
        </div>
      ) : (
        <div className="grid">
          {requests.map((purchaseRequest) => {
            const total = estimatedTotal(purchaseRequest.lines);
            return (
              <section className="card" key={purchaseRequest.id}>
                <div className="header">
                  <div>
                    <strong>{purchaseRequest.requestNumber}</strong>
                    <div className="muted">Updated {formatDate(purchaseRequest.updatedAt)}</div>
                  </div>
                  <span className="badge">{purchaseRequest.status}</span>
                </div>

                <dl className="detail-list">
                  <div><dt>Reason</dt><dd>{purchaseRequest.reason ?? "—"}</dd></div>
                  <div><dt>Needed by</dt><dd>{formatDate(purchaseRequest.neededBy)}</dd></div>
                  <div><dt>Estimated total</dt><dd>{total.toFixed(2)} EUR</dd></div>
                  <div><dt>Lines</dt><dd>{purchaseRequest.lines.length}</dd></div>
                </dl>

                <div className="responsive-table">
                  <table className="table">
                    <thead>
                      <tr>
                        <th>Part</th>
                        <th>Qty</th>
                        <th>Supplier</th>
                        <th>Supplier ref.</th>
                        <th>Unit cost</th>
                      </tr>
                    </thead>
                    <tbody>
                      {purchaseRequest.lines.map((line) => (
                        <tr key={line.id}>
                          <td>{line.sku} · {line.partName}</td>
                          <td>{line.quantity} {line.unit}</td>
                          <td>{line.supplierCode ? `${line.supplierCode} · ${line.supplierName}` : "Unassigned"}</td>
                          <td>{line.supplierPartNumber ?? "—"}</td>
                          <td>{line.unitCost === null ? "—" : `${line.unitCost.toFixed(2)} ${line.currency}`}</td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>

                {purchaseRequest.decisionNote ? (
                  <p className="muted">Decision note: {purchaseRequest.decisionNote}</p>
                ) : null}
              </section>
            );
          })}
        </div>
      )}
    </>
  );
}
