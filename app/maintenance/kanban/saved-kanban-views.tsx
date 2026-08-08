"use client";

import { FormEvent, useCallback, useEffect, useState } from "react";
import { useRouter } from "next/navigation";

type DueFilter = "ALL" | "OVERDUE" | "DUE_7_DAYS" | "NO_DUE_DATE";

type SavedView = {
  id: string;
  name: string;
  dueFilter: DueFilter;
};

function apiUrl(input: { organizationId: string; siteId: string; viewId?: string }) {
  const params = new URLSearchParams({
    organizationId: input.organizationId,
    siteId: input.siteId,
  });
  if (input.viewId) params.set("viewId", input.viewId);
  return `/api/maintenance/saved-kanban-views?${params.toString()}`;
}

function kanbanHref(dueFilter: DueFilter) {
  return dueFilter === "ALL" ? "/maintenance/kanban" : `/maintenance/kanban?due=${dueFilter}`;
}

async function errorMessage(response: Response, fallback: string) {
  const body = (await response.json().catch(() => null)) as
    | { error?: { message?: string } }
    | null;
  return body?.error?.message ?? fallback;
}

export default function SavedKanbanViews({
  organizationId,
  siteId,
  selectedDueFilter,
}: {
  organizationId: string;
  siteId: string;
  selectedDueFilter: DueFilter;
}) {
  const router = useRouter();
  const [views, setViews] = useState<SavedView[]>([]);
  const [name, setName] = useState("");
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [deletingId, setDeletingId] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  const refresh = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const response = await fetch(apiUrl({ organizationId, siteId }), { cache: "no-store" });
      if (!response.ok) throw new Error(await errorMessage(response, "Unable to load saved views"));
      const body = (await response.json()) as { data: SavedView[] };
      setViews(body.data);
    } catch (loadError) {
      setError(loadError instanceof Error ? loadError.message : "Unable to load saved views");
    } finally {
      setLoading(false);
    }
  }, [organizationId, siteId]);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  async function save(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const trimmedName = name.trim();
    if (!trimmedName) return;

    setSaving(true);
    setError(null);
    try {
      const response = await fetch("/api/maintenance/saved-kanban-views", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          organizationId,
          siteId,
          name: trimmedName,
          dueFilter: selectedDueFilter,
        }),
      });
      if (!response.ok) throw new Error(await errorMessage(response, "Unable to save view"));
      setName("");
      await refresh();
    } catch (saveError) {
      setError(saveError instanceof Error ? saveError.message : "Unable to save view");
    } finally {
      setSaving(false);
    }
  }

  async function remove(viewId: string) {
    setDeletingId(viewId);
    setError(null);
    try {
      const response = await fetch(apiUrl({ organizationId, siteId, viewId }), {
        method: "DELETE",
      });
      if (!response.ok) throw new Error(await errorMessage(response, "Unable to delete view"));
      setViews((current) => current.filter((view) => view.id !== viewId));
    } catch (deleteError) {
      setError(deleteError instanceof Error ? deleteError.message : "Unable to delete view");
    } finally {
      setDeletingId(null);
    }
  }

  return (
    <div style={{ marginTop: 16, display: "grid", gap: 10 }}>
      <div>
        <strong>Saved views</strong>
        <div className="muted">Personal to your account and this site.</div>
      </div>

      <form onSubmit={save} style={{ display: "flex", gap: 8, flexWrap: "wrap", alignItems: "end" }}>
        <label style={{ display: "grid", gap: 4 }}>
          <span className="muted">View name</span>
          <input
            value={name}
            onChange={(event) => setName(event.target.value)}
            maxLength={80}
            placeholder="e.g. Morning overdue"
            disabled={saving}
          />
        </label>
        <button type="submit" disabled={saving || !name.trim()}>
          {saving ? "Saving…" : "Save current filter"}
        </button>
      </form>

      {loading ? <div className="muted" role="status">Loading saved views…</div> : null}
      {!loading && views.length === 0 ? <div className="muted">No saved views yet.</div> : null}
      {views.length ? (
        <div style={{ display: "flex", gap: 8, flexWrap: "wrap" }}>
          {views.map((view) => (
            <span key={view.id} style={{ display: "inline-flex", gap: 4, alignItems: "center" }}>
              <button
                type="button"
                className="badge"
                onClick={() => router.push(kanbanHref(view.dueFilter))}
                aria-label={`Apply saved view ${view.name}`}
                title={`Due filter: ${view.dueFilter}`}
              >
                {view.name}
              </button>
              <button
                type="button"
                onClick={() => void remove(view.id)}
                disabled={deletingId === view.id}
                aria-label={`Delete saved view ${view.name}`}
                title="Delete saved view"
              >
                {deletingId === view.id ? "…" : "×"}
              </button>
            </span>
          ))}
        </div>
      ) : null}
      {error ? <div role="alert">{error}</div> : null}
    </div>
  );
}
