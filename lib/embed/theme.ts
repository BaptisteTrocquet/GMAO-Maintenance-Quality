const HEX_COLOR = /^#[0-9a-fA-F]{6}$/;

export type EmbedTheme = {
  accent: string;
  background: string;
  surface: string;
  text: string;
  radius: number;
};

export const DEFAULT_EMBED_THEME: EmbedTheme = {
  accent: "#2563eb",
  background: "#f6f7f9",
  surface: "#ffffff",
  text: "#111827",
  radius: 18,
};

function color(value: string | null, fallback: string) {
  return value && HEX_COLOR.test(value) ? value.toLowerCase() : fallback;
}

function radius(value: string | null) {
  if (!value || !/^\d{1,2}$/.test(value)) return DEFAULT_EMBED_THEME.radius;
  const parsed = Number(value);
  return parsed >= 0 && parsed <= 32 ? parsed : DEFAULT_EMBED_THEME.radius;
}

export function parseEmbedTheme(searchParams: URLSearchParams): EmbedTheme {
  return {
    accent: color(searchParams.get("themeAccent"), DEFAULT_EMBED_THEME.accent),
    background: color(searchParams.get("themeBackground"), DEFAULT_EMBED_THEME.background),
    surface: color(searchParams.get("themeSurface"), DEFAULT_EMBED_THEME.surface),
    text: color(searchParams.get("themeText"), DEFAULT_EMBED_THEME.text),
    radius: radius(searchParams.get("themeRadius")),
  };
}

export function embedThemeStylesheetHref(url: URL) {
  const theme = parseEmbedTheme(url.searchParams);
  const params = new URLSearchParams({
    accent: theme.accent,
    background: theme.background,
    surface: theme.surface,
    text: theme.text,
    radius: String(theme.radius),
  });
  return `/embed/theme.css?${params.toString()}`;
}
