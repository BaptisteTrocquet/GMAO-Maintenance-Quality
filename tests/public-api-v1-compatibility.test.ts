import { describe, expect, it } from "vitest";
import { OPTIONS as legacyOptions, POST as legacyPost } from "@/app/api/public/maintenance-requests/route";
import { OPTIONS as v1Options, POST as v1Post } from "@/app/api/v1/public/maintenance-requests/route";

describe("public REST API v1 compatibility", () => {
  it("delegates maintenance request POST to the established legacy handler", () => {
    expect(v1Post).toBe(legacyPost);
  });

  it("delegates CORS preflight to the established legacy handler", () => {
    expect(v1Options).toBe(legacyOptions);
  });
});
