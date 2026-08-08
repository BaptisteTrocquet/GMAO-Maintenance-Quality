"use client";

import Link from "next/link";
import { usePathname, useSearchParams } from "next/navigation";
import { FormEvent, useCallback, useEffect, useMemo, useState } from "react";

type SavedView = {
  id: string;
  name: string;
  path: "/maintenance/kanban" | "/maintenance/calendar" | "/maintenance/workload";
  query: string;
};

const SAVABLE_PATHS = new Set([
  "/maintenance/kanban",
  "/maintenance/calendar",
  "/maintenance/workload",
]);

function href(view: SavedView) {
  return view.query ? `${view.path}?${view.query}` : view.path;
}

export default function SavedPlanningViews({ organizationId }: { organizationId: string }) {
  const pathname = usePathname();
  const searchParams = useSearchParams();
  const [views, setViews] = useState<SavedView[]>([]);
  const [name, setName] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const canSaveCurrent = Boolean(organizationId && SAVABLE_PATHS.has(pathname));
  const currentQuery = useMemo(() => searchParams.toString(), [searchParams]);

  const loadViews = useCallback(async () => {
    if (!organizationId) {
      setViews([]);
      return;
    }
    try {
      const response = await fetch(
        `/api/maintenance/saved-views?organizationId=${encodeURIComponent(organizationId)}`,
        { cache: "no-store" },
      );
      const body = (await response.json()) as {
        data?: SavedView[];
        error?: { message?: string };
      };
      if (!response.ok) throw new Error(body.error?.message ?? "Unable to load saved views");
      setViews(body.data ?? []);
    } catch (loadError) {
      setError(loadError instanceof Error ? loadError.message : "Unable to load saved views");
    }
  }, [organizationId]);

  useEffect(() => {
    void loadViews();
  }, [loadViews]);

  async function saveCurrent(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!canSaveCurrent || !name.trim()) return;
    setBusy(true);
    setError(null);
    try {
      const response = await fetch("/api/maintenance/saved-views", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          organizationId,
          name: name.trim(),
          path: pathname,
          query: currentQuery,
        }),
      });
      const body = (await response.json()) as {
        data?: SavedView;
        error?: { message?: string };
      };
      if (!response.ok || !body.data) {
        throw new Error(body.error?.message ?? "Unable to save planning view");
      }
      setName("");
      await loadViews();
    } catch (saveError) {
      setError(saveError instanceof Error ? saveError.message : "Unable to save planning view");
    } finally {
      setBusy(false);
    }
  }

  async function remove(viewId: string) {
    setBusy(true);
    setError(null);
    try {
      const response = await fetch(`/api/maintenance/saved-views/${encodeURIComponent(viewId)}`, {
        method: "DELETE",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ organizationId }),
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

  if (!organizationId) return null;

  return (
    <section className="card" aria-labelledby="saved-planning-views-title" style={{ marginBottom: 16 }}>
      <div style={{ display: "flex", justifyContent: "space-between", gap: 12, flexWrap: "wrap" }}>
        <div>
          <strong id="saved-planning-views-title">Saved planning views</strong>
          <div className="muted" style={{ fontSize: 12 }}>
            Personal to your account and current organization. Site context stays active when a view opens.
          </div>
        </div>
        {canSaveCurrent ? (
          <form onSubmit={saveCurrent} style={{ display: "flex", gap: 6, flexWrap: "wrap" }}>
            <label>
              <span className="sr-only">Saved view name</span>
              <input
                value={name}
                maxLength={60}
                onChange={(event) => setName(event.target.value)}
                placeholder="View name"
                disabled={busy}
                aria-label="Saved view name"
              />
            </label>
            <button type="submit" disabled={busy || !name.trim()}>
              Save current view
            </button>
          </form>
        ) : null}
      </div>

      {error ? <p role="alert" style={{ marginBottom: 0 }}>{error}</p> : null}

      {views.length ? (
        <div style={{ display: "flex", gap: 8, flexWrap: "wrap", marginTop: 10 }}>
          {views.map((view) => (
            <span
              key={view.id}
              style={{ display: "inline-flex", gap: 4, alignItems: "center" }}
            >
              <Link className="table-link" href={href(view)}>{view.name}</Link>
              <button
                type="button"
                onClick={() => void remove(view.id)}
                disabled={busy}
                aria-label={`Delete saved view ${view.name}`}
                title={`Delete ${view.name}`}
              >
                ×
              </button>
            </span>
          ))}
        </div>
      ) : (
        <p className="muted" style={{ marginBottom: 0 }}>No saved planning views yet.</p>
      )}
    </section>
  );
}
