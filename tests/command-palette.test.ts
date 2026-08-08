import { describe, expect, it } from "vitest";
import {
  COMMAND_PALETTE_QUICK_ACTIONS,
  nextCommandIndex,
  searchResultToCommand,
} from "@/lib/search/command-palette";

describe("command palette helpers", () => {
  it("wraps keyboard selection in both directions", () => {
    expect(nextCommandIndex({ current: -1, direction: 1, total: 3 })).toBe(0);
    expect(nextCommandIndex({ current: -1, direction: -1, total: 3 })).toBe(2);
    expect(nextCommandIndex({ current: 2, direction: 1, total: 3 })).toBe(0);
    expect(nextCommandIndex({ current: 0, direction: -1, total: 3 })).toBe(2);
    expect(nextCommandIndex({ current: 0, direction: 1, total: 0 })).toBe(-1);
  });

  it("maps permission-filtered global search results into navigable commands", () => {
    expect(
      searchResultToCommand({
        kind: "WORK_ORDER",
        id: "wo-1",
        label: "WO-000001 · Inspect pump",
        description: "Inspection task",
        meta: "PLANNED · HIGH",
        href: "/maintenance/wo-1",
        score: 0,
      }),
    ).toEqual({
      key: "WORK_ORDER:wo-1",
      label: "WO-000001 · Inspect pump",
      description: "Inspection task · PLANNED · HIGH",
      href: "/maintenance/wo-1",
      badge: "WORK ORDER",
    });
  });

  it("keeps quick actions deterministic with notifications before Kanban", () => {
    expect(COMMAND_PALETTE_QUICK_ACTIONS.slice(0, 3)).toEqual([
      expect.objectContaining({ key: "action:search", href: "/search" }),
      expect.objectContaining({ key: "action:notifications", href: "/notifications" }),
      expect.objectContaining({ key: "action:kanban", href: "/maintenance/kanban" }),
    ]);
  });
});
