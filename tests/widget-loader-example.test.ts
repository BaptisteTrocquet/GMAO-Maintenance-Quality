import { readFile } from "node:fs/promises";
import { describe, expect, it } from "vitest";

describe("widget-loader static integration example", () => {
  it("uses only a scoped browser token and validated named theme attributes", async () => {
    const html = await readFile("examples/widget-loader.html", "utf8");

    expect(html).toContain('src="https://gmao.example.test/embed.js"');
    expect(html).toContain('data-widget="maintenance-request"');
    expect(html).toContain('data-token-id="TOKEN_ID"');
    expect(html).toContain('data-token="SCOPED_TOKEN_SECRET"');
    expect(html).toContain('data-theme-accent="#2563eb"');
    expect(html).toContain('data-theme-radius="16"');
    expect(html).not.toContain("ADMIN_TOKEN");
    expect(html).not.toContain("SESSION_COOKIE");
  });
});
