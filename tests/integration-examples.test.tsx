import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";
import { OpenGmaoAssetCard } from "@/examples/react/OpenGmaoAssetCard";
import {
  KpiPanel,
  loadOpenGmaoKpis,
} from "@/examples/nextjs/OpenGmaoKpiPage";

describe("integration examples", () => {
  it("renders the React asset iframe with a fragment-only scoped secret and secure frame attributes", () => {
    const html = renderToStaticMarkup(
      <OpenGmaoAssetCard
        baseUrl="https://gmao.example.test"
        tokenId="token-asset"
        token="scoped-secret"
        assetCode="ASSET-100"
        theme={{ accent: "#2563eb", radius: 16 }}
      />,
    );

    expect(html).toContain("/embed/asset-card?");
    expect(html).toContain("tokenId=token-asset");
    expect(html).toContain("assetCode=ASSET-100");
    expect(html).toContain("themeAccent=%232563eb");
    expect(html).toContain("#token=scoped-secret");
    expect(html).not.toContain("token=scoped-secret&amp;");
    expect(html.toLowerCase()).toContain('referrerpolicy="strict-origin"');
    expect(html).toContain('sandbox="allow-scripts allow-same-origin"');
  });

  it("runs the Next.js server SDK example without rendering the scoped token", async () => {
    const fetchImpl = vi.fn<typeof fetch>().mockResolvedValue(
      new Response(
        JSON.stringify({
          data: {
            openWorkOrders: 7,
            overdueWorkOrders: 2,
            inProgressWorkOrders: 3,
            outOfServiceAssets: 1,
            generatedAt: "2026-08-07T12:00:00.000Z",
          },
        }),
        { status: 200, headers: { "Content-Type": "application/json" } },
      ),
    );

    const kpis = await loadOpenGmaoKpis(
      {
        baseUrl: "https://gmao.example.test",
        tokenId: "token-kpi",
        token: "server-scoped-secret",
      },
      fetchImpl,
    );
    const html = renderToStaticMarkup(<KpiPanel kpis={kpis} />);

    expect(fetchImpl).toHaveBeenCalledWith(
      "https://gmao.example.test/api/v1/public/kpis?tokenId=token-kpi",
      expect.objectContaining({
        headers: { Authorization: "Bearer server-scoped-secret" },
      }),
    );
    expect(html).toContain("Open work orders");
    expect(html).toContain(">7<");
    expect(html).toContain("Assets out of service");
    expect(html).not.toContain("server-scoped-secret");
    expect(html).not.toContain("token-kpi");
  });
});
