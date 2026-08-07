const clientSource = String.raw`(() => {
  const root = document.getElementById("gmao-asset-card");
  const message = document.getElementById("message");
  if (!root || !message) return;

  const query = new URLSearchParams(window.location.search);
  const fragment = new URLSearchParams(window.location.hash.slice(1));
  const tokenId = query.get("tokenId");
  const token = fragment.get("token");
  const assetCode = root.dataset.assetCode;
  const proof = root.dataset.embedProof;

  if (window.location.hash) {
    window.history.replaceState(null, "", window.location.pathname + window.location.search);
  }

  if (!tokenId || !token || !assetCode || !proof) {
    message.textContent = "This asset card is not configured correctly.";
    return;
  }

  function setText(id, value) {
    const element = document.getElementById(id);
    if (element) element.textContent = value || "—";
  }

  function formatDate(value) {
    if (!value) return "—";
    const date = new Date(value);
    return Number.isNaN(date.getTime()) ? "—" : date.toLocaleString();
  }

  async function load() {
    try {
      const response = await fetch(
        "/api/v1/embed/asset-card?tokenId=" + encodeURIComponent(tokenId) + "&assetCode=" + encodeURIComponent(assetCode),
        {
          headers: {
            Authorization: "Bearer " + token,
            "X-Embed-Proof": proof,
          },
          credentials: "omit",
        },
      );
      const body = await response.json();
      if (!response.ok) {
        message.textContent = body?.error?.message || "Asset information is unavailable.";
        return;
      }

      const asset = body?.data;
      setText("asset-name", asset?.name);
      setText("asset-code", asset?.code);
      setText("asset-status", asset?.status);
      setText("criticality", asset?.criticality);
      setText("category", asset?.category);
      setText("manufacturer", asset?.manufacturer);
      setText("model", asset?.model);
      setText("location", asset?.location ? asset.location.name + " · " + asset.location.code : null);
      setText("updated-at", formatDate(asset?.updatedAt));
      message.textContent = "";
    } catch {
      message.textContent = "Network error. Please try again.";
    }
  }

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
