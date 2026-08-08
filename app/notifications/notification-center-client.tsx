"use client";

import Link from "next/link";
import { useCallback, useEffect, useMemo, useState } from "react";
import type { NotificationKind, NotificationSeverity } from "@/lib/notifications/center";

type NotificationItem = {
  key: string;
  kind: NotificationKind;
  severity: NotificationSeverity;
  title: string;
  description: string;
  href: string;
  occurredAt: string;
  dueAt: string | null;
};

type Props = {
  organizationId: string;
  siteId: string;
};

type ResponseBody = {
  data?: { items: NotificationItem[] };
  error?: { message?: string };
};

function dateLabel(value: string | null) {
  if (!value) return "";
  return new Intl.DateTimeFormat("en", {
    dateStyle: "medium",
    timeStyle: "short",
  }).format(new Date(value));
}

function kindLabel(kind: NotificationKind) {
  switch (kind) {
    case "WORK_OVERDUE":
      return "Overdue work";
    case "WORK_DUE_SOON":
      return "Due soon";
    case "MAINTENANCE_REMINDER":
      return "Maintenance reminder";
    case "REORDER":
      return "Reorder";
  }
}

export default function NotificationCenterClient({ organizationId, siteId }: Props) {
  const [items, setItems] = useState<NotificationItem[]>([]);
  const [filter, setFilter] = useState<"ALL" | NotificationSeverity>("ALL");
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(async (signal?: AbortSignal) => {
    const query = new URLSearchParams({ organizationId, siteId });
    const response = await fetch(`/api/notifications?${query.toString()}`, { signal });
    const body = (await response.json()) as ResponseBody;
    if (!response.ok) throw new Error(body.error?.message ?? "Notifications could not be loaded");
    setItems(body.data?.items ?? []);
  }, [organizationId, siteId]);

  useEffect(() => {
    if (!organizationId || !siteId) {
      setItems([]);
      setLoading(false);
      return;
    }
    const controller = new AbortController();
    setLoading(true);
    setError(null);
    void load(controller.signal)
      .catch((loadError: unknown) => {
        if (loadError instanceof DOMException && loadError.name === "AbortError") return;
        setError(loadError instanceof Error ? loadError.message : "Notifications could not be loaded");
      })
      .finally(() => {
        if (!controller.signal.aborted) setLoading(false);
      });
    return () => controller.abort();
  }, [load, organizationId, siteId]);

  const counts = useMemo(() => ({
    CRITICAL: items.filter((item) => item.severity === "CRITICAL").length,
    WARNING: items.filter((item) => item.severity === "WARNING").length,
    INFO: items.filter((item) => item.severity === "INFO").length,
  }), [items]);
  const visible = filter === "ALL" ? items : items.filter((item) => item.severity === filter);

  if (!organizationId || !siteId) {
    return <section className="card"><p>Select an organization and site to view notifications.</p></section>;
  }

  return (
    <>
      <section className="card" aria-label="Notification filters">
        <div style={{ display: "flex", justifyContent: "space-between", gap: 10, flexWrap: "wrap" }}>
          <div style={{ display: "flex", gap: 8, flexWrap: "wrap" }}>
            {(["ALL", "CRITICAL", "WARNING", "INFO"] as const).map((value) => (
              <button
                key={value}
                type="button"
                aria-pressed={filter === value}
                onClick={() => setFilter(value)}
              >
                {value === "ALL" ? `All ${items.length}` : `${value.toLowerCase()} ${counts[value]}`}
              </button>
            ))}
          </div>
          <button
            type="button"
            disabled={loading}
            onClick={() => {
              setLoading(true);
              setError(null);
              void load()
                .catch((loadError: unknown) => {
                  setError(loadError instanceof Error ? loadError.message : "Notifications could not be loaded");
                })
                .finally(() => setLoading(false));
            }}
          >
            {loading ? "Refreshing…" : "Refresh"}
          </button>
        </div>
        <p className="muted" style={{ marginBottom: 0 }}>
          This center shows live operational signals you can access. It does not hide site-wide alerts when another user opens them.
        </p>
      </section>

      {error ? <section className="card section" role="alert">{error}</section> : null}

      <section className="section" aria-live="polite" aria-busy={loading}>
        {loading && items.length === 0 ? <div className="card muted">Loading notifications…</div> : null}
        {!loading && !error && visible.length === 0 ? (
          <div className="card muted">No notifications in this severity.</div>
        ) : null}
        <div className="stack-list" style={{ display: "grid", gap: 10 }}>
          {visible.map((item) => (
            <article className="card" key={item.key} style={{ display: "grid", gap: 7 }}>
              <div style={{ display: "flex", justifyContent: "space-between", gap: 10, flexWrap: "wrap" }}>
                <Link className="table-link" href={item.href}><strong>{item.title}</strong></Link>
                <div style={{ display: "flex", gap: 6, flexWrap: "wrap" }}>
                  <span className="badge">{item.severity}</span>
                  <span className="badge">{kindLabel(item.kind)}</span>
                </div>
              </div>
              <div>{item.description}</div>
              <div className="muted">
                {item.dueAt ? `Due ${dateLabel(item.dueAt)}` : `Updated ${dateLabel(item.occurredAt)}`}
              </div>
            </article>
          ))}
        </div>
      </section>
    </>
  );
}
