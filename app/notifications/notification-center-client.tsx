"use client";

import Link from "next/link";
import { useCallback, useEffect, useMemo, useState } from "react";

type NotificationItem = {
  id: string;
  kind: "MAINTENANCE_REMINDER" | "OVERDUE_WORK_ORDER" | "REORDER_ALERT" | "QUALITY_ALERT";
  severity: "CRITICAL" | "HIGH" | "NORMAL";
  title: string;
  detail: string;
  href: string;
  occurredAt: string;
  dismissible: boolean;
  sourceId: string;
};

type NotificationPayload = {
  items: NotificationItem[];
  truncated: boolean;
  counts: { total: number; critical: number; high: number; normal: number };
};

function kindLabel(kind: NotificationItem["kind"]) {
  return kind.replaceAll("_", " ").toLowerCase();
}

export default function NotificationCenterClient({
  organizationId,
  siteId,
}: {
  organizationId: string;
  siteId: string;
}) {
  const [payload, setPayload] = useState<NotificationPayload | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const endpoint = useMemo(
    () => `/api/notifications?organizationId=${encodeURIComponent(organizationId)}&siteId=${encodeURIComponent(siteId)}`,
    [organizationId, siteId],
  );

  const load = useCallback(async () => {
    setBusy(true);
    setError(null);
    try {
      const response = await fetch(endpoint, { cache: "no-store" });
      const body = (await response.json()) as {
        data?: NotificationPayload;
        error?: { message?: string };
      };
      if (!response.ok || !body.data) {
        throw new Error(body.error?.message ?? "Unable to load notifications");
      }
      setPayload(body.data);
    } catch (loadError) {
      setError(loadError instanceof Error ? loadError.message : "Unable to load notifications");
    } finally {
      setBusy(false);
    }
  }, [endpoint]);

  useEffect(() => {
    void load();
  }, [load]);

  async function dismiss(item: NotificationItem) {
    if (!item.dismissible || item.kind !== "MAINTENANCE_REMINDER") return;
    setBusy(true);
    setError(null);
    try {
      const response = await fetch(`/api/maintenance-reminders/${encodeURIComponent(item.sourceId)}`, {
        method: "PATCH",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ organizationId, siteId }),
      });
      const body = (await response.json()) as { error?: { message?: string } };
      if (!response.ok) throw new Error(body.error?.message ?? "Unable to dismiss reminder");
      await load();
    } catch (dismissError) {
      setError(dismissError instanceof Error ? dismissError.message : "Unable to dismiss reminder");
      setBusy(false);
    }
  }

  return (
    <>
      <section className="card" style={{ marginBottom: 16 }}>
        <div style={{ display: "flex", justifyContent: "space-between", gap: 12, flexWrap: "wrap" }}>
          <div>
            <strong>Operational notifications</strong>
            <div className="muted">Permission-aware alerts for the selected site.</div>
          </div>
          <button type="button" onClick={() => void load()} disabled={busy}>
            {busy ? "Refreshing…" : "Refresh"}
          </button>
        </div>
        {payload ? (
          <div style={{ display: "flex", gap: 8, flexWrap: "wrap", marginTop: 10 }}>
            <span className="badge">{payload.counts.total} total</span>
            <span className="badge">{payload.counts.critical} critical</span>
            <span className="badge">{payload.counts.high} high</span>
            <span className="badge">{payload.counts.normal} normal</span>
            {payload.truncated ? <span className="badge">bounded list</span> : null}
          </div>
        ) : null}
      </section>

      {error ? <section className="card" role="alert">{error}</section> : null}

      {payload && !payload.items.length ? (
        <section className="card" role="status">No active notifications for the current scope.</section>
      ) : null}

      {payload?.items.length ? (
        <div className="stack-list">
          {payload.items.map((item) => (
            <article className="card" key={item.id} style={{ display: "grid", gap: 8 }}>
              <div style={{ display: "flex", justifyContent: "space-between", gap: 10, flexWrap: "wrap" }}>
                <div>
                  <div style={{ display: "flex", gap: 6, flexWrap: "wrap", marginBottom: 4 }}>
                    <span className="badge">{item.severity}</span>
                    <span className="badge">{kindLabel(item.kind)}</span>
                  </div>
                  <Link className="table-link" href={item.href}><strong>{item.title}</strong></Link>
                  <div className="muted">{item.detail}</div>
                </div>
                {item.dismissible ? (
                  <button type="button" disabled={busy} onClick={() => void dismiss(item)}>
                    Dismiss
                  </button>
                ) : null}
              </div>
            </article>
          ))}
        </div>
      ) : null}
    </>
  );
}
