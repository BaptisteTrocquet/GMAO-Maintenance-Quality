const source = String.raw`(() => {
  const script = document.currentScript;
  if (!(script instanceof HTMLScriptElement)) return;

  const widget = script.dataset.widget || "";
  const tokenId = script.dataset.tokenId || "";
  const token = script.dataset.token || "";
  const targetSelector = script.dataset.target || "";
  script.removeAttribute("data-token");

  const widgets = {
    "maintenance-request": { path: "/embed/maintenance-request", title: "Maintenance request", height: "650px" },
    "request-status": { path: "/embed/request-status", title: "Maintenance request status", height: "430px", required: "trackingId" },
    "asset-card": { path: "/embed/asset-card", title: "Asset card", height: "430px", required: "assetCode" },
    "controlled-document": { path: "/embed/controlled-document", title: "Controlled document", height: "760px", required: "documentCode" },
    "kpi-card": { path: "/embed/kpi-card", title: "Maintenance KPIs", height: "330px" },
  };
  const config = widgets[widget];
  if (!config || !tokenId || !token) return;
  if (config.required && !script.dataset[config.required]) return;

  let target = targetSelector ? document.querySelector(targetSelector) : null;
  if (!target) {
    target = document.createElement("div");
    script.insertAdjacentElement("beforebegin", target);
  }

  const url = new URL(config.path, script.src);
  url.searchParams.set("tokenId", tokenId);
  if (script.dataset.trackingId) url.searchParams.set("trackingId", script.dataset.trackingId);
  if (script.dataset.assetCode) url.searchParams.set("assetCode", script.dataset.assetCode);
  if (script.dataset.documentCode) url.searchParams.set("documentCode", script.dataset.documentCode);
  if (script.dataset.asOf) url.searchParams.set("asOf", script.dataset.asOf);

  const themeMap = {
    themeAccent: "themeAccent",
    themeBackground: "themeBackground",
    themeSurface: "themeSurface",
    themeText: "themeText",
    themeRadius: "themeRadius",
  };
  for (const [datasetKey, queryKey] of Object.entries(themeMap)) {
    const value = script.dataset[datasetKey];
    if (value) url.searchParams.set(queryKey, value);
  }

  url.hash = new URLSearchParams({ token }).toString();

  const iframe = document.createElement("iframe");
  iframe.title = config.title;
  iframe.src = url.toString();
  iframe.referrerPolicy = "strict-origin";
  iframe.setAttribute("sandbox", "allow-scripts allow-same-origin");
  iframe.setAttribute("loading", "lazy");
  iframe.style.width = "100%";
  iframe.style.maxWidth = script.dataset.maxWidth || "900px";
  iframe.style.height = script.dataset.height || config.height;
  iframe.style.border = "0";
  iframe.style.display = "block";
  target.appendChild(iframe);
})();`;

export async function GET() {
  return new Response(source, {
    headers: {
      "Content-Type": "application/javascript; charset=utf-8",
      "Cache-Control": "public, max-age=3600, must-revalidate",
      "X-Content-Type-Options": "nosniff",
      "Cross-Origin-Resource-Policy": "cross-origin",
    },
  });
}
