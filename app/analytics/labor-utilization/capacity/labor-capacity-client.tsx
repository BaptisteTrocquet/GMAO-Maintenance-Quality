"use client";

import { useCallback, useEffect, useMemo, useState, type FormEvent } from "react";

type EligibleUser = { id: string; displayName: string };
type CapacityProfile = {
  userId: string;
  displayName: string;
  weeklyCapacityMinutes: number;
};
type CapacityPayload = {
  users: EligibleUser[];
  profiles: CapacityProfile[];
};
type ApiResponse = {
  data?: CapacityPayload;
  error?: { message?: string };
};

export default function LaborCapacityClient({
  organizationId,
  siteId,
}: {
  organizationId: string;
  siteId: string;
}) {
  const [payload, setPayload] = useState<CapacityPayload>({ users: [], profiles: [] });
  const [userId, setUserId] = useState("");
  const [weeklyHours, setWeeklyHours] = useState("35");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [message, setMessage] = useState<string | null>(null);

  const endpoint = useMemo(() => {
    const params = new URLSearchParams({ organizationId, siteId });
    return `/api/analytics/labor-capacity?${params.toString()}`;
  }, [organizationId, siteId]);

  const load = useCallback(async () => {
    setBusy(true);
    setError(null);
    try {
      const response = await fetch(endpoint, { cache: "no-store" });
      const body = (await response.json()) as ApiResponse;
      if (!response.ok || !body.data) {
        throw new Error(body.error?.message ?? "Unable to load labor capacity profiles");
      }
      setPayload(body.data);
      setUserId((current) => current || body.data?.users[0]?.id || "");
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "Unable to load labor capacity profiles");
    } finally {
      setBusy(false);
    }
  }, [endpoint]);

  useEffect(() => {
    void load();
  }, [load]);

  async function save(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const hours = Number(weeklyHours);
    if (!userId || !Number.isFinite(hours) || hours <= 0 || hours > 168) {
      setError("Choose a maintenance user and a weekly capacity between 0 and 168 hours.");
      return;
    }

    setBusy(true);
    setError(null);
    setMessage(null);
    try {
      const response = await fetch("/api/analytics/labor-capacity", {
        method: "PATCH",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          organizationId,
          siteId,
          userId,
          weeklyCapacityMinutes: Math.round(hours * 60),
        }),
      });
      const body = (await response.json()) as { error?: { message?: string } };
      if (!response.ok) throw new Error(body.error?.message ?? "Unable to save labor capacity");
      setMessage("Capacity baseline saved.");
      await load();
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "Unable to save labor capacity");
      setBusy(false);
    }
  }

  async function disable(profile: CapacityProfile) {
    setBusy(true);
    setError(null);
    setMessage(null);
    try {
      const response = await fetch("/api/analytics/labor-capacity", {
        method: "PATCH",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          organizationId,
          siteId,
          userId: profile.userId,
          weeklyCapacityMinutes: null,
        }),
      });
      const body = (await response.json()) as { error?: { message?: string } };
      if (!response.ok) throw new Error(body.error?.message ?? "Unable to disable labor capacity");
      setMessage("Capacity baseline disabled.");
      await load();
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "Unable to disable labor capacity");
      setBusy(false);
    }
  }

  return (
    <>
      <section className="card">
        <h2>Configure weekly baseline</h2>
        <p className="muted">
          Capacity is a planning baseline used for analytics. It is prorated across Monday-Friday and does not infer holidays, leave or shift timing.
        </p>
        <form onSubmit={save} style={{ display: "flex", flexWrap: "wrap", gap: 12, alignItems: "end" }}>
          <label>
            <span className="muted">Maintenance user</span>
            <select value={userId} onChange={(event) => setUserId(event.target.value)} required>
              <option value="">Select user</option>
              {payload.users.map((user) => (
                <option key={user.id} value={user.id}>{user.displayName}</option>
              ))}
            </select>
          </label>
          <label>
            <span className="muted">Hours / week</span>
            <input
              type="number"
              min="0.1"
              max="168"
              step="0.25"
              value={weeklyHours}
              onChange={(event) => setWeeklyHours(event.target.value)}
              required
            />
          </label>
          <button type="submit" disabled={busy || !userId}>{busy ? "Saving…" : "Save baseline"}</button>
        </form>
        {message ? <p role="status">{message}</p> : null}
        {error ? <p role="alert">{error}</p> : null}
      </section>

      <section className="card responsive-table section">
        <h2>Active capacity profiles</h2>
        {payload.profiles.length ? (
          <table className="table">
            <thead>
              <tr>
                <th>User</th>
                <th>Weekly capacity</th>
                <th>Action</th>
              </tr>
            </thead>
            <tbody>
              {payload.profiles.map((profile) => (
                <tr key={profile.userId}>
                  <td>{profile.displayName}</td>
                  <td>{(profile.weeklyCapacityMinutes / 60).toFixed(2)} h</td>
                  <td>
                    <button type="button" disabled={busy} onClick={() => void disable(profile)}>
                      Disable
                    </button>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        ) : (
          <p className="muted">No capacity baseline configured yet.</p>
        )}
      </section>
    </>
  );
}
