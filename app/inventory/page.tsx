import { headers } from "next/headers";
import { db } from "@/lib/db";

export default async function InventoryPage() {
  const requestHeaders = await headers();
  const organizationId = requestHeaders.get("x-organization-id") ?? "";
  const selectedSiteId = requestHeaders.get("x-site-id") ?? "";

  if (!organizationId) {
    return (
      <>
        <div className="header">
          <div>
            <div className="title">Inventory</div>
            <div className="muted">Spare parts, warehouses and equipment relationships.</div>
          </div>
        </div>
        <div className="card">
          <p>Select an organization to view inventory.</p>
        </div>
      </>
    );
  }

  const [parts, warehouses] = await Promise.all([
    db.part.findMany({
      where: { organizationId, active: true },
      include: {
        assetParts: {
          include: {
            asset: { select: { code: true, siteId: true } },
          },
        },
      },
      orderBy: { sku: "asc" },
    }),
    db.warehouse.findMany({
      where: {
        active: true,
        site: {
          organizationId,
          active: true,
          ...(selectedSiteId ? { id: selectedSiteId } : {}),
        },
      },
      include: {
        site: { select: { id: true, code: true, name: true } },
        bins: { where: { active: true }, orderBy: { code: "asc" } },
      },
      orderBy: [{ site: { code: "asc" } }, { code: "asc" }],
    }),
  ]);

  return (
    <>
      <div className="header">
        <div>
          <div className="title">Inventory</div>
          <div className="muted">Spare parts, warehouses and equipment relationships.</div>
        </div>
      </div>

      <div className="card responsive-table">
        <h2>Part master</h2>
        <table className="table">
          <thead>
            <tr>
              <th>SKU</th>
              <th>Part</th>
              <th>Stock</th>
              <th>Reorder point</th>
              <th>Assets</th>
            </tr>
          </thead>
          <tbody>
            {parts.map((part) => (
              <tr key={part.id}>
                <td>{part.sku}</td>
                <td>{part.name}</td>
                <td>{part.quantityOnHand} {part.unit}</td>
                <td>{part.reorderPoint}</td>
                <td>{part.assetParts.map((link) => link.asset.code).join(", ") || "—"}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>

      <div className="card">
        <h2>Warehouses & bins</h2>
        {warehouses.length === 0 ? (
          <p className="muted">No warehouse configured for the selected scope.</p>
        ) : (
          <div className="grid">
            {warehouses.map((warehouse) => (
              <section className="card" key={warehouse.id}>
                <strong>{warehouse.code} — {warehouse.name}</strong>
                <div className="muted">{warehouse.site.code} · {warehouse.site.name}</div>
                <div>{warehouse.bins.map((bin) => `${bin.code} — ${bin.name}`).join(", ") || "No bins"}</div>
              </section>
            ))}
          </div>
        )}
      </div>
    </>
  );
}
