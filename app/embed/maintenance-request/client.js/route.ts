const clientSource = String.raw`(() => {
  const root = document.getElementById("gmao-embed");
  const form = document.getElementById("request-form");
  const status = document.getElementById("status");
  if (!root || !form || !status) return;

  const query = new URLSearchParams(window.location.search);
  const fragment = new URLSearchParams(window.location.hash.slice(1));
  const tokenId = query.get("tokenId");
  const token = fragment.get("token");
  const proof = root.dataset.embedProof;

  // The scoped token arrives only in the URL fragment, which is never sent in
  // the iframe HTTP request. Remove it from visible history immediately after
  // bootstrapping; the secret remains only in this isolated iframe JS context.
  if (window.location.hash) {
    window.history.replaceState(null, "", window.location.pathname + window.location.search);
  }

  if (!tokenId || !token || !proof) {
    status.textContent = "This embed is not configured correctly.";
    form.querySelector("button")?.setAttribute("disabled", "disabled");
    return;
  }

  function parentOrigin() {
    try {
      return document.referrer ? new URL(document.referrer).origin : null;
    } catch {
      return null;
    }
  }

  form.addEventListener("submit", async (event) => {
    event.preventDefault();
    const button = form.querySelector("button");
    button?.setAttribute("disabled", "disabled");
    status.textContent = "Sending…";

    const data = new FormData(form);
    const payload = {
      title: String(data.get("title") || "").trim(),
      description: String(data.get("description") || "").trim() || null,
      assetCode: String(data.get("assetCode") || "").trim() || null,
      requesterName: String(data.get("requesterName") || "").trim() || null,
      requesterEmail: String(data.get("requesterEmail") || "").trim() || null,
    };

    if (!payload.title) {
      status.textContent = "A title is required.";
      button?.removeAttribute("disabled");
      return;
    }

    try {
      const response = await fetch(
        "/api/v1/embed/maintenance-requests?tokenId=" + encodeURIComponent(tokenId),
        {
          method: "POST",
          headers: {
            Authorization: "Bearer " + token,
            "Content-Type": "application/json",
            "Idempotency-Key": crypto.randomUUID(),
            "X-Embed-Proof": proof,
          },
          body: JSON.stringify(payload),
          credentials: "omit",
        },
      );
      const body = await response.json();
      if (!response.ok) {
        status.textContent = body?.error?.message || "The request could not be sent.";
        return;
      }

      const workOrder = body?.data?.workOrder;
      status.textContent = workOrder?.number
        ? "Request sent: " + workOrder.number
        : "Request sent successfully.";
      form.reset();

      const origin = parentOrigin();
      if (origin && window.parent !== window) {
        window.parent.postMessage(
          {
            type: "opengmao:maintenance-request-created",
            workOrder: workOrder ? { number: workOrder.number, status: workOrder.status } : null,
          },
          origin,
        );
      }
    } catch {
      status.textContent = "Network error. Please try again.";
    } finally {
      button?.removeAttribute("disabled");
    }
  });
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
