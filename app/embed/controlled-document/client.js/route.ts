const clientSource = String.raw`(() => {
  const root = document.getElementById("gmao-controlled-document");
  const message = document.getElementById("message");
  const download = document.getElementById("download-link");
  const previewWrap = document.getElementById("preview-wrap");
  const pdfPreview = document.getElementById("pdf-preview");
  const imagePreview = document.getElementById("image-preview");
  if (!root || !message || !download || !previewWrap || !pdfPreview || !imagePreview) return;

  const query = new URLSearchParams(window.location.search);
  const fragment = new URLSearchParams(window.location.hash.slice(1));
  const tokenId = query.get("tokenId");
  const token = fragment.get("token");
  const documentCode = root.dataset.documentCode;
  const asOf = root.dataset.asOf;
  const proof = root.dataset.embedProof;
  let objectUrl = null;

  if (window.location.hash) {
    window.history.replaceState(null, "", window.location.pathname + window.location.search);
  }

  if (!tokenId || !token || !documentCode || !proof) {
    message.textContent = "This controlled-document viewer is not configured correctly.";
    return;
  }

  function setText(id, value) {
    const element = document.getElementById(id);
    if (element) element.textContent = value || "—";
  }

  function decodeHeader(value) {
    if (!value) return "";
    try { return decodeURIComponent(value); } catch { return value; }
  }

  function fileNameFromDisposition(value) {
    if (!value) return documentCode;
    const match = value.match(/filename\*=UTF-8''([^;]+)/i);
    return match ? decodeHeader(match[1]) : documentCode;
  }

  async function load() {
    const params = new URLSearchParams({ tokenId, documentCode });
    if (asOf) params.set("asOf", asOf);

    try {
      const response = await fetch("/api/v1/embed/controlled-document?" + params.toString(), {
        headers: {
          Authorization: "Bearer " + token,
          "X-Embed-Proof": proof,
        },
        credentials: "omit",
      });

      if (!response.ok) {
        const contentType = response.headers.get("content-type") || "";
        const body = contentType.includes("application/json") ? await response.json() : null;
        message.textContent = body?.error?.message || "Controlled document is unavailable.";
        return;
      }

      const blob = await response.blob();
      objectUrl = URL.createObjectURL(blob);
      const title = decodeHeader(response.headers.get("X-Document-Title"));
      const code = response.headers.get("X-Document-Code") || documentCode;
      const revision = response.headers.get("X-Document-Revision") || "";
      const effectiveAt = response.headers.get("X-Document-Effective-At") || "";
      const checksum = response.headers.get("X-Content-SHA256") || "";

      setText("document-title", title || code);
      setText("document-code", code);
      setText("revision", revision ? "Revision " + revision : null);
      setText("effective-at", effectiveAt ? "Effective " + new Date(effectiveAt).toLocaleString() : null);
      setText("checksum", checksum ? "SHA-256 " + checksum : null);

      download.href = objectUrl;
      download.download = fileNameFromDisposition(response.headers.get("Content-Disposition"));
      download.hidden = false;

      if (blob.type === "application/pdf") {
        pdfPreview.src = objectUrl;
        pdfPreview.hidden = false;
        previewWrap.hidden = false;
      } else if (["image/png", "image/jpeg", "image/webp"].includes(blob.type)) {
        imagePreview.src = objectUrl;
        imagePreview.hidden = false;
        previewWrap.hidden = false;
      } else {
        message.textContent = "Preview is not available for this file type. Download the controlled copy to open it.";
      }
    } catch {
      message.textContent = "Network error. Please try again.";
    }
  }

  window.addEventListener("pagehide", () => {
    if (objectUrl) URL.revokeObjectURL(objectUrl);
  });

  void load();
})();`;

export async function GET() {
  return new Response(clientSource, {
    headers: {
      "Content-Type": "application/javascript; charset=utf-8",
      "Cache-Control": "public, max-age=3600, must-revalidate",
      "X-Content-Type-Options": "nosniff",
    },
  });
}
