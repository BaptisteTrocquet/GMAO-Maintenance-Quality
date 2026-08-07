const clientSource = String.raw`(() => {
  const root = document.getElementById("gmao-status-embed");
  const message = document.getElementById("status-message");
  const badge = document.getElementById("status-badge");
  const number = document.getElementById("work-order-number");
  if (!root || !message || !badge || !number) return;

  const query = new URLSearchParams(window.location.search);
  const fragment = new URLSearchParams(window.location.hash.slice(1));
  const tokenId = query.get("tokenId");
  const token = fragment.get("token");
  const trackingId = root.dataset.trackingId;
  const proof = root.dataset.embedProof;

  if (window.location.hash) {
    window.history.replaceState(null, "", window.location.pathname + window.location.search);
  }

  if (!tokenId || !token || !trackingId || !proof) {
    message.textContent = "This tracker is not configured correctly.";
    return;
  }

  const fields = {
    requestedAt: document.getElementById("requested-at"),
    plannedStart: document.getElementById("planned-start"),
    dueAt: document.getElementById("due-at"),
    startedAt: document.getElementById("started-at"),
    completedAt: document.getElementById("completed-at"),
  };

  function displayDate(value) {
    if (!value) return "—";
    const date = new Date(value);
    return Number.isNaN(date.getTime()) ? "—" : date.toLocaleString();
  }

  function humanStatus(value) {
    return String(value || "Unknown").replaceAll("_", " ").toLowerCase().replace(/^./, (letter) => letter.toUpperCase());
  }

  function update(workOrder) {
    number.textContent = workOrder.number || "";
    badge.textContent = humanStatus(workOrder.status);
    fields.requestedAt.textContent = displayDate(workOrder.requestedAt);
    fields.plannedStart.textContent = displayDate(workOrder.plannedStart);
    fields.dueAt.textContent = displayDate(workOrder.dueAt);
    fields.startedAt.textContent = displayDate(workOrder.startedAt);
    fields.completedAt.textContent = displayDate(workOrder.completedAt);
    message.textContent = "Last updated " + new Date().toLocaleTimeString();
  }

  async function refresh() {
    try {
      const response = await fetch(
        "/api/v1/embed/request-status?tokenId=" + encodeURIComponent(tokenId) +
          "&trackingId=" + encodeURIComponent(trackingId),
        {
          headers: {
            Authorization: "Bearer " + token,
            "X-Embed-Proof": proof,
          },
          credentials: "omit",
          cache: "no-store",
        },
      );
      const body = await response.json();
      if (!response.ok) {
        message.textContent = body?.error?.message || "Status is unavailable.";
        return;
      }
      const workOrder = body?.data?.workOrder;
      if (!workOrder) {
        message.textContent = "Status is unavailable.";
        return;
      }
      update(workOrder);
      if (workOrder.status === "COMPLETED" || workOrder.status === "CANCELLED") return;
      window.setTimeout(refresh, 60_000);
    } catch {
      message.textContent = "Network error. Retrying…";
      window.setTimeout(refresh, 60_000);
    }
  }

  refresh();
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
