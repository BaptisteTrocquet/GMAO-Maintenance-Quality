"use client";

import { useCallback, useEffect, useState } from "react";
import { useRouter } from "next/navigation";

type DueFilter = "ALL" | "OVERDUE" | "DUE_7_DAYS" | "NO_DUE_DATE";

type SavedView = {
  id: string;
  name: string;
  filters: Record<string, string>;
};

type ApiEnvelope<T> = {
  data?: T;
  error?: { message?: string };
};

const SURFACE = "WORK_ORDER_KANBAN";
const DUE_FILTERS = new Set<DueFilter>(["ALL", "OVERDUE", "DUE_7_DAYS", "NO_DUE_DATE"]);

function dueFromView(view: SavedView): DueFilter {
  const due = view.filters.due as DueFilter | undefined;
  return due && DUE_FILTERS.has(due) ? due : "ALL";
}

export default function SavedViewControls({
  organizationId,
  siteId,
  currentDue,
}: {
  organizationId: string;
  siteId: string;
  currentDue: DueFilter;
}) {
  const router = useRouter();
  const [views, setViews] = useState<SavedView[]>([]);
  const [selectedId, setSelectedId] = useState("");
  const [name, setName] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [status, setStatus] = useState<string | null>(null);

  const loadViews = useCallback(async () => {
    setError(null);
    try {
      const query = new URLSearchParams({ organizationId, siteId, surface: SURFACE });
      const response = await fetch(`/api/saved-views?${query.toString()}`);
      const body = (await response.json()) as ApiEnvelope<SavedView[]>;
      if (!response.ok) throw new Error(body.error?.message ?? "Unable to load saved views");
      setViews(body.data ?? []);
      setSelectedId((current) =>
        current && (body.data ?? []).some((view) => view.id === current) ? current : "",
      );
    } catch (loadError) {
      setError(loadError instanceof Error ? loadError.message : "Unable to load saved views");
    }
  }, [organizationId, siteId]);

  useEffect(() => {
    void loadViews();
  }, [loadViews]);

  function applyView() {
    const view = views.find((candidate) => candidate.id === selectedId);
    if (!view) return;
    const due = dueFromView(view);
    router.push(due === "ALL" ? "/maintenance/kanban" : `/maintenance/kanban?due=${due}`);
  }

  async function saveCurrent() {
    if (!name.trim()) return;
    setBusy(true);
    setError(null);
    setStatus(null);
    try {
      const response = await fetch("/api/saved-views", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          organizationId,
          siteId,
          surface: SURFACE,
          name: name.trim(),
          filters: { due: currentDue },
        }),
      });
      const body = (await response.json()) as ApiEnvelope<SavedView>;
      if (!response.ok) throw new Error(body.error?.message ?? "Unable to save view");
      setName("");
      setStatus("View saved");
      await loadViews();
      if (body.data?.id) setSelectedId(body.data.id);
    } catch (saveError) {
      setError(saveError instanceof Error ? saveError.message : "Unable to save view");
    } finally {
      setBusy(false);
    }
  }

  async function updateSelected() {
    if (!selectedId) return;
    setBusy(true);
    setError(null);
    setStatus(null);
    try {
      const response = await fetch(`/api/saved-views/${selectedId}`, {
        method: "PATCH",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          organizationId,
          siteId,
          surface: SURFACE,
          filters: { due: currentDue },
        }),
      });
      const body = (await response.json()) as ApiEnvelope<SavedView>;
      if (!response.ok) throw new Error(body.error?.message ?? "Unable to update view");
      setStatus("Selected view updated");
      await loadViews();
    } catch (updateError) {
      setError(updateError instanceof Error ? updateError.message : "Unable to update view");
    } finally {
      setBusy(false);
    }
  }

  async function deleteSelected() {
    if (!selectedId) return;
    setBusy(true);
    setError(null);
    setStatus(null);
    try {
      const query = new URLSearchParams({ organizationId, siteId, surface: SURFACE });
      const response = await fetch(`/api/saved-views/${selectedId}?${query.toString()}`, {
        method: "DELETE",
      });
      const body = (await response.json()) as ApiEnvelope<SavedView>;
      if (!response.ok) throw new Error(body.error?.message ?? "Unable to delete view");
      setSelectedId("");
      setStatus("View deleted");
      await loadViews();
    } catch (deleteError) {
      setError(deleteError instanceof Error ? deleteError.message : "Unable to delete view");
    } finally {
      setBusy(false);
    }
  }

  return (
    <div style={{ display: "grid", gap: 10, marginTop: 12 }}>
      <div style={{ display: "flex", gap: 8, flexWrap: "wrap", alignItems: "end" }}>
        <label style={{ display: "grid", gap: 4 }}>
          Saved view
          <select
            value={selectedId}
            onChange={(event) => setSelectedId(event.target.value)}
            disabled={busy}
          >
            <option value="">Choose a saved view</option>
            {views.map((view) => (
              <option key={view.id} value={view.id}>{view.name}</option>
            ))}
          </select>
        </label>
        <button type="button" onClick={applyView} disabled={busy || !selectedId}>Apply</button>
        <button type="button" onClick={() => void updateSelected()} disabled={busy || !selectedId}>
          Update with current filter
        </button>
        <button type="button" onClick={() => void deleteSelected()} disabled={busy || !selectedId}>
          Delete
        </button>
      </div>

      <div style={{ display: "flex", gap: 8, flexWrap: "wrap", alignItems: "end" }}>
        <label style={{ display: "grid", gap: 4 }}>
          Save current filter as
          <input
            value={name}
            maxLength={80}
            onChange={(event) => setName(event.target.value)}
            placeholder="e.g. Weekly overdue review"
            disabled={busy}
          />
        </label>
        <button type="button" onClick={() => void saveCurrent()} disabled={busy || !name.trim()}>
          {busy ? "Saving…" : "Save view"}
        </button>
        <span className="muted">Current due filter: {currentDue}</span>
      </div>

      {error ? <div role="alert">{error}</div> : null}
      {status ? <div className="muted" role="status">{status}</div> : null}
    </div>
  );
}
