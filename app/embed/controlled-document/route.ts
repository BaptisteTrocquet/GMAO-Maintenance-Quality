import { db } from "@/lib/db";
import { escapeHtmlAttribute } from "@/lib/embed/html";
import { createEmbedProof, parentOriginFromReferrer } from "@/lib/embed/proof";
import { getPublicRequestTokenScopes, hasPublicRequestScope, isOriginAllowed } from "@/lib/public-requests/tokens";

function htmlPage(proof: string, documentCode: string, asOf: string | null) {
  return `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width,initial-scale=1">
  <title>Controlled document</title>
  <link rel="stylesheet" href="/embed/controlled-document/styles.css">
</head>
<body>
  <main class="document-card" id="gmao-controlled-document" data-embed-proof="${escapeHtmlAttribute(proof)}" data-document-code="${escapeHtmlAttribute(documentCode)}" data-as-of="${escapeHtmlAttribute(asOf ?? "")}">
    <header>
      <p class="eyebrow">Controlled document</p>
      <h1 id="document-title">Loading…</h1>
      <div class="meta"><span id="document-code"></span><span id="revision"></span><span id="effective-at"></span></div>
    </header>
    <p id="checksum" class="checksum"></p>
    <section id="preview-wrap" class="preview-wrap" hidden>
      <iframe id="pdf-preview" class="pdf-preview" title="Controlled PDF preview" sandbox hidden></iframe>
      <img id="image-preview" class="image-preview" alt="Controlled document preview" hidden>
    </section>
    <a id="download-link" class="download" href="#" download hidden>Download controlled copy</a>
    <p id="message" class="message" role="status" aria-live="polite"></p>
  </main>
  <script src="/embed/controlled-document/client.js" defer></script>
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
      "img-src blob:",
      "frame-src blob:",
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
  const documentCode = url.searchParams.get("documentCode")?.trim();
  const rawAsOf = url.searchParams.get("asOf");
  if (!tokenId || !documentCode) return new Response("Missing tokenId or documentCode", { status: 400 });
  if (rawAsOf && Number.isNaN(new Date(rawAsOf).getTime())) return new Response("Invalid asOf", { status: 400 });

  const token = await db.publicMaintenanceRequestToken.findUnique({ where: { id: tokenId } });
  const now = new Date();
  if (!token || token.mode !== "EMBEDDED" || token.revokedAt || (token.expiresAt && token.expiresAt <= now)) {
    return new Response("Embed unavailable", { status: 404 });
  }

  const scopes = await getPublicRequestTokenScopes(token.id, token.createdAt);
  if (!hasPublicRequestScope({ scopes }, "document:read")) return new Response("Embed unavailable", { status: 404 });

  const parentOrigin = parentOriginFromReferrer(request.headers.get("referer"));
  if (!parentOrigin || !isOriginAllowed({ mode: token.mode, allowedOrigins: token.allowedOrigins, origin: parentOrigin })) {
    return new Response("Embedding origin is not allowed", {
      status: 403,
      headers: securityHeaders(token.allowedOrigins),
    });
  }

  const proof = createEmbedProof({ tokenId: token.id, tokenHash: token.tokenHash, parentOrigin, now });
  return new Response(htmlPage(proof, documentCode, rawAsOf), {
    status: 200,
    headers: securityHeaders(token.allowedOrigins),
  });
}
