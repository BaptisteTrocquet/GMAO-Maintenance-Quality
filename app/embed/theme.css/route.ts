import { DEFAULT_EMBED_THEME } from "@/lib/embed/theme";

const HEX_COLOR = /^#[0-9a-fA-F]{6}$/;

function color(value: string | null, fallback: string) {
  return value && HEX_COLOR.test(value) ? value.toLowerCase() : fallback;
}

function radius(value: string | null) {
  if (!value || !/^\d{1,2}$/.test(value)) return DEFAULT_EMBED_THEME.radius;
  const parsed = Number(value);
  return parsed >= 0 && parsed <= 32 ? parsed : DEFAULT_EMBED_THEME.radius;
}

export async function GET(request: Request) {
  const url = new URL(request.url);
  const accent = color(url.searchParams.get("accent"), DEFAULT_EMBED_THEME.accent);
  const background = color(url.searchParams.get("background"), DEFAULT_EMBED_THEME.background);
  const surface = color(url.searchParams.get("surface"), DEFAULT_EMBED_THEME.surface);
  const text = color(url.searchParams.get("text"), DEFAULT_EMBED_THEME.text);
  const borderRadius = radius(url.searchParams.get("radius"));

  const css = `:root{--gmao-accent:${accent};--gmao-background:${background};--gmao-surface:${surface};--gmao-text:${text};--gmao-radius:${borderRadius}px}body{background:var(--gmao-background)!important;color:var(--gmao-text)!important}.embed-card,.status-card,.asset-card,.document-card,.kpi-card{background:var(--gmao-surface)!important;color:var(--gmao-text)!important;border-radius:var(--gmao-radius)!important}.embed-card h1,.status-card h1,.asset-card h1,.document-card h1,.kpi-card h1,.grid strong{color:var(--gmao-text)!important}button,.download{background:var(--gmao-accent)!important}.badge{border-color:var(--gmao-accent)!important}.eyebrow{color:var(--gmao-accent)!important}`;

  return new Response(css, {
    headers: {
      "Content-Type": "text/css; charset=utf-8",
      "Cache-Control": "public, max-age=3600, must-revalidate",
      "X-Content-Type-Options": "nosniff",
    },
  });
}
