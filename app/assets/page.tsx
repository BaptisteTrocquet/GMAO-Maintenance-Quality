import { db } from "@/lib/db";

export default async function AssetsPage() {
  const assets = await db.asset.findMany({ include: { site: true, location: true, parentAsset: true, _count: { select: { workOrders: true, assetDocuments: true } } }, orderBy: { code: "asc" } });
  return <><div className="header"><div><div className="title">Assets</div><div className="muted">Equipment hierarchy, criticality and documentation.</div></div></div><div className="card"><table className="table"><thead><tr><th>Code</th><th>Name</th><th>Site / Location</th><th>Parent</th><th>Criticality</th><th>Status</th><th>WO</th><th>Docs</th></tr></thead><tbody>{assets.map(a => <tr key={a.id}><td>{a.code}</td><td>{a.name}</td><td>{a.site.name} / {a.location?.name ?? "—"}</td><td>{a.parentAsset?.code ?? "—"}</td><td>{a.criticality}</td><td>{a.status}</td><td>{a._count.workOrders}</td><td>{a._count.assetDocuments}</td></tr>)}</tbody></table></div></>;
}
