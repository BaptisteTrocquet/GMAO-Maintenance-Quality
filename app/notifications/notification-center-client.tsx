"use client";

import Link from "next/link";
import { useEffect, useMemo, useState } from "react";
import type { NotificationCenterItem, NotificationSeverity } from "@/lib/notifications/center";

type Props = {
  organizationId: string;
  siteId: string;
};

type SerializedNotification = Omit<NotificationCenterItem, "occurredAt" | "dueAt"> & {
  occurredAt: string;
  dueAt: string | null;
};

type NotificationResponse = {
  data?: { items: SerializedNotification[] };
  error?: { message?: string };
};

const SEVERITY_ORDER: NotificationSeverity[] = ["CRITICAL", "WARNING", "INFO"];

function formatDate(value: string | null) {
  if (!value) return "";
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? "" : date.toLocaleString();
}

export default function NotificationCenterClient({ organizationId, siteId }: Props) {
  const [items, setItems] = useState<SerializedNotification[]>([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (!organizationId || !siteId) {
      setItems([]);
      setLoading(false);
      setError(null);
      return;
    }

    const controller = new AbortController();
    const params = new URLSearchParams({ organizationId, siteId });
    setLoading(true);
    setError(null);
    void fetch(`/api/notifications?${params.toString()}`, { signal: controller.signal })
      .then(async (response) => {
        const body = (await response.json()) as NotificationResponse;
        if (!response.ok) throw new Error(body.error?.message ?? "Notification center failed to load");
        setItems(body.data?.items ?? []);
      })
      .catch((fetchError: unknown) => {
        if (fetchError instanceof DOMException && fetchError.name === "AbortError") return;
        setItems([]);
        setError(fetchError instanceof Error ? fetchError.message : "Notification center failed to load");
      })
      .finally(() => {
        if (!controller.signal.aborted) setLoading(false);
      });
    return () => controller.abort();
  }, [organizationId, siteId]);

  const grouped = useMemo(() => {
    const map = new Map<NotificationSeverity, SerializedNotification[]>();
    for (const item of items) {
      const current = map.get(item.severity) ?? [];
      current.push(item);
      map.set(item.severity, current);
    }
    return map;
  }, [items]);

  if (!organizationId || !siteId) {
    return <section className="card"><p>Select an organization and site to view notifications.</p></section>;
  }

  return (
    <>
      <section className="card" aria-live="polite">
        <strong>{loading ? "Loading notifications…" : `${items.length} active notification${items.length === 1 ? "" : "s"}`}</strong>
        <div className="muted">Operational signals are filtered by your role and selected site.</div>
      </section>

      {error ? <section className="card section" role="alert">{error}</section> : null}
      {!loading && !error && items.length === 0 ? (
        <section className="card section" role="status">No active operational notifications.</section>
      ) : null}

      {SEVERITY_ORDER.map((severity) => {
        const group = grouped.get(severity) ?? [];
        if (!group.length) return null;
        return (
          <section className="card section" key={severity} aria-labelledby={`notification-${severity}`}>
            <div style={{ display: "flex", justifyContent: "space-between", gap: 8, alignItems: "center" }}>
              <h2 id={`notification-${severity}`} style={{ margin: 0 }}>{severity}</h2>
              <span className="badge">{group.length}</span>
            </div>
            <div className="stack-list" style={{ marginTop: 12 }}>
              {group.map((item) => (
                <article key={item.key} style={{ display: "grid", gap: 4 }}>
                  <Link className="table-link" href={item.href}><strong>{item.title}</strong></Link>
                  <div>{item.description}</div>
                  <div className="muted">
                    {item.kind.replaceAll("_", " ")}
                    {item.dueAt ? ` · due ${formatDate(item.dueAt)}` : ""}
                  </div>
                </article>
              ))}
            </div>
          </section>
        );
      })}
    </>
  );
}
