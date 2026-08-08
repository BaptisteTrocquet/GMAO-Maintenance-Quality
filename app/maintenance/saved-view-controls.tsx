"use client";

import Link from "next/link";
import { useCallback, useEffect, useState } from "react";
import type { FormEvent } from "react";

type Surface = "KANBAN" | "CALENDAR";
type KanbanConfig = { dueFilter: "ALL" | "OVERDUE" | "DUE_7_DAYS" | "NO_DUE_DATE" };
type CalendarConfig = { month: string | null };
type Config = KanbanConfig | CalendarConfig;

type SavedView = {
  id: string;
  surface: Surface;
  name: string;
  config: Config;
};

type Props = {
  organizationId: string;
  siteId: string;
  surface: Surface;
  currentConfig: Config;
};

function viewHref(view: SavedView) {
  if (view.surface === "KANBAN") {
    const config = view.config as KanbanConfig;
    return config.dueFilter === "ALL"
      ? "/maintenance/kanban"
      : `/maintenance/kanban?due=${encodeURIComponent(config.dueFilter)}`;
  }
  const config = view.config as CalendarConfig;
  return config.month
    ? `/maintenance/calendar?month=${encodeURIComponent(config.month)}`
    : "/maintenance/calendar";
}

function defaultName(surface: Surface, config: Config) {
  if (surface === "KANBAN") {
    const due = (config as KanbanConfig).dueFilter;
    const labels: Record<KanbanConfig["dueFilter"], string> = {
      ALL: "All work",
      OVERDUE: "Overdue work",
      DUE_7_DAYS: "Due this week",
      NO_DUE_DATE: "No due date",
    };
    return labels[due];
  }
  return (config as CalendarConfig).month
    ? `Calendar ${(config as CalendarConfig).month}`
    : "Current calendar month";
}

export default function SavedViewControls({
  organizationId,
  siteId,
  surface,
  currentConfig,
}: Props) {
  const currentDefaultName = defaultName(surface, currentConfig);
  const [views, setViews] = useState<SavedView[]>([]);
  const [name, setName] = useState(() => currentDefaultName);
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const loadViews = useCallback(async (signal?: AbortSignal) => {
    const query = new URLSearchParams({ organizationId, siteId, surface });
    const response = await fetch(`/api/maintenance/saved-views?${query}`, { signal });
    const body = (await response.json()) as {
      data?: SavedView[];
      error?: { message?: string };
    };
    if (!response.ok) throw new Error(body.error?.message ?? "Saved views could not be loaded");
    setViews(body.data ?? []);
  }, [organizationId, siteId, surface]);

  useEffect(() => {
    const controller = new AbortController();
    setLoading(true);
    setError(null);
    void loadViews(controller.signal)
      .catch((loadError) => {
        if (loadError instanceof DOMException && loadError.name === "AbortError") return;
        setError(loadError instanceof Error ? loadError.message : "Saved views could not be loaded");
      })
      .finally(() => {
        if (!controller.signal.aborted) setLoading(false);
      });
    return () => controller.abort();
  }, [loadViews]);

  useEffect(() => {
    setName(currentDefaultName);
  }, [currentDefaultName]);

  async function save(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setSaving(true);
    setError(null);
    try {
      const response = await fetch("/api/maintenance/saved-views", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          organizationId,
          siteId,
          surface,
          name,
          config: currentConfig,
        }),
      });
      const body = (await response.json()) as {
        data?: SavedView;
        error?: { message?: string };
      };
      if (!response.ok) throw new Error(body.error?.message ?? "Saved view could not be created");
      await loadViews();
    } catch (saveError) {
      setError(saveError instanceof Error ? saveError.message : "Saved view could not be created");
    } finally {
      setSaving(false);
    }
  }

  async function remove(view: SavedView) {
    setError(null);
    try {
      const query = new URLSearchParams({
        organizationId,
        siteId,
        viewId: view.id,
      });
      const response = await fetch(`/api/maintenance/saved-views?${query}`, {
        method: "DELETE",
      });
      const body = (await response.json()) as { error?: { message?: string } };
      if (!response.ok) throw new Error(body.error?.message ?? "Saved view could not be deleted");
      setViews((current) => current.filter((item) => item.id !== view.id));
    } catch (deleteError) {
      setError(deleteError instanceof Error ? deleteError.message : "Saved view could not be deleted");
    }
  }

  return (
    <section className="card" aria-label={`${surface.toLowerCase()} saved views`}>
      <div style={{ display: "grid", gap: 10 }}>
        <div>
          <strong>Saved views</strong>
          <div className="muted">Personal to you and this site.</div>
        </div>

        <form onSubmit={save} style={{ display: "flex", gap: 8, flexWrap: "wrap" }}>
          <label style={{ display: "grid", gap: 4, flex: "1 1 220px" }}>
            <span className="muted">View name</span>
            <input
              value={name}
              maxLength={80}
              required
              onChange={(event) => setName(event.target.value)}
              aria-label="Saved view name"
            />
          </label>
          <button type="submit" disabled={saving || !name.trim()} style={{ alignSelf: "end" }}>
            {saving ? "Saving…" : "Save current view"}
          </button>
        </form>

        {error ? <div role="alert" style={{ color: "#991b1b" }}>{error}</div> : null}
        {loading ? <div className="muted">Loading saved views…</div> : null}
        {!loading && views.length === 0 ? <div className="muted">No saved views yet.</div> : null}

        {views.length ? (
          <div style={{ display: "flex", gap: 8, flexWrap: "wrap", alignItems: "center" }}>
            {views.map((view) => (
              <span key={view.id} style={{ display: "inline-flex", gap: 4, alignItems: "center" }}>
                <Link className="badge" href={viewHref(view)} style={{ textDecoration: "none" }}>
                  {view.name}
                </Link>
                <button
                  type="button"
                  aria-label={`Delete saved view ${view.name}`}
                  title={`Delete ${view.name}`}
                  onClick={() => void remove(view)}
                  style={{ minWidth: 32 }}
                >
                  ×
                </button>
              </span>
            ))}
          </div>
        ) : null}
      </div>
    </section>
  );
}
