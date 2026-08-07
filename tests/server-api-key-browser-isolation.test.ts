import { readFile } from "node:fs/promises";
import { describe, expect, it } from "vitest";

const serverRoutes = [
  "app/api/v1/server/maintenance-requests/route.ts",
  "app/api/v1/server/request-status/route.ts",
  "app/api/v1/server/assets/route.ts",
  "app/api/v1/server/documents/route.ts",
  "app/api/v1/server/kpis/route.ts",
];

describe("server API-key browser isolation", () => {
  it("keeps server-only routes free of CORS and iframe/browser token contracts", async () => {
    for (const path of serverRoutes) {
      const source = await readFile(path, "utf8");
      expect(source).toContain("authenticateApiKeyRequest");
      expect(source).not.toContain("Access-Control-Allow-Origin");
      expect(source).not.toContain("export async function OPTIONS");
      expect(source).not.toContain("X-Embed-Proof");
      expect(source).not.toContain("Authorization: Bearer");
    }
  });

  it("documents X-API-Key as a server-only credential", async () => {
    const docs = await readFile("docs/API_KEYS.md", "utf8");
    expect(docs).toContain("X-API-Key");
    expect(docs).toContain("API_KEY_BROWSER_FORBIDDEN");
    expect(docs).toContain("must never be embedded in HTML");
  });
});
