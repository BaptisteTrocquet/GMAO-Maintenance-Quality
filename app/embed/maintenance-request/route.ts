import { db } from "@/lib/db";
import { createEmbedProof, parentOriginFromReferrer } from "@/lib/embed/proof";
import { isOriginAllowed } from "@/lib/public-requests/tokens";

function htmlPage(proof: string) {
  return `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width,initial-scale=1">
  <title>Maintenance request</title>
  <link rel="stylesheet" href="/embed/maintenance-request/styles.css">
</head>
<body>
  <main class="embed-card" id="gmao-embed" data-embed-proof="${proof}">
    <header>
      <p class="eyebrow">Maintenance</p>
      <h1>Report an issue</h1>
      <p class="intro">Send a maintenance request to the connected site.</p>
    </header>
    <form id="request-form" novalidate>
      <label>Title<input name="title" maxlength="200" required autocomplete="off"></label>
      <label>Description<textarea name="description" maxlength="5000" rows="4"></textarea></label>
      <div class="grid-two">
        <label>Asset code<input name="assetCode" maxlength="50" autocomplete="off"></label>
        <label>Your name<input name="requesterName" maxlength="150" autocomplete="name"></label>
      </div>
      <label>Email<input name="requesterEmail" maxlength="320" type="email" autocomplete="email"></label>
      <button type="submit">Send request</button>
      <p id="status" class="status" role="status" aria-live="polite"></p>
    </form>
  </main>
  <script src="/embed/maintenance-request/client.js" defer></script>
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
  if (!tokenId) return new Response("Missing tokenId", { status: 400 });

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
  return new Response(htmlPage(proof), {
    status: 200,
    headers: securityHeaders(token.allowedOrigins),
  });
}
