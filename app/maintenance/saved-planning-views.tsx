"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import { useRouter } from "next/navigation";

type DueFilter = "ALL" | "OVERDUE" | "DUE_7_DAYS" | "NO_DUE_DATE";
type Surface = "KANBAN" | "CALENDAR";
type Config = { dueFilter: DueFilter } | { month: string | null };

type SavedView = {
  id: string;
  name: string;
  surface: Surface;
  config: Config;
};

type ApiEnvelope<T> = {
  data?: T;
  error?: { message?: string };
};

function hrefFor(view: SavedView) {
  if (view.surface === "KANBAN") {
    const config = view.config as { dueFilter: DueFilter };
    return config.dueFilter === "ALL"
      ? "/maintenance/kanban"
      : `/maintenance/kanban?due=${encodeURIComponent(config.dueFilter)}`;
  }
  const config = view.config as { month: string | null };
  return config.month
    ? `/maintenance/calendar?month=${encodeURIComponent(config.month)}`
    : "/maintenance/calendar";
}

function configSummary(surface: Surface, config: Config) {
  return surface === "KANBAN"
    ? `Due filter: ${(config as { dueFilter: DueFilter }).dueFilter}`
    : `Month: ${(config as { month: string | null }).month ?? "current"}`;
}

export default function SavedPlanningViews({
  organizationId,
  siteId,
  surface,
  currentConfig,
}: {
  organizationId: string;
  siteId: string;
  surface: Surface;
  currentConfig: Config;
}) {
  const router = useRouter();
  const [views, setViews] = useState<SavedView[]>([]);
  const [name, setName] = useState("");
  const [busyId, setBusyId] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [status, setStatus] = useState<string | null>(null);

  const query = useMemo(
    () => new URLSearchParams({ organizationId, siteId, surface }).toString(),
    [organizationId, siteId, surface],
  );

  const loadViews = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const response = await fetch(`/api/saved-views?${query}`, { cache: "no-store" });
      const body = (await response.json()) as ApiEnvelope<SavedView[]>;
      if (!response.ok) throw new Error(body.error?.message ?? "Unable to load saved views");
      setViews(body.data ?? []);
    } catch (loadError) {
      setError(loadError instanceof Error ? loadError.message : "Unable to load saved views");
    } finally {
      setLoading(false);
    }
  }, [query]);

  useEffect(() => {
    void loadViews();
  }, [loadViews]);

  async function saveCurrent() {
    const trimmedName = name.trim();
    if (!trimmedName) return;
    setSaving(true);
    setError(null);
    setStatus(null);
    try {
      const response = await fetch("/api/saved-views", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          organizationId,
          siteId,
          surface,
          name: trimmedName,
          config: currentConfig,
        }),
      });
      const body = (await response.json()) as ApiEnvelope<SavedView>;
      if (!response.ok || !body.data) {
        throw new Error(body.error?.message ?? "Unable to save planning view");
      }
      setName("");
      setStatus(`Saved “${body.data.name}”.`);
      await loadViews();
    } catch (saveError) {
      setError(saveError instanceof Error ? saveError.message : "Unable to save planning view");
    } finally {
      setSaving(false);
    }
  }

  async function deleteView(view: SavedView) {
    setBusyId(view.id);
    setError(null);
    setStatus(null);
    try {
      const response = await fetch(
        `/api/saved-views/${view.id}?organizationId=${encodeURIComponent(organizationId)}&siteId=${encodeURIComponent(siteId)}`,
        { method: "DELETE" },
      );
      const body = (await response.json()) as ApiEnvelope<SavedView>;
      if (!response.ok) throw new Error(body.error?.message ?? "Unable to delete saved view");
      setViews((current) => current.filter((candidate) => candidate.id !== view.id));
      setStatus(`Deleted “${view.name}”.`);
    } catch (deleteError) {
      setError(deleteError instanceof Error ? deleteError.message : "Unable to delete saved view");
    } finally {
      setBusyId(null);
    }
  }

  return (
    <div style={{ display: "grid", gap: 10, marginTop: 12 }} aria-label="Personal saved planning views">
      <div style={{ display: "flex", gap: 8, flexWrap: "wrap", alignItems: "end" }}>
        <label style={{ display: "grid", gap: 4 }}>
          Save current view as
          <input
            value={name}
            maxLength={80}
            onChange={(event) => setName(event.target.value)}
            placeholder={surface === "KANBAN" ? "e.g. Weekly overdue review" : "e.g. Shutdown month"}
            disabled={saving}
          />
        </label>
        <button type="button" onClick={() => void saveCurrent()} disabled={saving || !name.trim()}>
          {saving ? "Saving…" : "Save view"}
        </button>
        <span className="muted">{configSummary(surface, currentConfig)}</span>
      </div>

      {loading ? <div className="muted" role="status">Loading saved views…</div> : null}
      {!loading && views.length ? (
        <div style={{ display: "flex", gap: 8, flexWrap: "wrap", alignItems: "center" }}>
          {views.map((view) => (
            <span key={view.id} style={{ display: "inline-flex", alignItems: "center", gap: 5 }}>
              <button type="button" onClick={() => router.push(hrefFor(view))} disabled={busyId === view.id}>
                {view.name}
              </button>
              <button
                type="button"
                aria-label={`Delete saved view ${view.name}`}
                onClick={() => void deleteView(view)}
                disabled={busyId === view.id}
              >
                {busyId === view.id ? "…" : "×"}
              </button>
            </span>
          ))}
        </div>
      ) : null}
      {!loading && views.length === 0 ? <div className="muted">No personal saved views for this surface.</div> : null}
      {error ? <div role="alert">{error}</div> : null}
      {status ? <div className="muted" role="status">{status}</div> : null}
    </div>
  );
}
