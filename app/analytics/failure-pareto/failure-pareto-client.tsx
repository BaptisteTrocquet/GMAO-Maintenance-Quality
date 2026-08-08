"use client";

import { useCallback, useEffect, useState, type FormEvent } from "react";

type AssetOption = { id: string; code: string; name: string };
type ParetoPoint = {
  assetId: string;
  code: string;
  name: string;
  eventCount: number;
  downtimeMinutes: number;
  eventSharePercent: number;
  cumulativePercent: number;
};
type ParetoPayload = {
  timezone: string;
  range: { from: string; toExclusive: string };
  assetId: string | null;
  empty: boolean;
  totalEventCount: number;
  rankedEventCount: number;
  points: ParetoPoint[];
  definition: string;
};
type ApiResponse = { data?: ParetoPayload; error?: { message?: string } };

export default function FailureParetoClient({
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
  const [data, setData] = useState<ParetoPayload | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const params = new URLSearchParams({ organizationId, siteId, from, to });
      if (assetId) params.set("assetId", assetId);
      const response = await fetch(`/api/analytics/failure-pareto?${params.toString()}`, {
        cache: "no-store",
      });
      const body = (await response.json()) as ApiResponse;
      if (!response.ok || !body.data) {
        throw new Error(body.error?.message ?? "Unable to load failure Pareto");
      }
      setData(body.data);
    } catch (cause) {
      setData(null);
      setError(cause instanceof Error ? cause.message : "Unable to load failure Pareto");
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
          <div className="grid grid-2 section">
            <section className="card">
              <div className="muted">Corrective events</div>
              <div className="title">{data.totalEventCount}</div>
              <p className="muted">{data.rankedEventCount} represented in the bounded Pareto table.</p>
            </section>
            <section className="card">
              <div className="muted">Assets ranked</div>
              <div className="title">{data.points.length}</div>
              <p className="muted">Top assets by corrective event count.</p>
            </section>
          </div>

          <section className="card section">
            <p className="muted" style={{ margin: 0 }}>{data.definition}</p>
          </section>

          <section className="card responsive-table section">
            <h2>Asset failure Pareto</h2>
            {data.points.length ? (
              <table className="table">
                <thead>
                  <tr>
                    <th>Rank</th>
                    <th>Asset</th>
                    <th>Corrective events</th>
                    <th>Share</th>
                    <th>Cumulative</th>
                    <th>Recorded downtime</th>
                  </tr>
                </thead>
                <tbody>
                  {data.points.map((point, index) => (
                    <tr key={point.assetId}>
                      <td>{index + 1}</td>
                      <td>{point.code} · {point.name}</td>
                      <td>{point.eventCount}</td>
                      <td>{point.eventSharePercent.toFixed(1)}%</td>
                      <td>{point.cumulativePercent.toFixed(1)}%</td>
                      <td>{(point.downtimeMinutes / 60).toFixed(1)} h</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            ) : <p className="muted">No asset-linked corrective events in this reporting window.</p>}
          </section>
        </>
      ) : null}
    </>
  );
}
