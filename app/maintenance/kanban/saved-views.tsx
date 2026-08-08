"use client";

import Link from "next/link";
import { useEffect, useState } from "react";
import type { WorkOrderDueFilter } from "@/lib/maintenance/board";

type SavedView = {
  id: string;
  name: string;
  surface: "KANBAN";
  config: { dueFilter: WorkOrderDueFilter };
};

type ApiEnvelope<T> = {
  data?: T;
  error?: { message?: string };
};

function href(view: SavedView) {
  return view.config.dueFilter === "ALL"
    ? "/maintenance/kanban"
    : `/maintenance/kanban?due=${encodeURIComponent(view.config.dueFilter)}`;
}

export default function SavedKanbanViews({
  organizationId,
  siteId,
  currentDueFilter,
}: {
  organizationId: string;
  siteId: string;
  currentDueFilter: WorkOrderDueFilter;
}) {
  const [views, setViews] = useState<SavedView[]>([]);
  const [name, setName] = useState("");
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState(false);
  const [feedback, setFeedback] = useState<{ kind: "error" | "success"; message: string } | null>(null);

  async function load() {
    setLoading(true);
    try {
      const response = await fetch(
        `/api/maintenance/saved-views?organizationId=${encodeURIComponent(organizationId)}&siteId=${encodeURIComponent(siteId)}`,
        { cache: "no-store" },
      );
      const body = (await response.json()) as ApiEnvelope<SavedView[]>;
      if (!response.ok || !body.data) throw new Error(body.error?.message ?? "Unable to load saved views");
      setViews(body.data);
    } catch (error) {
      setFeedback({ kind: "error", message: error instanceof Error ? error.message : "Unable to load saved views" });
    } finally {
      setLoading(false);
    }
  }

  useEffect(() => {
    void load();
    // Scope changes remount the relevant server page in normal navigation.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [organizationId, siteId]);

  async function save() {
    const trimmed = name.trim();
    if (!trimmed || busy) return;
    setBusy(true);
    setFeedback(null);
    try {
      const response = await fetch("/api/maintenance/saved-views", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          organizationId,
          siteId,
          name: trimmed,
          surface: "KANBAN",
          config: { dueFilter: currentDueFilter },
        }),
      });
      const body = (await response.json()) as ApiEnvelope<SavedView>;
      if (!response.ok || !body.data) throw new Error(body.error?.message ?? "Unable to save view");
      setViews((current) => [...current, body.data!].sort((a, b) => a.name.localeCompare(b.name)));
      setName("");
      setFeedback({ kind: "success", message: `Saved view “${body.data.name}”.` });
    } catch (error) {
      setFeedback({ kind: "error", message: error instanceof Error ? error.message : "Unable to save view" });
    } finally {
      setBusy(false);
    }
  }

  async function remove(view: SavedView) {
    if (busy) return;
    setBusy(true);
    setFeedback(null);
    try {
      const response = await fetch("/api/maintenance/saved-views", {
        method: "DELETE",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ organizationId, siteId, viewId: view.id }),
      });
      const body = (await response.json()) as ApiEnvelope<unknown>;
      if (!response.ok) throw new Error(body.error?.message ?? "Unable to delete saved view");
      setViews((current) => current.filter((item) => item.id !== view.id));
      setFeedback({ kind: "success", message: `Deleted view “${view.name}”.` });
    } catch (error) {
      setFeedback({ kind: "error", message: error instanceof Error ? error.message : "Unable to delete saved view" });
    } finally {
      setBusy(false);
    }
  }

  return (
    <section className="card" aria-labelledby="saved-kanban-views-title">
      <div style={{ display: "flex", justifyContent: "space-between", gap: 12, flexWrap: "wrap", alignItems: "end" }}>
        <div>
          <h2 id="saved-kanban-views-title" style={{ marginTop: 0, marginBottom: 4 }}>Saved views</h2>
          <div className="muted">Personal to you for this site. Current filter: {currentDueFilter}.</div>
        </div>
        <div style={{ display: "flex", gap: 6, alignItems: "end", flexWrap: "wrap" }}>
          <label style={{ display: "grid", gap: 3, fontSize: 12 }}>
            View name
            <input
              value={name}
              onChange={(event) => setName(event.target.value)}
              maxLength={80}
              placeholder="e.g. Morning overdue"
              disabled={busy}
              onKeyDown={(event) => {
                if (event.key === "Enter") {
                  event.preventDefault();
                  void save();
                }
              }}
            />
          </label>
          <button type="button" onClick={() => void save()} disabled={busy || !name.trim()}>
            {busy ? "Saving…" : "Save current"}
          </button>
        </div>
      </div>

      <div style={{ display: "flex", gap: 8, flexWrap: "wrap", marginTop: 12 }}>
        {loading ? <span className="muted">Loading saved views…</span> : null}
        {!loading && views.length === 0 ? <span className="muted">No saved views yet.</span> : null}
        {views.map((view) => (
          <span key={view.id} style={{ display: "inline-flex", alignItems: "center", gap: 4 }}>
            <Link className="badge" href={href(view)} style={{ textDecoration: "none" }}>
              {view.name}
            </Link>
            <button
              type="button"
              aria-label={`Delete saved view ${view.name}`}
              onClick={() => void remove(view)}
              disabled={busy}
              style={{ padding: "2px 6px" }}
            >
              ×
            </button>
          </span>
        ))}
      </div>

      {feedback ? (
        <p role={feedback.kind === "error" ? "alert" : "status"} style={{ marginBottom: 0 }}>
          {feedback.message}
        </p>
      ) : null}
    </section>
  );
}
