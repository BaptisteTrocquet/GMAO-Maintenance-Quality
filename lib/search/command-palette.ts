import type { GlobalSearchResult } from "@/lib/search/global-search";

export type CommandPaletteItem = {
  id: string;
  label: string;
  description: string;
  href: string;
  group: "NAVIGATION" | "SEARCH";
  meta?: string;
};

export const COMMAND_PALETTE_NAVIGATION: CommandPaletteItem[] = [
  {
    id: "nav-dashboard",
    label: "Dashboard",
    description: "Open the site dashboard",
    href: "/",
    group: "NAVIGATION",
  },
  {
    id: "nav-search",
    label: "Global search",
    description: "Search operational records",
    href: "/search",
    group: "NAVIGATION",
  },
  {
    id: "nav-assets",
    label: "Assets",
    description: "Browse equipment and locations",
    href: "/assets",
    group: "NAVIGATION",
  },
  {
    id: "nav-maintenance",
    label: "Maintenance",
    description: "Open maintenance operations",
    href: "/maintenance",
    group: "NAVIGATION",
  },
  {
    id: "nav-kanban",
    label: "Work-order Kanban",
    description: "Plan work by workflow state",
    href: "/maintenance/kanban",
    group: "NAVIGATION",
  },
  {
    id: "nav-calendar",
    label: "Maintenance calendar",
    description: "Plan and reschedule work by date",
    href: "/maintenance/calendar",
    group: "NAVIGATION",
  },
  {
    id: "nav-workload",
    label: "Team workload",
    description: "Review maintenance team workload",
    href: "/maintenance/workload",
    group: "NAVIGATION",
  },
  {
    id: "nav-documents",
    label: "Documents",
    description: "Browse controlled documents",
    href: "/documents",
    group: "NAVIGATION",
  },
  {
    id: "nav-inventory",
    label: "Inventory",
    description: "Browse spare parts and stock",
    href: "/inventory",
    group: "NAVIGATION",
  },
  {
    id: "nav-quality",
    label: "Quality",
    description: "Open quality events",
    href: "/quality",
    group: "NAVIGATION",
  },
];

function includesQuery(item: CommandPaletteItem, query: string) {
  const needle = query.toLocaleLowerCase();
  return `${item.label} ${item.description}`.toLocaleLowerCase().includes(needle);
}

export function buildCommandPaletteItems(input: {
  query: string;
  results: GlobalSearchResult[];
}) {
  const query = input.query.trim().replace(/\s+/g, " ");
  const navigation = query
    ? COMMAND_PALETTE_NAVIGATION.filter((item) => includesQuery(item, query))
    : COMMAND_PALETTE_NAVIGATION;
  const searchItems: CommandPaletteItem[] = input.results.map((result) => ({
    id: `search-${result.kind}-${result.id}`,
    label: result.label,
    description: result.description,
    href: result.href,
    group: "SEARCH",
    meta: result.meta,
  }));
  return [...navigation, ...searchItems];
}

export function moveCommandPaletteIndex(
  current: number,
  direction: 1 | -1,
  itemCount: number,
) {
  if (itemCount <= 0) return -1;
  if (current < 0 || current >= itemCount) return direction === 1 ? 0 : itemCount - 1;
  return (current + direction + itemCount) % itemCount;
}
