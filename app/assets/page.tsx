import Link from "next/link";
import { db } from "@/lib/db";

export default async function AssetsPage() {
  const assets = await db.asset.findMany({
    where: { archivedAt: null },
    include: {
      site: true,
      location: true,
      parentAsset: true,
      _count: { select: { workOrders: true, assetDocuments: true } },
    },
    orderBy: { code: "asc" },
  });

  return <>
    <div className="header"><div><div className="title">Assets</div><div className="muted">Equipment hierarchy, criticality and documentation.</div></div></div>
    <div className="card responsive-table"><table className="table"><thead><tr><th>Code</th><th>Name</th><th>Site / Location</th><th>Parent</th><th>Criticality</th><th>Status</th><th>WO</th><th>Docs</th></tr></thead><tbody>{assets.map((asset) => <tr key={asset.id}><td><Link className="table-link" href={`/assets/${asset.id}`}>{asset.code}</Link></td><td><Link className="table-link" href={`/assets/${asset.id}`}>{asset.name}</Link></td><td>{asset.site.name} / {asset.location?.name ?? "—"}</td><td>{asset.parentAsset?.code ?? "—"}</td><td>{asset.criticality}</td><td>{asset.status}</td><td>{asset._count.workOrders}</td><td>{asset._count.assetDocuments}</td></tr>)}</tbody></table></div>
  </>;
}
