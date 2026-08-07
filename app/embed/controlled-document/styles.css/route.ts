const css = `
:root{color-scheme:light;font-family:Inter,ui-sans-serif,system-ui,-apple-system,BlinkMacSystemFont,"Segoe UI",sans-serif;background:#f6f7f9;color:#15171a}
*{box-sizing:border-box}
body{margin:0;padding:18px;background:#f6f7f9}
.document-card{max-width:900px;margin:0 auto;background:#fff;border:1px solid #e5e7eb;border-radius:18px;padding:22px;box-shadow:0 12px 36px rgba(15,23,42,.08)}
header{border-bottom:1px solid #eef0f3;padding-bottom:16px}
.eyebrow{margin:0 0 5px;text-transform:uppercase;letter-spacing:.14em;font-size:11px;font-weight:700;color:#6b7280}
h1{margin:0;font-size:25px;line-height:1.2;color:#111827}
.meta{display:flex;flex-wrap:wrap;gap:12px;margin-top:8px;font-size:13px;color:#6b7280}
.checksum{font-family:ui-monospace,SFMono-Regular,Menlo,monospace;font-size:11px;color:#6b7280;overflow-wrap:anywhere;margin:14px 0}
.preview-wrap{margin-top:16px;border:1px solid #e5e7eb;border-radius:12px;overflow:hidden;background:#f8fafc}
.pdf-preview{display:block;width:100%;height:600px;border:0;background:#fff}
.image-preview{display:block;max-width:100%;max-height:650px;margin:0 auto;object-fit:contain}
.download{display:inline-flex;margin-top:16px;padding:10px 14px;border-radius:10px;background:#111827;color:#fff;text-decoration:none;font-size:13px;font-weight:700}
.message{min-height:20px;margin:14px 0 0;font-size:13px;color:#6b7280}
@media(max-width:600px){body{padding:8px}.document-card{padding:16px;border-radius:12px}.pdf-preview{height:470px}}
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
