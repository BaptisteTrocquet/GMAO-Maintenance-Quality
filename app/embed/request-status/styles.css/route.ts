const stylesheet = String.raw`:root {
  color-scheme: light dark;
  font-family: Inter, ui-sans-serif, system-ui, -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif;
  --embed-bg: #ffffff;
  --embed-fg: #15171a;
  --embed-muted: #667085;
  --embed-border: #d8dde5;
  --embed-accent: #155eef;
  --embed-soft: #eef4ff;
  --embed-radius: 16px;
}
@media (prefers-color-scheme: dark) {
  :root {
    --embed-bg: #111418;
    --embed-fg: #f5f7fa;
    --embed-muted: #98a2b3;
    --embed-border: #303640;
    --embed-accent: #84adff;
    --embed-soft: #17213a;
  }
}
* { box-sizing: border-box; }
html, body { margin: 0; min-height: 100%; background: transparent; color: var(--embed-fg); }
body { padding: 12px; }
.status-card {
  width: 100%;
  max-width: 620px;
  margin: 0 auto;
  padding: 22px;
  border: 1px solid var(--embed-border);
  border-radius: var(--embed-radius);
  background: var(--embed-bg);
}
.eyebrow { margin: 0 0 4px; color: var(--embed-accent); font-weight: 700; font-size: 12px; text-transform: uppercase; letter-spacing: .08em; }
h1 { margin: 0 0 18px; font-size: 24px; }
.status-line { display: flex; gap: 10px; align-items: center; flex-wrap: wrap; margin-bottom: 18px; }
.badge { display: inline-flex; padding: 5px 9px; border-radius: 999px; background: var(--embed-soft); color: var(--embed-accent); font-size: 12px; font-weight: 750; text-transform: capitalize; }
.milestones { display: grid; gap: 0; margin: 0; border-top: 1px solid var(--embed-border); }
.milestones div { display: grid; grid-template-columns: 110px 1fr; gap: 12px; padding: 10px 0; border-bottom: 1px solid var(--embed-border); }
dt { color: var(--embed-muted); font-size: 13px; }
dd { margin: 0; font-size: 13px; font-weight: 600; }
.message { min-height: 1.4em; margin: 14px 0 0; color: var(--embed-muted); font-size: 12px; }
@media (max-width: 480px) { .status-card { padding: 16px; } .milestones div { grid-template-columns: 1fr; gap: 4px; } }
`;

export async function GET() {
  return new Response(stylesheet, {
    headers: {
      "Content-Type": "text/css; charset=utf-8",
      "Cache-Control": "public, max-age=3600, must-revalidate",
      "X-Content-Type-Options": "nosniff",
    },
  });
}
