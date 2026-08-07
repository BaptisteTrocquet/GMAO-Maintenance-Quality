import { db } from "@/lib/db";

export default async function InventoryPage() {
  const parts = await db.part.findMany({ include: { assetParts: { include: { asset: true } } }, orderBy: { sku: "asc" } });
  return <><div className="header"><div><div className="title">Inventory</div><div className="muted">Spare parts and equipment relationships.</div></div></div><div className="card"><table className="table"><thead><tr><th>SKU</th><th>Part</th><th>Stock</th><th>Reorder point</th><th>Assets</th></tr></thead><tbody>{parts.map(p => <tr key={p.id}><td>{p.sku}</td><td>{p.name}</td><td>{p.quantityOnHand} {p.unit}</td><td>{p.reorderPoint}</td><td>{p.assetParts.map(a=>a.asset.code).join(", ") || "—"}</td></tr>)}</tbody></table></div></>;
}
