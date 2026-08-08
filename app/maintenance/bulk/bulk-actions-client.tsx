"use client";

import Link from "next/link";
import { useCallback, useEffect, useMemo, useState } from "react";
import { BULK_WORK_ORDER_LIMIT } from "@/lib/work-orders/bulk-actions";

type WorkOrderOption = {
  id: string;
  number: string;
  title: string;
  status: string;
  priority: string;
  dueAt: string | null;
  assignee: { id: string; displayName: string } | null;
  team: { id: string; name: string } | null;
  asset: { code: string } | null;
};

type Options = {
  workOrders: WorkOrderOption[];
  teams: Array<{ id: string; code: string; name: string }>;
  assignees: Array<{ id: string; displayName: string; role: string }>;
  truncated: boolean;
};

type ApiResponse<T> = { data?: T; error?: { message?: string } };
type ActionType = "SET_PRIORITY" | "SET_ASSIGNEE" | "SET_TEAM";

function formatDate(value: string | null) {
  if (!value) return "—";
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? "—" : date.toLocaleString();
}

export default function BulkActionsClient({
  organizationId,
  siteId,
}: {
  organizationId: string;
  siteId: string;
}) {
  const [options, setOptions] = useState<Options | null>(null);
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [actionType, setActionType] = useState<ActionType>("SET_PRIORITY");
  const [value, setValue] = useState("NORMAL");
  const [loading, setLoading] = useState(false);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [message, setMessage] = useState<string | null>(null);

  const load = useCallback(async () => {
    if (!organizationId || !siteId) return;
    const params = new URLSearchParams({ organizationId, siteId });
    setLoading(true);
    setError(null);
    try {
      const response = await fetch(`/api/work-orders/bulk-actions?${params.toString()}`, {
        cache: "no-store",
      });
      const body = (await response.json()) as ApiResponse<Options>;
      if (!response.ok || !body.data) {
        throw new Error(body.error?.message ?? "Bulk action options failed to load");
      }
      setOptions(body.data);
      setSelected((current) => {
        const valid = new Set(body.data!.workOrders.map((workOrder) => workOrder.id));
        return new Set([...current].filter((id) => valid.has(id)));
      });
    } catch (loadError) {
      setOptions(null);
      setError(loadError instanceof Error ? loadError.message : "Bulk action options failed to load");
    } finally {
      setLoading(false);
    }
  }, [organizationId, siteId]);

  useEffect(() => {
    void load();
  }, [load]);

  const allSelected = useMemo(
    () => Boolean(options?.workOrders.length) && selected.size === options?.workOrders.length,
    [options, selected],
  );

  function changeAction(next: ActionType) {
    setActionType(next);
    setValue(next === "SET_PRIORITY" ? "NORMAL" : "");
    setMessage(null);
  }

  function toggle(id: string) {
    setSelected((current) => {
      const next = new Set(current);
      if (next.has(id)) next.delete(id);
      else if (next.size < BULK_WORK_ORDER_LIMIT) next.add(id);
      return next;
    });
  }

  function toggleAll() {
    if (!options) return;
    if (allSelected) {
      setSelected(new Set());
      return;
    }
    setSelected(new Set(options.workOrders.slice(0, BULK_WORK_ORDER_LIMIT).map((workOrder) => workOrder.id)));
  }

  async function apply() {
    if (!selected.size) {
      setError("Select at least one work order.");
      return;
    }
    const operation =
      actionType === "SET_PRIORITY"
        ? { type: actionType, priority: value }
        : actionType === "SET_ASSIGNEE"
          ? { type: actionType, assigneeId: value || null }
          : { type: actionType, teamId: value || null };

    setSaving(true);
    setError(null);
    setMessage(null);
    try {
      const response = await fetch("/api/work-orders/bulk-actions", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          organizationId,
          siteId,
          workOrderIds: [...selected],
          operation,
        }),
      });
      const body = (await response.json()) as ApiResponse<{ count: number }>;
      if (!response.ok || !body.data) {
        throw new Error(body.error?.message ?? "Bulk action failed");
      }
      setMessage(`${body.data.count} work order${body.data.count === 1 ? "" : "s"} updated.`);
      setSelected(new Set());
      await load();
    } catch (saveError) {
      setError(saveError instanceof Error ? saveError.message : "Bulk action failed");
    } finally {
      setSaving(false);
    }
  }

  if (!organizationId || !siteId) {
    return <section className="card"><p>Select an organization and site to use bulk actions.</p></section>;
  }

  return (
    <>
      <section className="card" style={{ display: "grid", gap: 12 }}>
        <div style={{ display: "flex", justifyContent: "space-between", gap: 12, flexWrap: "wrap" }}>
          <div>
            <strong>{selected.size} selected</strong>
            <div className="muted">Maximum {BULK_WORK_ORDER_LIMIT} work orders per atomic batch.</div>
          </div>
          <Link className="table-link" href="/maintenance/kanban">Open Kanban</Link>
        </div>

        <div style={{ display: "flex", gap: 10, flexWrap: "wrap", alignItems: "end" }}>
          <label style={{ display: "grid", gap: 4 }}>
            <span>Bulk action</span>
            <select value={actionType} onChange={(event) => changeAction(event.target.value as ActionType)}>
              <option value="SET_PRIORITY">Set priority</option>
              <option value="SET_ASSIGNEE">Assign technician</option>
              <option value="SET_TEAM">Assign team</option>
            </select>
          </label>

          {actionType === "SET_PRIORITY" ? (
            <label style={{ display: "grid", gap: 4 }}>
              <span>Priority</span>
              <select value={value} onChange={(event) => setValue(event.target.value)}>
                {[
                  "LOW",
                  "NORMAL",
                  "HIGH",
                  "URGENT",
                ].map((priority) => <option key={priority} value={priority}>{priority}</option>)}
              </select>
            </label>
          ) : null}

          {actionType === "SET_ASSIGNEE" ? (
            <label style={{ display: "grid", gap: 4 }}>
              <span>Technician</span>
              <select value={value} onChange={(event) => setValue(event.target.value)}>
                <option value="">Unassigned</option>
                {options?.assignees.map((assignee) => (
                  <option key={assignee.id} value={assignee.id}>{assignee.displayName} · {assignee.role}</option>
                ))}
              </select>
            </label>
          ) : null}

          {actionType === "SET_TEAM" ? (
            <label style={{ display: "grid", gap: 4 }}>
              <span>Team</span>
              <select value={value} onChange={(event) => setValue(event.target.value)}>
                <option value="">No team</option>
                {options?.teams.map((team) => (
                  <option key={team.id} value={team.id}>{team.code} · {team.name}</option>
                ))}
              </select>
            </label>
          ) : null}

          <button type="button" onClick={apply} disabled={saving || selected.size === 0}>
            {saving ? "Applying…" : `Apply to ${selected.size}`}
          </button>
        </div>
        {message ? <div role="status">{message}</div> : null}
        {error ? <div role="alert">{error}</div> : null}
      </section>

      <section className="card section responsive-table">
        {loading && !options ? <p role="status">Loading work orders…</p> : null}
        {options?.truncated ? (
          <p className="muted" role="status">
            Showing the first {options.workOrders.length} active work orders. Refine work in Kanban before applying large batches.
          </p>
        ) : null}
        {options ? (
          <table className="table">
            <thead>
              <tr>
                <th>
                  <input
                    type="checkbox"
                    aria-label="Select all visible work orders"
                    checked={allSelected}
                    onChange={toggleAll}
                  />
                </th>
                <th>WO</th><th>Asset</th><th>Status</th><th>Priority</th><th>Assignee</th><th>Team</th><th>Due</th>
              </tr>
            </thead>
            <tbody>
              {options.workOrders.map((workOrder) => (
                <tr key={workOrder.id}>
                  <td>
                    <input
                      type="checkbox"
                      aria-label={`Select ${workOrder.number}`}
                      checked={selected.has(workOrder.id)}
                      onChange={() => toggle(workOrder.id)}
                      disabled={!selected.has(workOrder.id) && selected.size >= BULK_WORK_ORDER_LIMIT}
                    />
                  </td>
                  <td><Link className="table-link" href={`/maintenance/${workOrder.id}`}>{workOrder.number} · {workOrder.title}</Link></td>
                  <td>{workOrder.asset?.code ?? "—"}</td>
                  <td><span className="badge">{workOrder.status}</span></td>
                  <td>{workOrder.priority}</td>
                  <td>{workOrder.assignee?.displayName ?? "—"}</td>
                  <td>{workOrder.team?.name ?? "—"}</td>
                  <td>{formatDate(workOrder.dueAt)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        ) : null}
      </section>
    </>
  );
}
