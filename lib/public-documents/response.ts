import { Buffer } from "node:buffer";

export function controlledDocumentResponse(copy: {
  document: { code: string; title: string };
  revision: { revision: string; effectiveAt: Date | null };
  file: { data: Uint8Array; mimeType: string; fileName: string; checksum: string };
  asOf: Date;
}) {
  return new Response(Buffer.from(copy.file.data), {
    status: 200,
    headers: {
      "Content-Type": copy.file.mimeType,
      "Content-Disposition": `inline; filename*=UTF-8''${encodeURIComponent(copy.file.fileName)}`,
      "Content-Length": copy.file.data.byteLength.toString(),
      "Cache-Control": "private, no-store",
      "X-Content-Type-Options": "nosniff",
      "X-Controlled-Copy": "true",
      "X-Document-Code": copy.document.code,
      "X-Document-Title": encodeURIComponent(copy.document.title),
      "X-Document-Revision": copy.revision.revision,
      "X-Document-Effective-At": copy.revision.effectiveAt?.toISOString() ?? "",
      "X-Controlled-Copy-As-Of": copy.asOf.toISOString(),
      "X-Content-SHA256": copy.file.checksum,
    },
  });
}
