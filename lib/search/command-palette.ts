import type { GlobalSearchResult } from "@/lib/search/global-search";

export type CommandPaletteItem = {
  key: string;
  label: string;
  description: string;
  href: string;
  badge: string;
};

export const COMMAND_PALETTE_QUICK_ACTIONS: CommandPaletteItem[] = [
  {
    key: "action:search",
    label: "Global search",
    description: "Search across records in the selected site",
    href: "/search",
    badge: "ACTION",
  },
  {
    key: "action:kanban",
    label: "Work-order Kanban",
    description: "Open the operational work-order board",
    href: "/maintenance/kanban",
    badge: "ACTION",
  },
  {
    key: "action:calendar",
    label: "Maintenance calendar",
    description: "Open monthly planning and rescheduling",
    href: "/maintenance/calendar",
    badge: "ACTION",
  },
  {
    key: "action:workload",
    label: "Team workload",
    description: "Review assigned, blocked and overdue workload",
    href: "/maintenance/workload",
    badge: "ACTION",
  },
  {
    key: "action:quality",
    label: "Quality workspace",
    description: "Open quality events and CAPA workflows",
    href: "/quality",
    badge: "ACTION",
  },
];

export function searchResultToCommand(result: GlobalSearchResult): CommandPaletteItem {
  return {
    key: `${result.kind}:${result.id}`,
    label: result.label,
    description: `${result.description} · ${result.meta}`,
    href: result.href,
    badge: result.kind.replaceAll("_", " "),
  };
}

export function nextCommandIndex(input: {
  current: number;
  direction: 1 | -1;
  total: number;
}) {
  if (input.total <= 0) return -1;
  if (input.current < 0) return input.direction === 1 ? 0 : input.total - 1;
  return (input.current + input.direction + input.total) % input.total;
}
