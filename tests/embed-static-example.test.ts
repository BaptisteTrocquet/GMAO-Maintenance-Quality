import fs from "node:fs/promises";
import path from "node:path";
import { describe, expect, it } from "vitest";

describe("static maintenance request iframe example", () => {
  it("keeps the scoped secret in the URL fragment and sends only the parent origin referrer", async () => {
    const html = await fs.readFile(
      path.join(process.cwd(), "examples/maintenance-request-iframe.html"),
      "utf8",
    );

    expect(html).toContain("?tokenId=TOKEN_ID#token=SCOPED_TOKEN_SECRET");
    expect(html).toContain('referrerpolicy="strict-origin"');
    expect(html).toContain('sandbox="allow-scripts allow-same-origin"');
    expect(html).toContain('event.origin !== "https://gmao.example.test"');
    expect(html).not.toContain("ADMIN_TOKEN");
    expect(html).not.toContain("SESSION_SECRET");
  });
});
