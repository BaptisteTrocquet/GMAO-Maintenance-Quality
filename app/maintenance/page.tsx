import { db } from "@/lib/db";

export default async function MaintenancePage() {
  const [workOrders, plans] = await Promise.all([
    db.workOrder.findMany({ include: { asset: true, assignee: true }, orderBy: { requestedAt: "desc" } }),
    db.maintenancePlan.findMany({ include: { asset: true, checklistItems: true }, orderBy: { nextDueAt: "asc" } })
  ]);
  return <><div className="header"><div><div className="title">Maintenance</div><div className="muted">Corrective and preventive maintenance.</div></div></div><div className="grid grid-2"><div className="card"><h2>Work orders</h2><table className="table"><thead><tr><th>WO</th><th>Asset</th><th>Title</th><th>Status</th></tr></thead><tbody>{workOrders.map(w => <tr key={w.id}><td>{w.number}</td><td>{w.asset?.code ?? "—"}</td><td>{w.title}</td><td>{w.status}</td></tr>)}</tbody></table></div><div className="card"><h2>Preventive plans</h2><table className="table"><thead><tr><th>Asset</th><th>Plan</th><th>Frequency</th><th>Checklist</th></tr></thead><tbody>{plans.map(p => <tr key={p.id}><td>{p.asset.code}</td><td>{p.name}</td><td>{p.frequencyValue} {p.frequencyUnit}</td><td>{p.checklistItems.length}</td></tr>)}</tbody></table></div></div></>;
}
