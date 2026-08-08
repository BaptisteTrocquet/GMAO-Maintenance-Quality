"use client";

import Link from "next/link";
import { useState } from "react";
import { useRouter } from "next/navigation";
import type { WorkOrderStatus } from "@prisma/client";
import { assertTransitionAllowed } from "@/lib/work-orders/workflow";

const ALL_STATUSES: WorkOrderStatus[] = [
  "REQUESTED",
  "APPROVED",
  "PLANNED",
  "IN_PROGRESS",
  "BLOCKED",
  "COMPLETED",
  "CANCELLED",
];

type Props = {
  organizationId: string;
  siteId: string;
  workOrder: {
    id: string;
    number: string;
    title: string;
    status: WorkOrderStatus;
    priority: "LOW" | "NORMAL" | "HIGH" | "URGENT";
    dueAt: string | null;
    plannedStart: string | null;
    assetCode: string | null;
    assigneeName: string | null;
    teamName: string | null;
    overdue: boolean;
  };
};

function legalTargets(from: WorkOrderStatus) {
  return ALL_STATUSES.filter((to) => {
    if (to === from) return false;
    try {
      assertTransitionAllowed(from, to);
      return true;
    } catch {
      return false;
    }
  });
}

function formatDate(value: string | null) {
  return value ? value.slice(0, 10) : "—";
}

function label(status: WorkOrderStatus) {
  return status.toLowerCase().replaceAll("_", " ");
}

export default function WorkOrderCard({ organizationId, siteId, workOrder }: Props) {
  const router = useRouter();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const targets = legalTargets(workOrder.status);

  async function transition(to: WorkOrderStatus) {
    let statusNote: string | null = null;
    if (to === "CANCELLED" || workOrder.status === "COMPLETED" || workOrder.status === "CANCELLED") {
      statusNote = window.prompt(
        to === "CANCELLED" ? "Reason for cancellation" : "Reason for reopening",
      );
      if (!statusNote?.trim()) return;
    }

    setBusy(true);
    setError(null);
    try {
      const response = await fetch(`/api/work-orders/${workOrder.id}`, {
        method: "PATCH",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          organizationId,
          siteId,
          status: to,
          ...(statusNote ? { statusNote } : {}),
        }),
      });
      const body = (await response.json()) as { error?: { message?: string } };
      if (!response.ok) {
        throw new Error(body.error?.message ?? "Work-order transition failed");
      }
      router.refresh();
    } catch (transitionError) {
      setError(
        transitionError instanceof Error ? transitionError.message : "Work-order transition failed",
      );
    } finally {
      setBusy(false);
    }
  }

  return (
    <article
      className="card"
      aria-label={`${workOrder.number} ${workOrder.title}`}
      style={{ padding: 14, display: "grid", gap: 10 }}
    >
      <div style={{ display: "flex", justifyContent: "space-between", gap: 10, alignItems: "start" }}>
        <div>
          <Link className="table-link" href={`/maintenance/${workOrder.id}`}>
            <strong>{workOrder.number}</strong>
          </Link>
          <div>{workOrder.title}</div>
        </div>
        <span className="badge">{workOrder.priority}</span>
      </div>

      <dl className="detail-list" style={{ margin: 0 }}>
        <div><dt>Asset</dt><dd>{workOrder.assetCode ?? "—"}</dd></div>
        <div><dt>Owner</dt><dd>{workOrder.assigneeName ?? workOrder.teamName ?? "Unassigned"}</dd></div>
        <div><dt>Due</dt><dd>{formatDate(workOrder.dueAt)}{workOrder.overdue ? " · OVERDUE" : ""}</dd></div>
      </dl>

      {targets.length ? (
        <div aria-label="Available status transitions" style={{ display: "flex", gap: 6, flexWrap: "wrap" }}>
          {targets.map((target) => {
            const planningBlocked =
              target === "PLANNED" && workOrder.status === "APPROVED" && !workOrder.plannedStart;
            return (
              <button
                key={target}
                type="button"
                onClick={() => transition(target)}
                disabled={busy || planningBlocked}
                title={planningBlocked ? "Set a planned start date on the work order before planning" : undefined}
                aria-label={`Move ${workOrder.number} to ${label(target)}`}
                style={{ padding: "6px 9px" }}
              >
                {target === "CANCELLED" ? "Cancel" : `→ ${label(target)}`}
              </button>
            );
          })}
        </div>
      ) : null}

      {error ? <div role="alert" style={{ color: "#991b1b", fontSize: 13 }}>{error}</div> : null}
    </article>
  );
}
