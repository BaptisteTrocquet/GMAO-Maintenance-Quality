"use client";

import { useCallback, useEffect, useState, type FormEvent } from "react";

type AssetOption = { id: string; code: string; name: string };
type DowntimePayload = {
  generatedAt: string;
  timezone: string;
  range: { from: string; toExclusive: string };
  assetId: string | null;
  empty: boolean;
  totalMinutes: number;
  totalHours: number;
  eventCount: number;
  averageMinutesPerEvent: number | null;
  trend: Array<{ month: string; eventCount: number; minutes: number; hours: number }>;
  topAssets: Array<{
    assetId: string;
    code: string;
    name: string;
    eventCount: number;
    minutes: number;
    hours: number;
  }>;
  definition: string;
};

type ApiResponse = { data?: DowntimePayload; error?: { message?: string } };

export default function DowntimeClient({
  organizationId,
  siteId,
  timeZone,
  assets,
  defaultFrom,
  defaultTo,
}: {
  organizationId: string;
  siteId: string;
  timeZone: string;
  assets: AssetOption[];
  defaultFrom: string;
  defaultTo: string;
}) {
  const [from, setFrom] = useState(defaultFrom);
  const [to, setTo] = useState(defaultTo);
  const [assetId, setAssetId] = useState("");
  const [data, setData] = useState<DowntimePayload | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const params = new URLSearchParams({ organizationId, siteId, from, to });
      if (assetId) params.set("assetId", assetId);
      const response = await fetch(`/api/analytics/downtime?${params.toString()}`, { cache: "no-store" });
      const body = (await response.json()) as ApiResponse;
      if (!response.ok || !body.data) {
        throw new Error(body.error?.message ?? "Unable to load downtime analytics");
      }
      setData(body.data);
    } catch (cause) {
      setData(null);
      setError(cause instanceof Error ? cause.message : "Unable to load downtime analytics");
    } finally {
      setLoading(false);
    }
  }, [assetId, from, organizationId, siteId, to]);

  useEffect(() => {
    void load();
  }, [load]);

  function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    void load();
  }

  return (
    <>
      <section className="card">
        <form onSubmit={submit} style={{ display: "flex", flexWrap: "wrap", gap: 12, alignItems: "end" }}>
          <label>
            <span className="muted">From ({timeZone})</span>
            <input type="date" value={from} onChange={(event) => setFrom(event.target.value)} required />
          </label>
          <label>
            <span className="muted">Through ({timeZone})</span>
            <input type="date" value={to} onChange={(event) => setTo(event.target.value)} required />
          </label>
          <label>
            <span className="muted">Asset</span>
            <select value={assetId} onChange={(event) => setAssetId(event.target.value)}>
              <option value="">All active assets</option>
              {assets.map((asset) => (
                <option key={asset.id} value={asset.id}>{asset.code} · {asset.name}</option>
              ))}
            </select>
          </label>
          <button type="submit" disabled={loading}>{loading ? "Refreshing…" : "Apply"}</button>
        </form>
      </section>

      {error ? <section className="card section" role="alert">{error}</section> : null}

      {data ? (
        <>
          <div className="grid grid-4 section">
            <section className="card"><div className="muted">Total downtime</div><div className="title">{data.totalHours.toFixed(1)} h</div></section>
            <section className="card"><div className="muted">Downtime events</div><div className="title">{data.eventCount}</div></section>
            <section className="card"><div className="muted">Average / event</div><div className="title">{data.averageMinutesPerEvent === null ? "—" : `${data.averageMinutesPerEvent.toFixed(0)} min`}</div></section>
            <section className="card"><div className="muted">Reporting months</div><div className="title">{data.trend.length}</div></section>
          </div>

          <section className="card section">
            <p className="muted" style={{ margin: 0 }}>{data.definition}</p>
          </section>

          <div className="grid grid-2 section">
            <section className="card responsive-table">
              <h2>Monthly trend</h2>
              {data.trend.length ? (
                <table className="table">
                  <thead><tr><th>Month</th><th>Events</th><th>Downtime</th></tr></thead>
                  <tbody>
                    {data.trend.map((point) => (
                      <tr key={point.month}>
                        <td>{point.month}</td>
                        <td>{point.eventCount}</td>
                        <td>{point.hours.toFixed(1)} h</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              ) : <p className="muted">No completed work orders with recorded downtime in this window.</p>}
            </section>

            <section className="card responsive-table">
              <h2>Top assets by downtime</h2>
              {data.topAssets.length ? (
                <table className="table">
                  <thead><tr><th>Asset</th><th>Events</th><th>Downtime</th></tr></thead>
                  <tbody>
                    {data.topAssets.map((asset) => (
                      <tr key={asset.assetId}>
                        <td>{asset.code} · {asset.name}</td>
                        <td>{asset.eventCount}</td>
                        <td>{asset.hours.toFixed(1)} h</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              ) : <p className="muted">No asset-linked downtime in this window.</p>}
            </section>
          </div>
        </>
      ) : null}
    </>
  );
}
