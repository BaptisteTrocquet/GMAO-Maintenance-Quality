"use client";

import SavedPlanningViews from "@/app/maintenance/saved-planning-views";
import type { WorkOrderDueFilter } from "@/lib/maintenance/board";

export default function SavedViewControls({
  organizationId,
  siteId,
  currentDue,
}: {
  organizationId: string;
  siteId: string;
  currentDue: WorkOrderDueFilter;
}) {
  return (
    <SavedPlanningViews
      organizationId={organizationId}
      siteId={siteId}
      surface="KANBAN"
      currentConfig={{ dueFilter: currentDue }}
    />
  );
}
