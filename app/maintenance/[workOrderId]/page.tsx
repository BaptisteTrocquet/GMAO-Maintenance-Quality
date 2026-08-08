import Link from "next/link";
import { notFound } from "next/navigation";
import { db } from "@/lib/db";
import { listWorkOrderReservations } from "@/lib/inventory/reservations";
import WorkOrderCameraAttachments from "./work-order-camera-attachments";

function formatDate(value: Date | null | undefined) {
  return value ? value.toISOString().replace("T", " ").slice(0, 16) : "—";
}

function auditDetail(afterJson: string | null, actorName: string | null | undefined) {
  if (!afterJson) return "";
  try {
    const value = JSON.parse(afterJson) as Record<string, unknown>;
    if (typeof value.note === "string" && value.note) return value.note;
    if (typeof value.sku === "string" && typeof value.quantity === "number") {
      return `${value.quantity} × ${value.sku}`;
    }
    if (typeof value.fileName === "string") return value.fileName;
    if (value.signature && actorName) return `Signed by ${actorName}`;
  } catch {
    return "";
  }
  return "";
}

function attachmentFileHref(input: {
  attachmentId: string;
  storageKey: string;
  organizationId: string;
  siteId: string;
  workOrderId: string;
}) {
  const prefix = `work-orders/${input.organizationId}/${input.siteId}/${input.workOrderId}/`;
  if (!input.storageKey.startsWith(prefix)) return null;
  const query = new URLSearchParams({
    organizationId: input.organizationId,
    siteId: input.siteId,
  });
  return `/api/work-orders/${encodeURIComponent(input.workOrderId)}/attachments/${encodeURIComponent(input.attachmentId)}/file?${query.toString()}`;
}

export default async function WorkOrderDetailPage({
  params,
}: {
  params: Promise<{ workOrderId: string }>;
}) {
  const { workOrderId } = await params;
  const workOrder = await db.workOrder.findUnique({
    where: { id: workOrderId },
    include: {
      site: true,
      asset: true,
      requester: true,
      assignee: true,
      team: true,
      checkItems: true,
      parts: { include: { part: true } },
      partConsumptions: {
        include: { part: true, bin: { include: { warehouse: true } } },
        orderBy: { createdAt: "desc" },
      },
      attachments: { orderBy: { createdAt: "desc" } },
      documents: { include: { document: true } },
    },
  });
  if (!workOrder) notFound();

  const [audit, reservations] = await Promise.all([
    db.auditLog.findMany({
      where: { entityType: "WorkOrder", entityId: workOrder.id },
      include: { actor: { select: { displayName: true } } },
      orderBy: { createdAt: "desc" },
    }),
    listWorkOrderReservations({
      organizationId: workOrder.site.organizationId,
      siteId: workOrder.siteId,
      workOrderId: workOrder.id,
    }),
  ]);

  const partIds = [...new Set(reservations.map((reservation) => reservation.partId))];
  const binIds = [...new Set(reservations.map((reservation) => reservation.binId))];
  const [reservationParts, reservationBins] = await Promise.all([
    partIds.length
      ? db.part.findMany({
          where: { id: { in: partIds }, organizationId: workOrder.site.organizationId },
          select: { id: true, sku: true, name: true, unit: true },
        })
      : [],
    binIds.length
      ? db.stockBin.findMany({
          where: {
            id: { in: binIds },
            warehouse: { siteId: workOrder.siteId },
          },
          select: {
            id: true,
            code: true,
            name: true,
            warehouse: { select: { code: true, name: true } },
          },
        })
      : [],
  ]);
  const partById = new Map(reservationParts.map((part) => [part.id, part]));
  const binById = new Map(reservationBins.map((bin) => [bin.id, bin]));

  return (
    <>
      <div className="header asset-header">
        <div>
          <Link className="muted" href="/maintenance">← Maintenance</Link>
          <div className="title">{workOrder.number} · {workOrder.title}</div>
          <div className="muted">
            {workOrder.site.name} / {workOrder.asset?.code ?? "No asset"}
          </div>
        </div>
        <div className="asset-status">
          <span className="badge">{workOrder.status}</span>
          <span className="badge">{workOrder.priority}</span>
          <span className="badge">{workOrder.type}</span>
        </div>
      </div>

      <div className="grid grid-2">
        <section className="card">
          <h2>Planning</h2>
          <dl className="detail-list">
            <div><dt>Requester</dt><dd>{workOrder.requester?.displayName ?? "—"}</dd></div>
            <div><dt>Assignee</dt><dd>{workOrder.assignee?.displayName ?? "Unassigned"}</dd></div>
            <div><dt>Team</dt><dd>{workOrder.team?.name ?? "—"}</dd></div>
            <div><dt>Requested</dt><dd>{formatDate(workOrder.requestedAt)}</dd></div>
            <div><dt>Planned start</dt><dd>{formatDate(workOrder.plannedStart)}</dd></div>
            <div><dt>Due</dt><dd>{formatDate(workOrder.dueAt)}</dd></div>
            <div><dt>Started</dt><dd>{formatDate(workOrder.startedAt)}</dd></div>
            <div><dt>Completed</dt><dd>{formatDate(workOrder.completedAt)}</dd></div>
          </dl>
        </section>

        <section className="card">
          <h2>Execution</h2>
          <dl className="detail-list">
            <div><dt>Labor</dt><dd>{workOrder.laborMinutes ?? 0} min</dd></div>
            <div><dt>Downtime</dt><dd>{workOrder.downtimeMinutes ?? 0} min</dd></div>
          </dl>
          <h3>Completion note</h3>
          <p>{workOrder.completionNote ?? "No completion note yet."}</p>
        </section>
      </div>

      <div className="grid grid-2 section">
        <section className="card">
          <h2>Execution checklist</h2>
          {workOrder.checkItems.length ? (
            <div className="stack-list">
              {workOrder.checkItems.map((item) => (
                <div key={item.id}>
                  <strong>{item.completed ? "✓" : "○"} {item.label}</strong>
                  {item.note ? <span className="muted"> · {item.note}</span> : null}
                </div>
              ))}
            </div>
          ) : <div className="muted">No checklist configured.</div>}
        </section>

        <section className="card">
          <h2>Reserved parts</h2>
          {reservations.length ? (
            <div className="stack-list">
              {reservations.map((reservation) => {
                const part = partById.get(reservation.partId);
                const bin = binById.get(reservation.binId);
                const remaining = reservation.status === "ACTIVE"
                  ? Math.max(reservation.quantity - reservation.consumedQuantity, 0)
                  : 0;
                return (
                  <div key={reservation.id}>
                    <strong>{part?.sku ?? reservation.partId}</strong> · {part?.name ?? "Part"}
                    <span className="muted">
                      {` · ${reservation.status} · reserved ${reservation.quantity}${part?.unit ? ` ${part.unit}` : ""}`}
                      {` · consumed ${reservation.consumedQuantity} · remaining ${remaining}`}
                      {bin ? ` · ${bin.warehouse.code}/${bin.code}` : ""}
                    </span>
                  </div>
                );
              })}
            </div>
          ) : <div className="muted">No stock reservations.</div>}
        </section>

        <section className="card">
          <h2>Parts consumed</h2>
          {workOrder.partConsumptions.length ? (
            <div className="stack-list">
              {workOrder.partConsumptions.map((consumption) => (
                <div key={consumption.id}>
                  <strong>{consumption.part.sku}</strong> · {consumption.part.name}
                  <span className="muted">
                    {` · ${consumption.quantity} ${consumption.part.unit}`}
                    {consumption.bin ? ` · ${consumption.bin.warehouse.code}/${consumption.bin.code}` : ""}
                    {` · ${formatDate(consumption.createdAt)}`}
                  </span>
                </div>
              ))}
            </div>
          ) : <div className="muted">No parts consumed.</div>}
        </section>

        <section className="card">
          <h2>Attachments</h2>
          <WorkOrderCameraAttachments
            organizationId={workOrder.site.organizationId}
            siteId={workOrder.siteId}
            workOrderId={workOrder.id}
            disabled={workOrder.status === "CANCELLED"}
          />
          {workOrder.attachments.length ? (
            <div className="stack-list">
              {workOrder.attachments.map((attachment) => {
                const fileHref = attachmentFileHref({
                  attachmentId: attachment.id,
                  storageKey: attachment.storageKey,
                  organizationId: workOrder.site.organizationId,
                  siteId: workOrder.siteId,
                  workOrderId: workOrder.id,
                });
                return (
                  <div key={attachment.id}>
                    <strong>{attachment.fileName}</strong>
                    <span className="muted">
                      {` · ${attachment.kind}`}
                      {attachment.sizeBytes ? ` · ${(attachment.sizeBytes / 1024 / 1024).toFixed(2)} MB` : ""}
                    </span>
                    {fileHref ? (
                      <span>
                        {" · "}
                        <a className="table-link" href={fileHref} target="_blank" rel="noreferrer">
                          {attachment.kind === "PHOTO" ? "View photo" : "Download"}
                        </a>
                      </span>
                    ) : null}
                  </div>
                );
              })}
            </div>
          ) : <div className="muted">No attachments.</div>}
        </section>

        <section className="card">
          <h2>Controlled documents</h2>
          {workOrder.documents.length ? (
            <div className="stack-list">
              {workOrder.documents.map((link) => (
                <div key={link.documentId}>
                  <strong>{link.document.code}</strong> · {link.document.title}
                </div>
              ))}
            </div>
          ) : <div className="muted">No linked documents.</div>}
        </section>
      </div>

      <section className="card section">
        <h2>Activity timeline</h2>
        {audit.length ? (
          <ol className="timeline">
            {audit.map((event) => {
              const actorName = event.actor?.displayName ?? "System";
              const detail = auditDetail(event.afterJson, event.actor?.displayName);
              return (
                <li key={event.id}>
                  <time>{formatDate(event.createdAt)} UTC</time>
                  <strong>{event.action}</strong>
                  <span>{actorName}{detail ? ` · ${detail}` : ""}</span>
                </li>
              );
            })}
          </ol>
        ) : <div className="muted">No activity recorded yet.</div>}
      </section>
    </>
  );
}
