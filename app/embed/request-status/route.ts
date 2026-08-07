import { db } from "@/lib/db";
import { createEmbedProof, parentOriginFromReferrer } from "@/lib/embed/proof";
import {
  getPublicRequestTokenScopes,
  hasPublicRequestScope,
  isOriginAllowed,
} from "@/lib/public-requests/tokens";

function htmlPage(proof: string, trackingId: string) {
  return `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width,initial-scale=1">
  <title>Maintenance request status</title>
  <link rel="stylesheet" href="/embed/request-status/styles.css">
</head>
<body>
  <main class="status-card" id="gmao-status-embed" data-embed-proof="${proof}" data-tracking-id="${trackingId}">
    <p class="eyebrow">Maintenance</p>
    <h1>Request status</h1>
    <div class="status-line">
      <span id="status-badge" class="badge">Loading…</span>
      <strong id="work-order-number"></strong>
    </div>
    <dl class="milestones">
      <div><dt>Requested</dt><dd id="requested-at">—</dd></div>
      <div><dt>Planned</dt><dd id="planned-start">—</dd></div>
      <div><dt>Due</dt><dd id="due-at">—</dd></div>
      <div><dt>Started</dt><dd id="started-at">—</dd></div>
      <div><dt>Completed</dt><dd id="completed-at">—</dd></div>
    </dl>
    <p id="status-message" class="message" role="status" aria-live="polite"></p>
  </main>
  <script src="/embed/request-status/client.js" defer></script>
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
  const trackingId = url.searchParams.get("trackingId")?.trim();
  if (!tokenId || !trackingId) return new Response("Missing tokenId or trackingId", { status: 400 });

  const token = await db.publicMaintenanceRequestToken.findUnique({ where: { id: tokenId } });
  const now = new Date();
  if (
    !token ||
    token.mode !== "EMBEDDED" ||
    token.revokedAt ||
    (token.expiresAt && token.expiresAt <= now)
  ) {
    return new Response("Embed unavailable", { status: 404 });
  }

  const scopes = await getPublicRequestTokenScopes(token.id);
  if (!hasPublicRequestScope({ scopes }, "maintenance:request:status")) {
    return new Response("Embed unavailable", { status: 404 });
  }

  const submission = await db.publicMaintenanceRequestSubmission.findFirst({
    where: { id: trackingId, tokenId: token.id },
    select: { id: true },
  });
  if (!submission) return new Response("Tracked request unavailable", { status: 404 });

  const parentOrigin = parentOriginFromReferrer(request.headers.get("referer"));
  if (
    !parentOrigin ||
    !isOriginAllowed({ mode: token.mode, allowedOrigins: token.allowedOrigins, origin: parentOrigin })
  ) {
    return new Response("Embedding origin is not allowed", {
      status: 403,
      headers: securityHeaders(token.allowedOrigins),
    });
  }

  const proof = createEmbedProof({
    tokenId: token.id,
    tokenHash: token.tokenHash,
    parentOrigin,
    now,
  });
  return new Response(htmlPage(proof, submission.id), {
    status: 200,
    headers: securityHeaders(token.allowedOrigins),
  });
}
