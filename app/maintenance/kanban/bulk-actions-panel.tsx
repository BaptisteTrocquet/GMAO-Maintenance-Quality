"use client";

import { useMemo, useState } from "react";
import { useRouter } from "next/navigation";

type WorkOrderOption = {
  id: string;
  number: string;
  title: string;
  priority: "LOW" | "NORMAL" | "HIGH" | "URGENT";
  dueAt: string | null;
};

type Action =
  | "PRIORITY"
  | "SET_DUE_DATE"
  | "CLEAR_DUE_DATE"
  | "SET_PLANNED_START"
  | "CLEAR_PLANNED_START";

export default function BulkActionsPanel({
  organizationId,
  siteId,
  workOrders,
}: {
  organizationId: string;
  siteId: string;
  workOrders: WorkOrderOption[];
}) {
  const router = useRouter();
  const [selected, setSelected] = useState<Set<string>>(() => new Set());
  const [action, setAction] = useState<Action>("PRIORITY");
  const [priority, setPriority] = useState<WorkOrderOption["priority"]>("NORMAL");
  const [date, setDate] = useState("");
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  const allSelected = workOrders.length > 0 && selected.size === workOrders.length;
  const selectedOrders = useMemo(
    () => workOrders.filter((workOrder) => selected.has(workOrder.id)),
    [selected, workOrders],
  );

  function toggle(id: string) {
    setSelected((current) => {
      const next = new Set(current);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  }

  function toggleAll() {
    setSelected(allSelected ? new Set() : new Set(workOrders.map((workOrder) => workOrder.id)));
  }

  function changes() {
    switch (action) {
      case "PRIORITY":
        return { priority };
      case "SET_DUE_DATE":
        return date ? { dueAt: `${date}T00:00:00.000Z` } : null;
      case "CLEAR_DUE_DATE":
        return { dueAt: null };
      case "SET_PLANNED_START":
        return date ? { plannedStart: `${date}T00:00:00.000Z` } : null;
      case "CLEAR_PLANNED_START":
        return { plannedStart: null };
    }
  }

  async function apply() {
    if (!selected.size) {
      setError("Select at least one work order.");
      return;
    }
    const nextChanges = changes();
    if (!nextChanges) {
      setError("Choose a date before applying this action.");
      return;
    }

    setBusy(true);
    setError(null);
    setMessage(null);
    try {
      const response = await fetch("/api/work-orders/bulk-triage", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          organizationId,
          siteId,
          workOrderIds: [...selected],
          changes: nextChanges,
        }),
      });
      const body = (await response.json()) as {
        data?: { count: number };
        error?: { message?: string };
      };
      if (!response.ok || !body.data) {
        throw new Error(body.error?.message ?? "Bulk update failed");
      }
      setMessage(`Updated ${body.data.count} work order${body.data.count === 1 ? "" : "s"}.`);
      setSelected(new Set());
      router.refresh();
    } catch (applyError) {
      setError(applyError instanceof Error ? applyError.message : "Bulk update failed");
    } finally {
      setBusy(false);
    }
  }

  return (
    <section className="card" aria-labelledby="bulk-actions-title">
      <div style={{ display: "flex", justifyContent: "space-between", gap: 12, flexWrap: "wrap" }}>
        <div>
          <h2 id="bulk-actions-title" style={{ margin: 0, fontSize: 16 }}>Bulk actions</h2>
          <div className="muted">Priority and planning dates · status transitions stay workflow-controlled per work order.</div>
        </div>
        <span className="badge">{selected.size} selected</span>
      </div>

      <div style={{ display: "flex", gap: 8, flexWrap: "wrap", alignItems: "end", marginTop: 12 }}>
        <label>
          <span className="muted" style={{ display: "block" }}>Action</span>
          <select value={action} onChange={(event) => setAction(event.target.value as Action)}>
            <option value="PRIORITY">Set priority</option>
            <option value="SET_DUE_DATE">Set due date</option>
            <option value="CLEAR_DUE_DATE">Clear due date</option>
            <option value="SET_PLANNED_START">Set planned start</option>
            <option value="CLEAR_PLANNED_START">Clear planned start</option>
          </select>
        </label>

        {action === "PRIORITY" ? (
          <label>
            <span className="muted" style={{ display: "block" }}>Priority</span>
            <select value={priority} onChange={(event) => setPriority(event.target.value as WorkOrderOption["priority"])}>
              <option value="LOW">Low</option>
              <option value="NORMAL">Normal</option>
              <option value="HIGH">High</option>
              <option value="URGENT">Urgent</option>
            </select>
          </label>
        ) : action === "SET_DUE_DATE" || action === "SET_PLANNED_START" ? (
          <label>
            <span className="muted" style={{ display: "block" }}>Date</span>
            <input type="date" value={date} onChange={(event) => setDate(event.target.value)} />
          </label>
        ) : null}

        <button type="button" onClick={() => void apply()} disabled={busy || !selected.size}>
          {busy ? "Applying…" : `Apply to ${selected.size || 0}`}
        </button>
      </div>

      <details style={{ marginTop: 12 }}>
        <summary>Select work orders ({workOrders.length} available)</summary>
        <div style={{ display: "grid", gap: 8, marginTop: 10 }}>
          <label style={{ display: "flex", gap: 8, alignItems: "center" }}>
            <input type="checkbox" checked={allSelected} onChange={toggleAll} />
            <strong>Select all available</strong>
          </label>
          {workOrders.map((workOrder) => (
            <label key={workOrder.id} style={{ display: "flex", gap: 8, alignItems: "start" }}>
              <input
                type="checkbox"
                checked={selected.has(workOrder.id)}
                onChange={() => toggle(workOrder.id)}
              />
              <span>
                <strong>{workOrder.number}</strong> · {workOrder.title}
                <span className="muted"> · {workOrder.priority}{workOrder.dueAt ? ` · due ${workOrder.dueAt.slice(0, 10)}` : ""}</span>
              </span>
            </label>
          ))}
        </div>
      </details>

      {selectedOrders.length > 0 ? (
        <div className="muted" style={{ marginTop: 8 }}>
          Scope: {selectedOrders.map((workOrder) => workOrder.number).join(", ")}
        </div>
      ) : null}
      {message ? <div role="status" style={{ marginTop: 8 }}>{message}</div> : null}
      {error ? <div role="alert" style={{ marginTop: 8, color: "#991b1b" }}>{error}</div> : null}
    </section>
  );
}
