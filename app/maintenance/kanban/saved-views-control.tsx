"use client";

import Link from "next/link";
import { useEffect, useState, type FormEvent } from "react";
import type {
  WorkOrderAssignmentFilter,
  WorkOrderDueFilter,
  WorkOrderPriorityFilter,
} from "@/lib/maintenance/board";

type SavedView = {
  id: string;
  name: string;
  dueFilter: WorkOrderDueFilter;
  priorityFilter: WorkOrderPriorityFilter;
  assignmentFilter: WorkOrderAssignmentFilter;
};

type Props = {
  organizationId: string;
  siteId: string;
  dueFilter: WorkOrderDueFilter;
  priorityFilter: WorkOrderPriorityFilter;
  assignmentFilter: WorkOrderAssignmentFilter;
};

function viewHref(view: SavedView) {
  const params = new URLSearchParams();
  if (view.dueFilter !== "ALL") params.set("due", view.dueFilter);
  if (view.priorityFilter !== "ALL") params.set("priority", view.priorityFilter);
  if (view.assignmentFilter !== "ALL") params.set("assignment", view.assignmentFilter);
  const query = params.toString();
  return query ? `/maintenance/kanban?${query}` : "/maintenance/kanban";
}

export default function SavedViewsControl({
  organizationId,
  siteId,
  dueFilter,
  priorityFilter,
  assignmentFilter,
}: Props) {
  const [views, setViews] = useState<SavedView[]>([]);
  const [name, setName] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function loadViews() {
    const params = new URLSearchParams({ organizationId, siteId });
    const response = await fetch(`/api/maintenance/saved-views?${params.toString()}`, {
      cache: "no-store",
    });
    const body = (await response.json()) as {
      data?: SavedView[];
      error?: { message?: string };
    };
    if (!response.ok) throw new Error(body.error?.message ?? "Unable to load saved views");
    setViews(body.data ?? []);
  }

  useEffect(() => {
    let active = true;
    void (async () => {
      try {
        const params = new URLSearchParams({ organizationId, siteId });
        const response = await fetch(`/api/maintenance/saved-views?${params.toString()}`, {
          cache: "no-store",
        });
        const body = (await response.json()) as {
          data?: SavedView[];
          error?: { message?: string };
        };
        if (!response.ok) throw new Error(body.error?.message ?? "Unable to load saved views");
        if (active) setViews(body.data ?? []);
      } catch (loadError) {
        if (active) {
          setError(loadError instanceof Error ? loadError.message : "Unable to load saved views");
        }
      }
    })();
    return () => {
      active = false;
    };
  }, [organizationId, siteId]);

  async function save(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!name.trim()) return;
    setBusy(true);
    setError(null);
    try {
      const response = await fetch("/api/maintenance/saved-views", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          organizationId,
          siteId,
          name,
          dueFilter,
          priorityFilter,
          assignmentFilter,
        }),
      });
      const body = (await response.json()) as { error?: { message?: string } };
      if (!response.ok) throw new Error(body.error?.message ?? "Unable to save view");
      setName("");
      await loadViews();
    } catch (saveError) {
      setError(saveError instanceof Error ? saveError.message : "Unable to save view");
    } finally {
      setBusy(false);
    }
  }

  async function remove(viewId: string) {
    setBusy(true);
    setError(null);
    try {
      const response = await fetch(`/api/maintenance/saved-views/${viewId}`, {
        method: "DELETE",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ organizationId, siteId }),
      });
      const body = (await response.json()) as { error?: { message?: string } };
      if (!response.ok) throw new Error(body.error?.message ?? "Unable to delete saved view");
      await loadViews();
    } catch (deleteError) {
      setError(deleteError instanceof Error ? deleteError.message : "Unable to delete saved view");
    } finally {
      setBusy(false);
    }
  }

  return (
    <div style={{ display: "grid", gap: 10 }}>
      <div style={{ display: "flex", gap: 8, flexWrap: "wrap", alignItems: "center" }}>
        <strong>Saved views</strong>
        {views.length === 0 ? <span className="muted">No personal views yet.</span> : null}
        {views.map((view) => (
          <span key={view.id} style={{ display: "inline-flex", gap: 4, alignItems: "center" }}>
            <Link className="badge" href={viewHref(view)} style={{ textDecoration: "none" }}>
              {view.name}
            </Link>
            <button
              type="button"
              onClick={() => void remove(view.id)}
              disabled={busy}
              aria-label={`Delete saved view ${view.name}`}
              title={`Delete ${view.name}`}
              style={{ padding: "2px 7px" }}
            >
              ×
            </button>
          </span>
        ))}
      </div>

      <form onSubmit={save} style={{ display: "flex", gap: 8, flexWrap: "wrap", alignItems: "end" }}>
        <label style={{ display: "grid", gap: 4 }}>
          <span className="muted">Save current filters as</span>
          <input
            value={name}
            onChange={(event) => setName(event.target.value)}
            maxLength={80}
            placeholder="My urgent work"
            disabled={busy}
          />
        </label>
        <button type="submit" disabled={busy || !name.trim()}>
          {busy ? "Saving…" : "Save view"}
        </button>
      </form>
      {error ? <div role="alert">{error}</div> : null}
    </div>
  );
}
