import { headers } from "next/headers";
import { listCycleCounts } from "@/lib/inventory/cycle-counts";

export default async function CycleCountsPage() {
  const requestHeaders = await headers();
  const organizationId = requestHeaders.get("x-organization-id") ?? "";
  const siteId = requestHeaders.get("x-site-id") ?? "";

  if (!organizationId || !siteId) {
    return (
      <>
        <div className="header">
          <div>
            <div className="title">Cycle counts</div>
            <div className="muted">Select an organization and site to view stock counts.</div>
          </div>
        </div>
        <div className="card">A site scope is required.</div>
      </>
    );
  }

  const counts = await listCycleCounts({ organizationId, siteId, includeClosed: true });

  return (
    <>
      <div className="header">
        <div>
          <div className="title">Cycle counts</div>
          <div className="muted">
            Count snapshots never adjust stock until explicit completion. Stale snapshots are rejected.
          </div>
        </div>
      </div>

      <div className="card responsive-table">
        {counts.length === 0 ? (
          <p className="muted">No cycle counts recorded for this site.</p>
        ) : (
          <table className="table">
            <thead>
              <tr>
                <th>Status</th>
                <th>Location</th>
                <th>Progress</th>
                <th>Variance lines</th>
                <th>Updated</th>
              </tr>
            </thead>
            <tbody>
              {counts.map((count) => {
                const counted = count.items.filter((item) => item.countedQuantity !== null).length;
                const varianceLines = count.items.filter(
                  (item) =>
                    item.countedQuantity !== null &&
                    item.countedQuantity !== item.expectedQuantity,
                ).length;
                return (
                  <tr key={count.id}>
                    <td><span className="badge">{count.status}</span></td>
                    <td>{count.warehouseCode}/{count.binCode}</td>
                    <td>{counted}/{count.items.length}</td>
                    <td>{varianceLines}</td>
                    <td>{count.updatedAt.replace("T", " ").slice(0, 16)} UTC</td>
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
