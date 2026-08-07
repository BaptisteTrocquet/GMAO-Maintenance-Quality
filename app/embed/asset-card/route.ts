import { db } from "@/lib/db";
import { createEmbedProof, parentOriginFromReferrer } from "@/lib/embed/proof";
import { getPublicRequestTokenScopes, hasPublicRequestScope, isOriginAllowed } from "@/lib/public-requests/tokens";

function htmlPage(proof: string, assetCode: string) {
  return `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width,initial-scale=1">
  <title>Asset card</title>
  <link rel="stylesheet" href="/embed/asset-card/styles.css">
</head>
<body>
  <main class="asset-card" id="gmao-asset-card" data-embed-proof="${proof}" data-asset-code="${assetCode}">
    <p class="eyebrow">Asset</p>
    <div class="heading-row">
      <div><h1 id="asset-name">Loading…</h1><p id="asset-code" class="code"></p></div>
      <span id="asset-status" class="badge">—</span>
    </div>
    <dl class="details">
      <div><dt>Criticality</dt><dd id="criticality">—</dd></div>
      <div><dt>Category</dt><dd id="category">—</dd></div>
      <div><dt>Location</dt><dd id="location">—</dd></div>
      <div><dt>Manufacturer</dt><dd id="manufacturer">—</dd></div>
      <div><dt>Model</dt><dd id="model">—</dd></div>
      <div><dt>Updated</dt><dd id="updated-at">—</dd></div>
    </dl>
    <p id="message" class="message" role="status" aria-live="polite"></p>
  </main>
  <script src="/embed/asset-card/client.js" defer></script>
</body>
</html>`;
}

function securityHeaders(allowedOrigins: readonly string[]) {
  const frameAncestors = allowedOrigins.length ? allowedOrigins.join(" ") : "'none'";
  return {
    "Content-Type": "text/html; charset=utf-8",
    "Cache-Control": "private, no-store",
    "Content-Security-Policy": [
      "default-src 'none'",
      "script-src 'self'",
      "style-src 'self'",
      "connect-src 'self'",
      "img-src 'none'",
      "font-src 'none'",
      "object-src 'none'",
      "base-uri 'none'",
      "form-action 'none'",
      `frame-ancestors ${frameAncestors}`,
    ].join("; "),
    "Referrer-Policy": "no-referrer",
    "X-Content-Type-Options": "nosniff",
  };
}

export async function GET(request: Request) {
  const url = new URL(request.url);
  const tokenId = url.searchParams.get("tokenId");
  const assetCode = url.searchParams.get("assetCode")?.trim();
  if (!tokenId || !assetCode) return new Response("Missing tokenId or assetCode", { status: 400 });

  const token = await db.publicMaintenanceRequestToken.findUnique({ where: { id: tokenId } });
  const now = new Date();
  if (!token || token.mode !== "EMBEDDED" || token.revokedAt || (token.expiresAt && token.expiresAt <= now)) {
    return new Response("Embed unavailable", { status: 404 });
  }

  const scopes = await getPublicRequestTokenScopes(token.id, token.createdAt);
  if (!hasPublicRequestScope({ scopes }, "asset:read")) {
    return new Response("Embed unavailable", { status: 404 });
  }

  const parentOrigin = parentOriginFromReferrer(request.headers.get("referer"));
  if (!parentOrigin || !isOriginAllowed({ mode: token.mode, allowedOrigins: token.allowedOrigins, origin: parentOrigin })) {
    return new Response("Embedding origin is not allowed", {
      status: 403,
      headers: securityHeaders(token.allowedOrigins),
    });
  }

  const proof = createEmbedProof({ tokenId: token.id, tokenHash: token.tokenHash, parentOrigin, now });
  return new Response(htmlPage(proof, assetCode), {
    status: 200,
    headers: securityHeaders(token.allowedOrigins),
  });
}
