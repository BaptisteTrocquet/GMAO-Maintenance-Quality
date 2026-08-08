import Link from "next/link";
import { headers } from "next/headers";
import { db } from "@/lib/db";
import { getReorderAlerts } from "@/lib/inventory/reorder";

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

  const [parts, warehouses, reorderAlerts] = await Promise.all([
    db.part.findMany({
      where: { organizationId, active: true },
      include: {
        assetParts: {
          include: {
            asset: { select: { code: true, siteId: true } },
          },
        },
        supplierReferences: {
          where: {
            active: true,
            supplier: { organizationId, active: true },
          },
          include: {
            supplier: { select: { id: true, code: true, name: true } },
          },
          orderBy: [{ preferred: "desc" }, { supplier: { name: "asc" } }],
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
    selectedSiteId
      ? getReorderAlerts({ organizationId, siteId: selectedSiteId })
      : Promise.resolve([]),
  ]);

  return (
    <>
      <div className="header">
        <div>
          <div className="title">Inventory</div>
          <div className="muted">Spare parts, warehouses and equipment relationships.</div>
          <div className="muted">
            <Link href="/inventory/purchase-requests">Purchase requests</Link>
            {" · "}
            <Link href="/inventory/cycle-counts">Cycle counts</Link>
          </div>
        </div>
      </div>

      <div className="card responsive-table">
        <h2>Part master</h2>
        <table className="table">
          <thead>
            <tr>
              <th>SKU</th>
              <th>Part</th>
              <th>Organization stock</th>
              <th>Legacy reorder point</th>
              <th>Preferred supplier</th>
              <th>Supplier reference</th>
              <th>Lead time / MOQ</th>
              <th>Assets</th>
            </tr>
          </thead>
          <tbody>
            {parts.map((part) => {
              const supplierReference =
                part.supplierReferences.find((reference) => reference.preferred) ??
                part.supplierReferences[0];
              return (
                <tr key={part.id}>
                  <td>{part.sku}</td>
                  <td>{part.name}</td>
                  <td>{part.quantityOnHand} {part.unit}</td>
                  <td>{part.reorderPoint}</td>
                  <td>
                    {supplierReference
                      ? `${supplierReference.supplier.code} · ${supplierReference.supplier.name}`
                      : "—"}
                  </td>
                  <td>{supplierReference?.supplierPartNumber ?? "—"}</td>
                  <td>
                    {supplierReference
                      ? `${supplierReference.leadTimeDays ?? "—"} d / ${supplierReference.minOrderQuantity ?? "—"} ${part.unit}`
                      : "—"}
                  </td>
                  <td>{part.assetParts.map((link) => link.asset.code).join(", ") || "—"}</td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>

      {selectedSiteId ? (
        <div className="card responsive-table">
          <h2>Reorder alerts</h2>
          {reorderAlerts.length === 0 ? (
            <p className="muted">No bin-level reorder alerts for the selected site.</p>
          ) : (
            <table className="table">
              <thead>
                <tr>
                  <th>Status</th>
                  <th>Part</th>
                  <th>Location</th>
                  <th>On hand</th>
                  <th>Reserved</th>
                  <th>Available</th>
                  <th>Min / max</th>
                  <th>Suggested order</th>
                </tr>
              </thead>
              <tbody>
                {reorderAlerts.map((alert) => (
                  <tr key={alert.policy.id}>
                    <td><span className="badge">{alert.status}</span></td>
                    <td>{alert.part.sku} · {alert.part.name}</td>
                    <td>{alert.bin.warehouse.code}/{alert.bin.code}</td>
                    <td>{alert.onHand} {alert.part.unit}</td>
                    <td>{alert.reserved} {alert.part.unit}</td>
                    <td>{alert.available} {alert.part.unit}</td>
                    <td>{alert.policy.minQuantity} / {alert.policy.maxQuantity}</td>
                    <td>{alert.suggestedOrderQuantity} {alert.part.unit}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
        </div>
      ) : (
        <div className="card">
          <h2>Reorder alerts</h2>
          <p className="muted">Select a site to evaluate bin-level min/max policies.</p>
        </div>
      )}

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
