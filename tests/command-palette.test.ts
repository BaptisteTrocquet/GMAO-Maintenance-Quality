import { describe, expect, it } from "vitest";
import {
  COMMAND_PALETTE_QUICK_ACTIONS,
  nextCommandIndex,
  searchResultToCommand,
} from "@/lib/search/command-palette";

describe("command palette helpers", () => {
  it("wraps arrow-key navigation across the result list", () => {
    expect(nextCommandIndex({ current: 0, direction: -1, total: 3 })).toBe(2);
    expect(nextCommandIndex({ current: 2, direction: 1, total: 3 })).toBe(0);
    expect(nextCommandIndex({ current: -1, direction: 1, total: 3 })).toBe(0);
    expect(nextCommandIndex({ current: -1, direction: -1, total: 3 })).toBe(2);
    expect(nextCommandIndex({ current: 0, direction: 1, total: 0 })).toBe(-1);
  });

  it("maps global-search results without changing their destination", () => {
    expect(
      searchResultToCommand({
        kind: "WORK_ORDER",
        id: "wo-1",
        label: "WO-001 · Synthetic inspection",
        description: "Work order",
        meta: "PLANNED · HIGH",
        href: "/maintenance/wo-1",
        score: 0,
      }),
    ).toEqual({
      key: "WORK_ORDER:wo-1",
      label: "WO-001 · Synthetic inspection",
      description: "Work order · PLANNED · HIGH",
      href: "/maintenance/wo-1",
      badge: "WORK ORDER",
    });
  });

  it("keeps deterministic quick actions with global search first", () => {
    expect(COMMAND_PALETTE_QUICK_ACTIONS[0]).toMatchObject({
      key: "action:search",
      href: "/search",
    });
    expect(COMMAND_PALETTE_QUICK_ACTIONS.map((item) => item.href)).toEqual([
      "/search",
      "/maintenance/kanban",
      "/maintenance/calendar",
      "/maintenance/workload",
      "/quality",
    ]);
  });
});
