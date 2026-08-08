"use client";

import { useCallback, useEffect, useState, type FormEvent } from "react";

type AssetOption = { id: string; code: string; name: string };
type LaborPoint = {
  id: string;
  kind: "PERSON" | "TEAM";
  label: string;
  workOrderCount: number;
  minutes: number;
  hours: number;
  sharePercent: number;
};
type LaborPayload = {
  timezone: string;
  range: { from: string; toExclusive: string };
  assetId: string | null;
  empty: boolean;
  completedWorkOrders: number;
  recordedWorkOrders: number;
  excludedMissingLabor: number;
  captureCoveragePercent: number | null;
  totalMinutes: number;
  totalHours: number;
  personMinutes: number;
  teamMinutes: number;
  unassignedMinutes: number;
  attributedPercent: number | null;
  people: LaborPoint[];
  teams: LaborPoint[];
  definition: string;
};
type ApiResponse = { data?: LaborPayload; error?: { message?: string } };

function percent(value: number | null) {
  return value === null ? "—" : `${value.toFixed(1)}%`;
}

export default function LaborUtilizationClient({
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
  const [data, setData] = useState<LaborPayload | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const params = new URLSearchParams({ organizationId, siteId, from, to });
      if (assetId) params.set("assetId", assetId);
      const response = await fetch(`/api/analytics/labor-utilization?${params.toString()}`, {
        cache: "no-store",
      });
      const body = (await response.json()) as ApiResponse;
      if (!response.ok || !body.data) {
        throw new Error(body.error?.message ?? "Unable to load labor utilization analytics");
      }
      setData(body.data);
    } catch (cause) {
      setData(null);
      setError(cause instanceof Error ? cause.message : "Unable to load labor utilization analytics");
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
          <section className="card section">
            <p className="muted" style={{ margin: 0 }}>{data.definition}</p>
          </section>

          <div className="grid grid-4 section">
            <section className="card"><div className="muted">Recorded labor</div><div className="title">{data.totalHours.toFixed(1)} h</div></section>
            <section className="card"><div className="muted">Capture coverage</div><div className="title">{percent(data.captureCoveragePercent)}</div><p className="muted">{data.recordedWorkOrders}/{data.completedWorkOrders} completed WOs</p></section>
            <section className="card"><div className="muted">Attributed labor</div><div className="title">{percent(data.attributedPercent)}</div><p className="muted">Person or team</p></section>
            <section className="card"><div className="muted">Unassigned labor</div><div className="title">{(data.unassignedMinutes / 60).toFixed(1)} h</div><p className="muted">{data.excludedMissingLabor} completed WOs missing positive labor</p></section>
          </div>

          <div className="grid grid-2 section">
            <section className="card responsive-table">
              <h2>People · recorded labor share</h2>
              {data.people.length ? (
                <table className="table">
                  <thead><tr><th>Person</th><th>WO</th><th>Hours</th><th>Share</th></tr></thead>
                  <tbody>
                    {data.people.map((point) => (
                      <tr key={point.id}><td>{point.label}</td><td>{point.workOrderCount}</td><td>{point.hours.toFixed(1)}</td><td>{point.sharePercent.toFixed(1)}%</td></tr>
                    ))}
                  </tbody>
                </table>
              ) : <p className="muted">No person-attributed labor in this range.</p>}
            </section>

            <section className="card responsive-table">
              <h2>Teams · recorded labor share</h2>
              {data.teams.length ? (
                <table className="table">
                  <thead><tr><th>Team</th><th>WO</th><th>Hours</th><th>Share</th></tr></thead>
                  <tbody>
                    {data.teams.map((point) => (
                      <tr key={point.id}><td>{point.label}</td><td>{point.workOrderCount}</td><td>{point.hours.toFixed(1)}</td><td>{point.sharePercent.toFixed(1)}%</td></tr>
                    ))}
                  </tbody>
                </table>
              ) : <p className="muted">No team-only labor in this range.</p>}
            </section>
          </div>
        </>
      ) : null}
    </>
  );
}
