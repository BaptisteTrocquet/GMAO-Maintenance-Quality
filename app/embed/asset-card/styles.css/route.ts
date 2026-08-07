const css = `
:root{color-scheme:light;font-family:Inter,ui-sans-serif,system-ui,-apple-system,BlinkMacSystemFont,"Segoe UI",sans-serif;background:#f6f7f9;color:#15171a}
*{box-sizing:border-box}
body{margin:0;padding:20px;background:#f6f7f9}
.asset-card{max-width:680px;margin:0 auto;background:#fff;border:1px solid #e5e7eb;border-radius:18px;padding:24px;box-shadow:0 12px 36px rgba(15,23,42,.08)}
.eyebrow{margin:0 0 6px;text-transform:uppercase;letter-spacing:.14em;font-size:11px;font-weight:700;color:#6b7280}
.heading-row{display:flex;align-items:flex-start;justify-content:space-between;gap:18px;border-bottom:1px solid #eef0f3;padding-bottom:18px}
h1{font-size:26px;line-height:1.15;margin:0;color:#111827}
.code{margin:6px 0 0;font-family:ui-monospace,SFMono-Regular,Menlo,monospace;font-size:13px;color:#6b7280}
.badge{display:inline-flex;align-items:center;min-height:30px;padding:5px 10px;border-radius:999px;background:#eef2f7;font-size:12px;font-weight:700;color:#374151;white-space:nowrap}
.details{display:grid;grid-template-columns:repeat(2,minmax(0,1fr));gap:0;margin:18px 0 0}
.details div{padding:14px 8px 14px 0;border-bottom:1px solid #f0f2f5}
dt{font-size:11px;text-transform:uppercase;letter-spacing:.08em;color:#9ca3af;font-weight:700}
dd{margin:5px 0 0;font-size:14px;color:#1f2937;overflow-wrap:anywhere}
.message{min-height:20px;margin:16px 0 0;font-size:13px;color:#b42318}
@media(max-width:520px){body{padding:10px}.asset-card{padding:18px;border-radius:14px}.heading-row{flex-direction:column}.details{grid-template-columns:1fr}}
`;

export async function GET() {
  return new Response(css, {
    headers: {
      "Content-Type": "text/css; charset=utf-8",
      "Cache-Control": "public, max-age=3600, must-revalidate",
      "X-Content-Type-Options": "nosniff",
    },
  });
}
