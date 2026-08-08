"use client";

import { useCallback, useEffect, useState, type FormEvent } from "react";

type AssetOption = { id: string; code: string; name: string };
type LaborPayload = {
  generatedAt: string;
  timezone: string;
  range: { from: string; toExclusive: string };
  assetId: string | null;
  empty: boolean;
  completedWorkOrders: number;
  recordedWorkOrders: number;
  recordingCoveragePercent: number | null;
  laborMinutes: number;
  laborHours: number;
  unassignedLaborMinutes: number;
  unassignedSharePercent: number | null;
  capacityMode: "CONFIGURED_BASELINE" | "RECORDED_ONLY";
  businessDays: number;
  configuredCapacityUsers: number;
  capacityMinutes: number;
  capacityHours: number;
  capacityCoveredLaborMinutes: number;
  capacityCoveragePercent: number | null;
  utilizationPercent: number | null;
  assignees: Array<{
    assigneeId: string | null;
    displayName: string;
    workOrderCount: number;
    laborMinutes: number;
    laborHours: number;
    recordedLaborSharePercent: number;
    weeklyCapacityMinutes: number | null;
    capacityMinutes: number | null;
    utilizationPercent: number | null;
  }>;
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
        throw new Error(body.error?.message ?? "Unable to load labor analytics");
      }
      setData(body.data);
    } catch (cause) {
      setData(null);
      setError(cause instanceof Error ? cause.message : "Unable to load labor analytics");
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
            <section className="card">
              <div className="muted">Baseline utilization</div>
              <div className="title">{percent(data.utilizationPercent)}</div>
              <div className="muted">
                {data.capacityMode === "CONFIGURED_BASELINE"
                  ? `${data.configuredCapacityUsers} configured user${data.configuredCapacityUsers === 1 ? "" : "s"}`
                  : "Capacity not configured"}
              </div>
            </section>
            <section className="card">
              <div className="muted">Baseline capacity</div>
              <div className="title">{data.capacityMode === "CONFIGURED_BASELINE" ? `${data.capacityHours.toFixed(1)} h` : "—"}</div>
              <div className="muted">{data.businessDays} weekday{data.businessDays === 1 ? "" : "s"}</div>
            </section>
            <section className="card">
              <div className="muted">Capacity coverage</div>
              <div className="title">{percent(data.capacityCoveragePercent)}</div>
              <div className="muted">Share of assigned recorded labor covered by a capacity profile</div>
            </section>
            <section className="card">
              <div className="muted">Recorded labor</div>
              <div className="title">{data.laborHours.toFixed(1)} h</div>
              <div className="muted">{data.completedWorkOrders} completed work order{data.completedWorkOrders === 1 ? "" : "s"}</div>
            </section>
          </div>

          <div className="grid grid-2 section">
            <section className="card">
              <div className="muted">Labor recording coverage</div>
              <div className="title">{percent(data.recordingCoveragePercent)}</div>
              <div className="muted">{data.recordedWorkOrders} completed work orders with positive laborMinutes</div>
            </section>
            <section className="card">
              <div className="muted">Unassigned recorded labor</div>
              <div className="title">{percent(data.unassignedSharePercent)}</div>
              <div className="muted">{(data.unassignedLaborMinutes / 60).toFixed(1)} h</div>
            </section>
          </div>

          <section className="card section">
            <h2>Definition</h2>
            <p className="muted" style={{ marginBottom: 0 }}>{data.definition}</p>
          </section>

          <section className="card responsive-table section">
            <h2>Labor by assignee</h2>
            {data.assignees.length ? (
              <table className="table">
                <thead>
                  <tr>
                    <th>Assignee</th>
                    <th>Completed work with labor</th>
                    <th>Recorded labor</th>
                    <th>Weekly baseline</th>
                    <th>Window capacity</th>
                    <th>Utilization</th>
                    <th>Share of recorded labor</th>
                  </tr>
                </thead>
                <tbody>
                  {data.assignees.map((row) => (
                    <tr key={row.assigneeId ?? "unassigned"}>
                      <td>{row.displayName}</td>
                      <td>{row.workOrderCount}</td>
                      <td>{row.laborHours.toFixed(1)} h</td>
                      <td>{row.weeklyCapacityMinutes === null ? "—" : `${(row.weeklyCapacityMinutes / 60).toFixed(1)} h`}</td>
                      <td>{row.capacityMinutes === null ? "—" : `${(row.capacityMinutes / 60).toFixed(1)} h`}</td>
                      <td>{percent(row.utilizationPercent)}</td>
                      <td>{row.recordedLaborSharePercent.toFixed(1)}%</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            ) : <p className="muted">No positive laborMinutes or configured capacity profiles in this window.</p>}
          </section>
        </>
      ) : null}
    </>
  );
}
