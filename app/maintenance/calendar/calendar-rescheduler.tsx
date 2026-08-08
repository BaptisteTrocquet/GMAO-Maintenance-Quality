"use client";

import { FormEvent, useEffect, useMemo, useState } from "react";
import { useRouter } from "next/navigation";

type WorkOrderOption = { id: string; label: string };

type Props = {
  organizationId: string;
  siteId: string;
};

function workOrderIdFromHref(href: string) {
  const url = new URL(href, window.location.origin);
  const match = url.pathname.match(/^\/maintenance\/([^/]+)$/);
  if (!match) return null;
  const value = decodeURIComponent(match[1]);
  if (value === "kanban" || value === "calendar" || value === "board") return null;
  return value;
}

function dropDateFromLabel(label: string | null) {
  const match = label?.match(/^(\d{4}-\d{2}-\d{2}),/);
  return match?.[1] ?? null;
}

export default function CalendarRescheduler({ organizationId, siteId }: Props) {
  const router = useRouter();
  const [options, setOptions] = useState<WorkOrderOption[]>([]);
  const [workOrderId, setWorkOrderId] = useState("");
  const [localDate, setLocalDate] = useState("");
  const [localTime, setLocalTime] = useState("08:00");
  const [reason, setReason] = useState("");
  const [busy, setBusy] = useState(false);
  const [feedback, setFeedback] = useState<{ kind: "success" | "error"; message: string } | null>(null);

  const selectedLabel = useMemo(
    () => options.find((option) => option.id === workOrderId)?.label ?? workOrderId,
    [options, workOrderId],
  );

  async function schedule(input: {
    workOrderId: string;
    localDate: string;
    localTime: string;
    reason?: string;
  }) {
    setBusy(true);
    setFeedback(null);
    try {
      const response = await fetch(`/api/work-orders/${encodeURIComponent(input.workOrderId)}/schedule`, {
        method: "PATCH",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          organizationId,
          siteId,
          localDate: input.localDate,
          localTime: input.localTime,
          reason: input.reason?.trim() || null,
        }),
      });
      const body = (await response.json()) as {
        data?: { number?: string; plannedStart?: string | null };
        error?: { code?: string; message?: string };
      };
      if (!response.ok || !body.data) {
        const code = body.error?.code ? `${body.error.code}: ` : "";
        throw new Error(`${code}${body.error?.message ?? "Work-order reschedule failed"}`);
      }
      setFeedback({
        kind: "success",
        message: `${body.data.number ?? input.workOrderId} scheduled on ${input.localDate} at ${input.localTime}.`,
      });
      router.refresh();
      return true;
    } catch (error) {
      setFeedback({
        kind: "error",
        message: error instanceof Error ? error.message : "Work-order reschedule failed",
      });
      return false;
    } finally {
      setBusy(false);
    }
  }

  useEffect(() => {
    const links = Array.from(document.querySelectorAll<HTMLAnchorElement>('a[href^="/maintenance/"]'));
    const discovered = new Map<string, WorkOrderOption>();
    const cleanups: Array<() => void> = [];

    for (const link of links) {
      const id = workOrderIdFromHref(link.href);
      if (!id) continue;
      discovered.set(id, { id, label: link.textContent?.trim() || id });
      link.draggable = true;
      link.setAttribute("aria-roledescription", "draggable work order");
      link.title = `${link.title ? `${link.title} · ` : ""}Drag to a calendar day to reschedule`;

      const onDragStart = (event: DragEvent) => {
        if (!event.dataTransfer) return;
        event.dataTransfer.effectAllowed = "move";
        event.dataTransfer.setData("application/x-work-order-id", id);
        event.dataTransfer.setData("text/plain", id);
      };
      link.addEventListener("dragstart", onDragStart);
      cleanups.push(() => {
        link.removeEventListener("dragstart", onDragStart);
        link.draggable = false;
        link.removeAttribute("aria-roledescription");
      });
    }

    const dayCells = Array.from(
      document.querySelectorAll<HTMLElement>('section[aria-label*=" maintenance events"]'),
    );
    for (const cell of dayCells) {
      const date = dropDateFromLabel(cell.getAttribute("aria-label"));
      if (!date) continue;
      cell.setAttribute("data-calendar-drop-date", date);

      const onDragOver = (event: DragEvent) => {
        event.preventDefault();
        if (event.dataTransfer) event.dataTransfer.dropEffect = "move";
        cell.style.outline = "2px solid currentColor";
      };
      const onDragLeave = () => {
        cell.style.outline = "";
      };
      const onDrop = (event: DragEvent) => {
        event.preventDefault();
        cell.style.outline = "";
        const id =
          event.dataTransfer?.getData("application/x-work-order-id") ||
          event.dataTransfer?.getData("text/plain") ||
          "";
        if (!id) return;
        setWorkOrderId(id);
        setLocalDate(date);
        void schedule({
          workOrderId: id,
          localDate: date,
          localTime: "08:00",
          reason: "Calendar drag-and-drop reschedule",
        });
      };

      cell.addEventListener("dragover", onDragOver);
      cell.addEventListener("dragleave", onDragLeave);
      cell.addEventListener("drop", onDrop);
      cleanups.push(() => {
        cell.removeEventListener("dragover", onDragOver);
        cell.removeEventListener("dragleave", onDragLeave);
        cell.removeEventListener("drop", onDrop);
        cell.style.outline = "";
        cell.removeAttribute("data-calendar-drop-date");
      });
    }

    const nextOptions = [...discovered.values()].sort((left, right) => left.label.localeCompare(right.label));
    setOptions(nextOptions);
    setWorkOrderId((current) => current || nextOptions[0]?.id || "");

    return () => {
      for (const cleanup of cleanups) cleanup();
    };
  }, [router]);

  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!workOrderId || !localDate || !localTime) {
      setFeedback({ kind: "error", message: "Select a work order, date and time." });
      return;
    }
    await schedule({ workOrderId, localDate, localTime, reason });
  }

  return (
    <section className="card" aria-label="Accessible work-order scheduling">
      <div className="header asset-header" style={{ marginBottom: 12 }}>
        <div>
          <strong>Reschedule work</strong>
          <div className="muted">Drag a work-order card onto a calendar day, or use this keyboard-accessible form.</div>
        </div>
        {selectedLabel ? <span className="badge">{selectedLabel}</span> : null}
      </div>
      <form onSubmit={submit}>
        <div className="grid grid-2" style={{ gap: 10 }}>
          <label>
            <strong>Work order</strong>
            <select
              value={workOrderId}
              onChange={(event) => setWorkOrderId(event.target.value)}
              disabled={busy}
              style={{ width: "100%", marginTop: 6, padding: "9px 10px" }}
            >
              {options.length ? options.map((option) => (
                <option key={option.id} value={option.id}>{option.label}</option>
              )) : <option value="">No work orders on this view</option>}
            </select>
          </label>
          <label>
            <strong>Date</strong>
            <input
              type="date"
              value={localDate}
              onChange={(event) => setLocalDate(event.target.value)}
              disabled={busy}
              style={{ width: "100%", marginTop: 6, padding: "9px 10px" }}
            />
          </label>
          <label>
            <strong>Local time</strong>
            <input
              type="time"
              value={localTime}
              onChange={(event) => setLocalTime(event.target.value)}
              disabled={busy}
              style={{ width: "100%", marginTop: 6, padding: "9px 10px" }}
            />
          </label>
          <label>
            <strong>Reason</strong>
            <input
              value={reason}
              onChange={(event) => setReason(event.target.value)}
              disabled={busy}
              maxLength={500}
              placeholder="Optional planning reason"
              style={{ width: "100%", marginTop: 6, padding: "9px 10px" }}
            />
          </label>
        </div>
        <button type="submit" disabled={busy || !workOrderId || !localDate} style={{ marginTop: 12 }}>
          {busy ? "Scheduling…" : "Schedule work order"}
        </button>
      </form>
      {feedback ? (
        <p role="status" style={{ marginBottom: 0, marginTop: 10 }}>
          {feedback.kind === "error" ? "Error: " : ""}{feedback.message}
        </p>
      ) : null}
    </section>
  );
}
