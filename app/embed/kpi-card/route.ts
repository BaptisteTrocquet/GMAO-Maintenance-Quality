import { db } from "@/lib/db";
import { escapeHtmlAttribute } from "@/lib/embed/html";
import { createEmbedProof, parentOriginFromReferrer } from "@/lib/embed/proof";
import { getPublicRequestTokenScopes, hasPublicRequestScope, isOriginAllowed } from "@/lib/public-requests/tokens";

function htmlPage(proof: string) {
  return `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Maintenance KPIs</title><link rel="stylesheet" href="/embed/kpi-card/styles.css"></head>
<body><main class="kpi-card" id="gmao-kpi-card" data-embed-proof="${escapeHtmlAttribute(proof)}">
<p class="eyebrow">Site maintenance</p><h1>Live KPI snapshot</h1>
<div class="grid"><div><strong id="open">—</strong><span>Open work orders</span></div><div><strong id="overdue">—</strong><span>Overdue</span></div><div><strong id="in-progress">—</strong><span>In progress</span></div><div><strong id="out-of-service">—</strong><span>Assets out of service</span></div></div>
<p id="generated-at" class="generated"></p><p id="message" class="message" role="status" aria-live="polite"></p></main><script src="/embed/kpi-card/client.js" defer></script></body></html>`;
}

function securityHeaders(allowedOrigins: readonly string[]) {
  const frameAncestors = allowedOrigins.length ? allowedOrigins.join(" ") : "'none'";
  return {
    "Content-Type": "text/html; charset=utf-8",
    "Cache-Control": "private, no-store",
    "Content-Security-Policy": [
      "default-src 'none'", "script-src 'self'", "style-src 'self'", "connect-src 'self'",
      "img-src 'none'", "font-src 'none'", "object-src 'none'", "base-uri 'none'", "form-action 'none'",
      `frame-ancestors ${frameAncestors}`,
    ].join("; "),
    "Referrer-Policy": "no-referrer",
    "X-Content-Type-Options": "nosniff",
  };
}

export async function GET(request: Request) {
  const url = new URL(request.url);
  const tokenId = url.searchParams.get("tokenId");
  if (!tokenId) return new Response("Missing tokenId", { status: 400 });

  const token = await db.publicMaintenanceRequestToken.findUnique({ where: { id: tokenId } });
  const now = new Date();
  if (!token || token.mode !== "EMBEDDED" || token.revokedAt || (token.expiresAt && token.expiresAt <= now)) {
    return new Response("Embed unavailable", { status: 404 });
  }
  const scopes = await getPublicRequestTokenScopes(token.id, token.createdAt);
  if (!hasPublicRequestScope({ scopes }, "kpi:read")) return new Response("Embed unavailable", { status: 404 });

  const parentOrigin = parentOriginFromReferrer(request.headers.get("referer"));
  if (!parentOrigin || !isOriginAllowed({ mode: token.mode, allowedOrigins: token.allowedOrigins, origin: parentOrigin })) {
    return new Response("Embedding origin is not allowed", { status: 403, headers: securityHeaders(token.allowedOrigins) });
  }

  const proof = createEmbedProof({ tokenId: token.id, tokenHash: token.tokenHash, parentOrigin, now });
  return new Response(htmlPage(proof), { status: 200, headers: securityHeaders(token.allowedOrigins) });
}
