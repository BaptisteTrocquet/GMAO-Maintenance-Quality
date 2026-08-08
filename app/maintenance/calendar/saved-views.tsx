"use client";

import Link from "next/link";
import { useEffect, useState } from "react";

type SavedView = {
  id: string;
  name: string;
  surface: "CALENDAR";
  config: { month: string | null };
};

type ApiEnvelope<T> = {
  data?: T;
  error?: { message?: string };
};

function href(view: SavedView) {
  return view.config.month
    ? `/maintenance/calendar?month=${encodeURIComponent(view.config.month)}`
    : "/maintenance/calendar";
}

export default function SavedCalendarViews({
  organizationId,
  siteId,
  currentMonth,
}: {
  organizationId: string;
  siteId: string;
  currentMonth: string;
}) {
  const [views, setViews] = useState<SavedView[]>([]);
  const [name, setName] = useState("");
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState(false);
  const [feedback, setFeedback] = useState<{ kind: "error" | "success"; message: string } | null>(null);

  async function load() {
    setLoading(true);
    try {
      const query = new URLSearchParams({
        organizationId,
        siteId,
        surface: "CALENDAR",
      });
      const response = await fetch(`/api/maintenance/saved-views?${query.toString()}`, {
        cache: "no-store",
      });
      const body = (await response.json()) as ApiEnvelope<SavedView[]>;
      if (!response.ok || !body.data) {
        throw new Error(body.error?.message ?? "Unable to load saved calendar views");
      }
      setViews(body.data);
    } catch (error) {
      setFeedback({
        kind: "error",
        message: error instanceof Error ? error.message : "Unable to load saved calendar views",
      });
    } finally {
      setLoading(false);
    }
  }

  useEffect(() => {
    void load();
    // Scope changes remount the server page in normal navigation.
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
          surface: "CALENDAR",
          config: { month: currentMonth },
        }),
      });
      const body = (await response.json()) as ApiEnvelope<SavedView>;
      if (!response.ok || !body.data) {
        throw new Error(body.error?.message ?? "Unable to save calendar view");
      }
      setViews((current) => [...current, body.data!].sort((a, b) => a.name.localeCompare(b.name)));
      setName("");
      setFeedback({ kind: "success", message: `Saved view “${body.data.name}”.` });
    } catch (error) {
      setFeedback({
        kind: "error",
        message: error instanceof Error ? error.message : "Unable to save calendar view",
      });
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
      if (!response.ok) {
        throw new Error(body.error?.message ?? "Unable to delete saved calendar view");
      }
      setViews((current) => current.filter((item) => item.id !== view.id));
      setFeedback({ kind: "success", message: `Deleted view “${view.name}”.` });
    } catch (error) {
      setFeedback({
        kind: "error",
        message: error instanceof Error ? error.message : "Unable to delete saved calendar view",
      });
    } finally {
      setBusy(false);
    }
  }

  return (
    <section className="card" aria-labelledby="saved-calendar-views-title">
      <div
        style={{
          display: "flex",
          justifyContent: "space-between",
          gap: 12,
          flexWrap: "wrap",
          alignItems: "end",
        }}
      >
        <div>
          <h2 id="saved-calendar-views-title" style={{ marginTop: 0, marginBottom: 4 }}>
            Saved calendar views
          </h2>
          <div className="muted">Personal to you for this site. Current month: {currentMonth}.</div>
        </div>
        <div style={{ display: "flex", gap: 6, alignItems: "end", flexWrap: "wrap" }}>
          <label style={{ display: "grid", gap: 3, fontSize: 12 }}>
            View name
            <input
              value={name}
              onChange={(event) => setName(event.target.value)}
              maxLength={80}
              placeholder="e.g. September shutdown"
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
        {!loading && views.length === 0 ? <span className="muted">No saved calendar views yet.</span> : null}
        {views.map((view) => (
          <span key={view.id} style={{ display: "inline-flex", alignItems: "center", gap: 4 }}>
            <Link className="badge" href={href(view)} style={{ textDecoration: "none" }}>
              {view.name}
            </Link>
            <button
              type="button"
              aria-label={`Delete saved calendar view ${view.name}`}
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
