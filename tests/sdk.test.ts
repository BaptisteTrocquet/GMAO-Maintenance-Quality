import { describe, expect, it, vi } from "vitest";
import { OpenGmaoApiError, OpenGmaoClient } from "@/sdk/index";

function jsonResponse(data: unknown, status = 200) {
  return new Response(JSON.stringify(data), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

describe("OpenGMAO TypeScript SDK", () => {
  it("creates a maintenance request with scoped bearer auth and idempotency", async () => {
    const fetchImpl = vi.fn<typeof fetch>().mockResolvedValue(
      jsonResponse({
        data: {
          idempotent: false,
          trackingId: "tracking-1",
          workOrder: {
            id: "wo-1",
            number: "WO-P-DEMO",
            status: "REQUESTED",
            requestedAt: "2026-08-07T12:00:00.000Z",
          },
        },
      }),
    );
    const client = new OpenGmaoClient({
      baseUrl: "https://gmao.example.test",
      tokenId: "token-1",
      token: "scoped-secret",
      fetch: fetchImpl,
    });

    const result = await client.maintenanceRequests.create(
      { title: "Unexpected vibration", assetCode: "ASSET-100" },
      { idempotencyKey: "sdk-request-0001" },
    );

    expect(result.trackingId).toBe("tracking-1");
    expect(fetchImpl).toHaveBeenCalledWith(
      "https://gmao.example.test/api/v1/public/maintenance-requests?tokenId=token-1",
      expect.objectContaining({
        method: "POST",
        headers: expect.objectContaining({
          Authorization: "Bearer scoped-secret",
          "Idempotency-Key": "sdk-request-0001",
        }),
      }),
    );
  });

  it("uses the versioned scoped endpoints for status, assets and KPIs", async () => {
    const fetchImpl = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(jsonResponse({ data: { trackingId: "tracking-1", workOrder: {} } }))
      .mockResolvedValueOnce(jsonResponse({ data: { code: "ASSET-100", name: "Example asset" } }))
      .mockResolvedValueOnce(
        jsonResponse({
          data: {
            openWorkOrders: 4,
            overdueWorkOrders: 1,
            inProgressWorkOrders: 2,
            outOfServiceAssets: 0,
            generatedAt: "2026-08-07T12:00:00.000Z",
          },
        }),
      );
    const client = new OpenGmaoClient({
      baseUrl: "https://gmao.example.test/",
      tokenId: "token-1",
      token: "scoped-secret",
      fetch: fetchImpl,
    });

    await client.maintenanceRequests.status("tracking-1");
    await client.assets.get("ASSET-100");
    await client.kpis.get();

    expect(fetchImpl.mock.calls.map(([url]) => String(url))).toEqual([
      "https://gmao.example.test/api/v1/public/request-status?tokenId=token-1&trackingId=tracking-1",
      "https://gmao.example.test/api/v1/public/assets?tokenId=token-1&assetCode=ASSET-100",
      "https://gmao.example.test/api/v1/public/kpis?tokenId=token-1",
    ]);
  });

  it("returns controlled-document bytes and traceability metadata", async () => {
    const fetchImpl = vi.fn<typeof fetch>().mockResolvedValue(
      new Response(new Uint8Array([1, 2, 3]), {
        status: 200,
        headers: {
          "Content-Type": "application/pdf",
          "Content-Disposition": "inline; filename*=UTF-8''SOP-100-r3.pdf",
          "X-Document-Code": "SOP-100",
          "X-Document-Title": "Safe%20operating%20procedure",
          "X-Document-Revision": "3",
          "X-Document-Effective-At": "2026-08-01T00:00:00.000Z",
          "X-Controlled-Copy-As-Of": "2026-08-07T12:00:00.000Z",
          "X-Content-SHA256": "a".repeat(64),
        },
      }),
    );
    const client = new OpenGmaoClient({
      baseUrl: "https://gmao.example.test",
      tokenId: "token-1",
      token: "scoped-secret",
      fetch: fetchImpl,
    });

    const result = await client.documents.download("SOP-100", {
      asOf: new Date("2026-08-07T12:00:00.000Z"),
    });

    expect([...result.data]).toEqual([1, 2, 3]);
    expect(result.fileName).toBe("SOP-100-r3.pdf");
    expect(result.documentTitle).toBe("Safe operating procedure");
    expect(result.revision).toBe("3");
    expect(result.checksumSha256).toBe("a".repeat(64));
    expect(String(fetchImpl.mock.calls[0]?.[0])).toContain("asOf=2026-08-07T12%3A00%3A00.000Z");
  });

  it("normalizes API errors into OpenGmaoApiError", async () => {
    const fetchImpl = vi.fn<typeof fetch>().mockResolvedValue(
      jsonResponse(
        { error: { code: "TOKEN_SCOPE_DENIED", message: "Scoped token cannot read KPI cards" } },
        403,
      ),
    );
    const client = new OpenGmaoClient({
      baseUrl: "https://gmao.example.test",
      tokenId: "token-1",
      token: "scoped-secret",
      fetch: fetchImpl,
    });

    await expect(client.kpis.get()).rejects.toEqual(
      expect.objectContaining<Partial<OpenGmaoApiError>>({
        name: "OpenGmaoApiError",
        status: 403,
        code: "TOKEN_SCOPE_DENIED",
        message: "Scoped token cannot read KPI cards",
      }),
    );
  });
});
