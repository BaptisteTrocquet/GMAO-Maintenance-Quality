import { describe, expect, it } from "vitest";
import { GET as getThemeCss } from "@/app/embed/theme.css/route";
import {
  DEFAULT_EMBED_THEME,
  embedThemeStylesheetHref,
  parseEmbedTheme,
} from "@/lib/embed/theme";

describe("embed theme tokens", () => {
  it("accepts only bounded hex colors and radius tokens", () => {
    const url = new URL(
      "http://localhost/embed/kpi-card?themeAccent=%23AABBCC&themeBackground=%23010203&themeSurface=%23ffffff&themeText=%23112233&themeRadius=24",
    );

    expect(parseEmbedTheme(url.searchParams)).toEqual({
      accent: "#aabbcc",
      background: "#010203",
      surface: "#ffffff",
      text: "#112233",
      radius: 24,
    });
    expect(embedThemeStylesheetHref(url)).toContain("accent=%23aabbcc");
  });

  it("falls back instead of accepting CSS or out-of-range values", () => {
    const url = new URL(
      "http://localhost/embed/kpi-card?themeAccent=red%3Bbody%7Bdisplay%3Anone%7D&themeSurface=url%28evil%29&themeRadius=99",
    );

    expect(parseEmbedTheme(url.searchParams)).toEqual(DEFAULT_EMBED_THEME);
  });

  it("serves sanitized CSS variables without reflecting hostile input", async () => {
    const response = await getThemeCss(
      new Request(
        "http://localhost/embed/theme.css?accent=%23abcdef&surface=red%3B%7Dbody%7Bdisplay%3Anone&radius=12",
      ),
    );
    const css = await response.text();

    expect(response.status).toBe(200);
    expect(response.headers.get("X-Content-Type-Options")).toBe("nosniff");
    expect(css).toContain("--gmao-accent:#abcdef");
    expect(css).toContain(`--gmao-surface:${DEFAULT_EMBED_THEME.surface}`);
    expect(css).toContain("--gmao-radius:12px");
    expect(css).not.toContain("display:none");
  });
});
