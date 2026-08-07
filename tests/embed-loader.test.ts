import { describe, expect, it } from "vitest";
import { GET } from "@/app/embed.js/route";

describe("embed.js widget loader", () => {
  it("supports every iframe widget without unsafe DOM string execution", async () => {
    const response = await GET();
    const source = await response.text();

    expect(response.status).toBe(200);
    expect(response.headers.get("Cross-Origin-Resource-Policy")).toBe("cross-origin");
    expect(source).toContain('"maintenance-request"');
    expect(source).toContain('"request-status"');
    expect(source).toContain('"asset-card"');
    expect(source).toContain('"controlled-document"');
    expect(source).toContain('"kpi-card"');
    expect(source).toContain('document.createElement("iframe")');
    expect(source).not.toContain("innerHTML");
    expect(source).not.toContain("document.write");
    expect(source).not.toContain("eval(");
  });

  it("keeps the scoped secret in the iframe fragment and removes it from the script element", async () => {
    const source = await (await GET()).text();

    expect(source).toContain('script.removeAttribute("data-token")');
    expect(source).toContain("url.hash = new URLSearchParams({ token }).toString()");
    expect(source).not.toContain('url.searchParams.set("token"');
    expect(source).toContain('iframe.referrerPolicy = "strict-origin"');
    expect(source).toContain('iframe.setAttribute("sandbox", "allow-scripts allow-same-origin")');
  });

  it("passes only named theme tokens to the iframe query", async () => {
    const source = await (await GET()).text();

    expect(source).toContain('themeAccent: "themeAccent"');
    expect(source).toContain('themeBackground: "themeBackground"');
    expect(source).toContain('themeSurface: "themeSurface"');
    expect(source).toContain('themeText: "themeText"');
    expect(source).toContain('themeRadius: "themeRadius"');
  });
});
