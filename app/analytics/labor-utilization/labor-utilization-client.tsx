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
  weeklyCapacityMinutes?: number | null;
  capacityMinutes?: number | null;
  utilizationPercent?: number | null;
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
  capacityMode: "CONFIGURED_BASELINE" | "RECORDED_ONLY";
  businessDays: number;
  configuredCapacityUsers: number;
  capacityMinutes: number;
  capacityHours: number;
  capacityCoveredLaborMinutes: number;
  capacityCoveragePercent: number | null;
  utilizationPercent: number | null;
  definition: string;
};
type ApiResponse = { data?: LaborPayload; error?: { message?: string } };

function percent(value: number | null | undefined) {
  return value === null || value === undefined ? "—" : `${value.toFixed(1)}%`;
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
            <section className="card"><div className="muted">Baseline utilization</div><div className="title">{percent(data.utilizationPercent)}</div><p className="muted">{data.capacityMode === "CONFIGURED_BASELINE" ? `${data.configuredCapacityUsers} configured user${data.configuredCapacityUsers === 1 ? "" : "s"}` : "Capacity not configured"}</p></section>
            <section className="card"><div className="muted">Baseline capacity</div><div className="title">{data.capacityMode === "CONFIGURED_BASELINE" ? `${data.capacityHours.toFixed(1)} h` : "—"}</div><p className="muted">{data.businessDays} weekday{data.businessDays === 1 ? "" : "s"}</p></section>
            <section className="card"><div className="muted">Person-labor capacity coverage</div><div className="title">{percent(data.capacityCoveragePercent)}</div><p className="muted">Assigned labor covered by a capacity profile</p></section>
            <section className="card"><div className="muted">Recorded labor</div><div className="title">{data.totalHours.toFixed(1)} h</div></section>
          </div>

          <div className="grid grid-3 section">
            <section className="card"><div className="muted">Capture coverage</div><div className="title">{percent(data.captureCoveragePercent)}</div><p className="muted">{data.recordedWorkOrders}/{data.completedWorkOrders} completed WOs</p></section>
            <section className="card"><div className="muted">Attributed labor</div><div className="title">{percent(data.attributedPercent)}</div><p className="muted">Person or team</p></section>
            <section className="card"><div className="muted">Unassigned labor</div><div className="title">{(data.unassignedMinutes / 60).toFixed(1)} h</div><p className="muted">{data.excludedMissingLabor} completed WOs missing positive labor</p></section>
          </div>

          <div className="grid grid-2 section">
            <section className="card responsive-table">
              <h2>People · labor and capacity</h2>
              {data.people.length ? (
                <table className="table">
                  <thead><tr><th>Person</th><th>WO</th><th>Hours</th><th>Share</th><th>Weekly baseline</th><th>Window capacity</th><th>Utilization</th></tr></thead>
                  <tbody>
                    {data.people.map((point) => (
                      <tr key={point.id}>
                        <td>{point.label}</td><td>{point.workOrderCount}</td><td>{point.hours.toFixed(1)}</td><td>{point.sharePercent.toFixed(1)}%</td>
                        <td>{point.weeklyCapacityMinutes == null ? "—" : `${(point.weeklyCapacityMinutes / 60).toFixed(1)} h`}</td>
                        <td>{point.capacityMinutes == null ? "—" : `${(point.capacityMinutes / 60).toFixed(1)} h`}</td>
                        <td>{percent(point.utilizationPercent)}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              ) : <p className="muted">No person-attributed labor or configured capacity in this range.</p>}
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
