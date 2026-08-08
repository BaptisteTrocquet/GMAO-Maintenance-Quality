import Link from "next/link";
import { headers } from "next/headers";
import { listPurchaseRequests } from "@/lib/inventory/purchase-requests";

function formatDate(value: string | null | undefined) {
  if (!value) return "—";
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? "—" : date.toISOString().slice(0, 10);
}

function estimatedValue(lines: Awaited<ReturnType<typeof listPurchaseRequests>>[number]["lines"]) {
  const totals = new Map<string, number>();
  for (const line of lines) {
    if (line.unitCost === null) continue;
    totals.set(line.currency, (totals.get(line.currency) ?? 0) + line.quantity * line.unitCost);
  }
  if (totals.size === 0) return "—";
  return [...totals.entries()]
    .map(([currency, value]) => `${value.toFixed(2)} ${currency}`)
    .join(" + ");
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
            <div className="muted">Select an organization and site to view purchase requests.</div>
          </div>
        </div>
        <div className="card">A site context is required.</div>
      </>
    );
  }

  const purchaseRequests = await listPurchaseRequests({ organizationId, siteId });

  return (
    <>
      <div className="header">
        <div>
          <Link className="muted" href="/inventory">← Inventory</Link>
          <div className="title">Purchase requests</div>
          <div className="muted">
            Draft, submit and approve replenishment requests for the selected site.
          </div>
        </div>
      </div>

      <div className="card responsive-table">
        {purchaseRequests.length === 0 ? (
          <p className="muted">No purchase requests for the selected site.</p>
        ) : (
          <table className="table">
            <thead>
              <tr>
                <th>Request</th>
                <th>Status</th>
                <th>Needed by</th>
                <th>Reason</th>
                <th>Lines</th>
                <th>Suppliers</th>
                <th>Estimated value</th>
                <th>Updated</th>
              </tr>
            </thead>
            <tbody>
              {purchaseRequests.map((purchaseRequest) => {
                const suppliers = [
                  ...new Set(
                    purchaseRequest.lines
                      .map((line) => line.supplierName)
                      .filter((name): name is string => Boolean(name)),
                  ),
                ];
                return (
                  <tr key={purchaseRequest.id}>
                    <td><strong>{purchaseRequest.requestNumber}</strong></td>
                    <td><span className="badge">{purchaseRequest.status}</span></td>
                    <td>{formatDate(purchaseRequest.neededBy)}</td>
                    <td>{purchaseRequest.reason ?? "—"}</td>
                    <td>{purchaseRequest.lines.length}</td>
                    <td>{suppliers.join(", ") || "Unassigned"}</td>
                    <td>{estimatedValue(purchaseRequest.lines)}</td>
                    <td>{formatDate(purchaseRequest.updatedAt)}</td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        )}
      </div>
    </>
  );
}
