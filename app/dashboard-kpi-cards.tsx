"use client";

import { useEffect, useMemo, useState } from "react";

const KPI_KEYS = [
  "OPEN_WORK",
  "BLOCKED_WORK",
  "OVERDUE_WORK",
  "DUE_SOON_WORK",
  "URGENT_WORK",
  "PENDING_APPROVALS",
] as const;
type KpiKey = (typeof KPI_KEYS)[number];

type Metrics = {
  openWork: number;
  blockedWork: number;
  overdueWork: number;
  dueSoonWork: number;
  urgentWork: number;
  pendingApprovals: number;
};

type ConfigResponse = {
  data?: { cards: KpiKey[] };
  error?: { message?: string };
};

const META: Record<KpiKey, { label: string; metric: keyof Metrics }> = {
  OPEN_WORK: { label: "My open work", metric: "openWork" },
  BLOCKED_WORK: { label: "Blocked", metric: "blockedWork" },
  OVERDUE_WORK: { label: "Overdue", metric: "overdueWork" },
  DUE_SOON_WORK: { label: "Due ≤ 7 days", metric: "dueSoonWork" },
  URGENT_WORK: { label: "Urgent", metric: "urgentWork" },
  PENDING_APPROVALS: { label: "Pending approvals", metric: "pendingApprovals" },
};

function move(cards: KpiKey[], index: number, direction: -1 | 1) {
  const target = index + direction;
  if (target < 0 || target >= cards.length) return cards;
  const next = [...cards];
  [next[index], next[target]] = [next[target], next[index]];
  return next;
}

export default function DashboardKpiCards({
  organizationId,
  siteId,
  metrics,
}: {
  organizationId: string;
  siteId: string;
  metrics: Metrics;
}) {
  const [cards, setCards] = useState<KpiKey[]>([...KPI_KEYS]);
  const [draft, setDraft] = useState<KpiKey[]>([...KPI_KEYS]);
  const [saving, setSaving] = useState(false);
  const [message, setMessage] = useState<string | null>(null);

  useEffect(() => {
    const controller = new AbortController();
    const params = new URLSearchParams({ organizationId, siteId });
    void fetch(`/api/dashboard/kpi-cards?${params.toString()}`, {
      signal: controller.signal,
      cache: "no-store",
    })
      .then(async (response) => {
        const body = (await response.json()) as ConfigResponse;
        if (!response.ok || !body.data) throw new Error(body.error?.message ?? "Unable to load KPI card settings");
        setCards(body.data.cards);
        setDraft(body.data.cards);
      })
      .catch((error: unknown) => {
        if (error instanceof DOMException && error.name === "AbortError") return;
        setMessage(error instanceof Error ? error.message : "Unable to load KPI card settings");
      });
    return () => controller.abort();
  }, [organizationId, siteId]);

  const selected = useMemo(() => new Set(draft), [draft]);

  function toggle(key: KpiKey) {
    setDraft((current) => {
      if (current.includes(key)) return current.filter((item) => item !== key);
      return [...current, key];
    });
    setMessage(null);
  }

  async function save() {
    setSaving(true);
    setMessage(null);
    try {
      const response = await fetch("/api/dashboard/kpi-cards", {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ organizationId, siteId, cards: draft }),
      });
      const body = (await response.json()) as ConfigResponse;
      if (!response.ok || !body.data) throw new Error(body.error?.message ?? "Unable to save KPI card settings");
      setCards(body.data.cards);
      setDraft(body.data.cards);
      setMessage("KPI cards saved.");
    } catch (error) {
      setMessage(error instanceof Error ? error.message : "Unable to save KPI card settings");
    } finally {
      setSaving(false);
    }
  }

  return (
    <>
      {cards.length ? (
        <div className="grid grid-4">
          {cards.map((key) => (
            <div className="card" key={key}>
              <div className="muted">{META[key].label}</div>
              <div className="metric">{metrics[META[key].metric]}</div>
            </div>
          ))}
        </div>
      ) : (
        <section className="card"><p className="muted">No KPI cards selected.</p></section>
      )}

      <details className="card section">
        <summary>Customize KPI cards</summary>
        <p className="muted">Choose which personal KPI cards appear and their display order for this site.</p>
        <div className="stack-list">
          {KPI_KEYS.map((key) => {
            const index = draft.indexOf(key);
            return (
              <div key={key} style={{ display: "flex", gap: 8, alignItems: "center", flexWrap: "wrap" }}>
                <label style={{ flex: 1 }}>
                  <input type="checkbox" checked={selected.has(key)} onChange={() => toggle(key)} />{" "}
                  {META[key].label}
                </label>
                {index >= 0 ? (
                  <>
                    <button type="button" onClick={() => setDraft((current) => move(current, index, -1))} disabled={index === 0} aria-label={`Move ${META[key].label} up`}>↑</button>
                    <button type="button" onClick={() => setDraft((current) => move(current, index, 1))} disabled={index === draft.length - 1} aria-label={`Move ${META[key].label} down`}>↓</button>
                  </>
                ) : null}
              </div>
            );
          })}
        </div>
        <div style={{ marginTop: 12, display: "flex", gap: 12, alignItems: "center" }}>
          <button type="button" onClick={() => void save()} disabled={saving}>{saving ? "Saving…" : "Save cards"}</button>
          {message ? <span role="status" className="muted">{message}</span> : null}
        </div>
      </details>
    </>
  );
}
