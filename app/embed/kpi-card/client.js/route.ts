const source = String.raw`(() => {
  const root = document.getElementById("gmao-kpi-card");
  const message = document.getElementById("message");
  if (!root || !message) return;
  const query = new URLSearchParams(window.location.search);
  const fragment = new URLSearchParams(window.location.hash.slice(1));
  const tokenId = query.get("tokenId");
  const token = fragment.get("token");
  const proof = root.dataset.embedProof;
  if (window.location.hash) window.history.replaceState(null, "", window.location.pathname + window.location.search);
  if (!tokenId || !token || !proof) { message.textContent = "This KPI card is not configured correctly."; return; }

  function set(id, value) { const element = document.getElementById(id); if (element) element.textContent = String(value ?? "—"); }
  async function load() {
    try {
      const response = await fetch("/api/v1/embed/kpi-card?tokenId=" + encodeURIComponent(tokenId), {
        headers: { Authorization: "Bearer " + token, "X-Embed-Proof": proof }, credentials: "omit",
      });
      const body = await response.json();
      if (!response.ok) { message.textContent = body?.error?.message || "KPI snapshot is unavailable."; return; }
      const data = body?.data;
      set("open", data?.openWorkOrders); set("overdue", data?.overdueWorkOrders); set("in-progress", data?.inProgressWorkOrders); set("out-of-service", data?.outOfServiceAssets);
      const generated = document.getElementById("generated-at");
      if (generated) generated.textContent = data?.generatedAt ? "Updated " + new Date(data.generatedAt).toLocaleString() : "";
      message.textContent = "";
    } catch { message.textContent = "Network error. Please try again."; }
  }
  void load();
})();`;

export async function GET() {
  return new Response(source, { headers: { "Content-Type": "application/javascript; charset=utf-8", "Cache-Control": "public, max-age=3600, must-revalidate", "X-Content-Type-Options": "nosniff" } });
}
