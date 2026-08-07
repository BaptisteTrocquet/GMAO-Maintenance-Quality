import Link from "next/link";
import { notFound } from "next/navigation";
import { db } from "@/lib/db";
import { buildAssetQrPayload } from "@/lib/assets/qr";

function formatDate(value: Date | null | undefined) {
  return value ? value.toISOString().slice(0, 10) : "—";
}

export default async function AssetDetailPage({ params }: { params: Promise<{ assetId: string }> }) {
  const { assetId } = await params;
  const asset = await db.asset.findUnique({
    where: { id: assetId },
    include: {
      site: true,
      location: true,
      parentAsset: true,
      childAssets: { where: { archivedAt: null }, orderBy: { code: "asc" } },
      workOrders: { orderBy: { requestedAt: "desc" }, take: 6 },
      maintenancePlans: { where: { active: true }, orderBy: { nextDueAt: "asc" } },
      meters: { include: { readings: { orderBy: { readingAt: "desc" }, take: 1 } }, orderBy: { code: "asc" } },
      assetDocuments: { include: { document: true } },
      assetParts: { include: { part: true } },
      attachments: { orderBy: { createdAt: "desc" } },
      statusHistory: { orderBy: { changedAt: "desc" }, take: 20 },
    },
  });
  if (!asset) notFound();

  const audit = await db.auditLog.findMany({
    where: { entityType: "Asset", entityId: asset.id },
    orderBy: { createdAt: "desc" },
    take: 20,
  });
  const timeline = [
    ...asset.statusHistory.map((entry) => ({
      at: entry.changedAt,
      title: `${entry.fromStatus ?? "NEW"} → ${entry.toStatus}`,
      detail: entry.note ?? "Asset status changed",
    })),
    ...audit.map((entry) => ({ at: entry.createdAt, title: entry.action, detail: "Asset audit event" })),
  ].sort((a, b) => b.at.getTime() - a.at.getTime()).slice(0, 20);

  const qrPayload = buildAssetQrPayload({ assetId: asset.id });

  return <>
    <div className="header asset-header"><div><Link className="muted" href="/assets">← Assets</Link><div className="title">{asset.code} · {asset.name}</div><div className="muted">{asset.site.name} / {asset.location?.name ?? "No location"}</div></div><div className="asset-status"><span className="badge">{asset.status}</span><span className="badge">{asset.criticality}</span></div></div>
    <div className="grid asset-summary-grid">
      <section className="card"><h2>Identity</h2><dl className="detail-list"><div><dt>Category</dt><dd>{asset.category ?? "—"}</dd></div><div><dt>Manufacturer</dt><dd>{asset.manufacturer ?? "—"}</dd></div><div><dt>Model</dt><dd>{asset.model ?? "—"}</dd></div><div><dt>Serial</dt><dd>{asset.serialNumber ?? "—"}</dd></div><div><dt>Parent</dt><dd>{asset.parentAsset?.code ?? "—"}</dd></div></dl></section>
      <section className="card"><h2>Lifecycle</h2><dl className="detail-list"><div><dt>Installed</dt><dd>{formatDate(asset.installedAt)}</dd></div><div><dt>Commissioned</dt><dd>{formatDate(asset.commissionedAt)}</dd></div><div><dt>Decommissioned</dt><dd>{formatDate(asset.decommissionedAt)}</dd></div><div><dt>Archived</dt><dd>{formatDate(asset.archivedAt)}</dd></div></dl></section>
      <section className="card qr-card"><h2>QR label</h2><div className="qr-placeholder" aria-label={`QR payload ${qrPayload}`}><span>QR</span></div><code>{qrPayload}</code><div className="muted">Stable asset route for printable labels and scanners.</div></section>
    </div>
    <div className="grid grid-2 section">
      <section className="card"><h2>Meters</h2>{asset.meters.length ? <div className="stack-list">{asset.meters.map((meter) => <div key={meter.id}><strong>{meter.code}</strong> · {meter.name}<span className="muted"> {meter.readings[0] ? `${meter.readings[0].value} ${meter.unit}` : "No reading"}</span></div>)}</div> : <div className="muted">No meters.</div>}</section>
      <section className="card"><h2>Active preventive plans</h2>{asset.maintenancePlans.length ? <div className="stack-list">{asset.maintenancePlans.map((plan) => <div key={plan.id}><strong>{plan.name}</strong><span className="muted"> · next {formatDate(plan.nextDueAt)}</span></div>)}</div> : <div className="muted">No active plans.</div>}</section>
      <section className="card"><h2>Controlled documents</h2>{asset.assetDocuments.length ? <div className="stack-list">{asset.assetDocuments.map((link) => <div key={link.documentId}><strong>{link.document.code}</strong> · {link.document.title}</div>)}</div> : <div className="muted">No linked documents.</div>}</section>
      <section className="card"><h2>BOM / spare parts</h2>{asset.assetParts.length ? <div className="stack-list">{asset.assetParts.map((link) => <div key={link.partId}><strong>{link.part.sku}</strong> · {link.part.name}<span className="muted"> · recommended {link.quantityRecommended ?? "—"}</span></div>)}</div> : <div className="muted">No linked spare parts.</div>}</section>
      <section className="card"><h2>Attachments</h2>{asset.attachments.length ? <div className="stack-list">{asset.attachments.map((item) => <div key={item.id}><strong>{item.fileName}</strong><span className="muted"> · {item.kind}</span></div>)}</div> : <div className="muted">No attachments.</div>}</section>
      <section className="card"><h2>Child assets</h2>{asset.childAssets.length ? <div className="stack-list">{asset.childAssets.map((child) => <Link key={child.id} href={`/assets/${child.id}`}><strong>{child.code}</strong> · {child.name}</Link>)}</div> : <div className="muted">No child assets.</div>}</section>
    </div>
    <section className="card section"><h2>Recent work orders</h2>{asset.workOrders.length ? <div className="responsive-table"><table className="table"><thead><tr><th>WO</th><th>Title</th><th>Status</th><th>Priority</th><th>Requested</th></tr></thead><tbody>{asset.workOrders.map((wo) => <tr key={wo.id}><td>{wo.number}</td><td>{wo.title}</td><td>{wo.status}</td><td>{wo.priority}</td><td>{formatDate(wo.requestedAt)}</td></tr>)}</tbody></table></div> : <div className="muted">No work orders.</div>}</section>
    <section className="card section"><h2>Activity timeline</h2>{timeline.length ? <ol className="timeline">{timeline.map((entry, index) => <li key={`${entry.at.toISOString()}-${index}`}><time>{entry.at.toISOString().replace("T", " ").slice(0, 16)} UTC</time><strong>{entry.title}</strong><span>{entry.detail}</span></li>)}</ol> : <div className="muted">No activity recorded yet.</div>}</section>
  </>;
}
