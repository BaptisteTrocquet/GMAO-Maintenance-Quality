const stylesheet = String.raw`:root {
  color-scheme: light dark;
  font-family: Inter, ui-sans-serif, system-ui, -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif;
  --embed-bg: #ffffff;
  --embed-fg: #15171a;
  --embed-muted: #667085;
  --embed-border: #d8dde5;
  --embed-accent: #155eef;
  --embed-accent-fg: #ffffff;
  --embed-radius: 16px;
}

@media (prefers-color-scheme: dark) {
  :root {
    --embed-bg: #111418;
    --embed-fg: #f5f7fa;
    --embed-muted: #98a2b3;
    --embed-border: #303640;
    --embed-accent: #84adff;
    --embed-accent-fg: #0c111d;
  }
}

* { box-sizing: border-box; }
html, body { margin: 0; min-height: 100%; background: transparent; color: var(--embed-fg); }
body { padding: 12px; }
.embed-card {
  width: 100%;
  max-width: 680px;
  margin: 0 auto;
  padding: 22px;
  border: 1px solid var(--embed-border);
  border-radius: var(--embed-radius);
  background: var(--embed-bg);
}
.eyebrow { margin: 0 0 4px; color: var(--embed-accent); font-weight: 700; font-size: 12px; text-transform: uppercase; letter-spacing: .08em; }
h1 { margin: 0; font-size: 24px; line-height: 1.2; }
.intro { margin: 8px 0 20px; color: var(--embed-muted); }
form { display: grid; gap: 14px; }
.grid-two { display: grid; gap: 14px; grid-template-columns: repeat(2, minmax(0, 1fr)); }
label { display: grid; gap: 6px; font-size: 13px; font-weight: 650; }
input, textarea {
  width: 100%;
  padding: 10px 12px;
  border: 1px solid var(--embed-border);
  border-radius: 10px;
  background: var(--embed-bg);
  color: var(--embed-fg);
  font: inherit;
}
textarea { resize: vertical; }
input:focus, textarea:focus { outline: 2px solid var(--embed-accent); outline-offset: 1px; }
button {
  justify-self: start;
  padding: 10px 16px;
  border: 0;
  border-radius: 10px;
  background: var(--embed-accent);
  color: var(--embed-accent-fg);
  font: inherit;
  font-weight: 700;
  cursor: pointer;
}
button:disabled { opacity: .55; cursor: wait; }
.status { min-height: 1.4em; margin: 0; color: var(--embed-muted); font-size: 13px; }
@media (max-width: 520px) { .grid-two { grid-template-columns: 1fr; } .embed-card { padding: 16px; } }
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
