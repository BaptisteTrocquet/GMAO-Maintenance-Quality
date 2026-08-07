import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({ resolveToken: vi.fn(), verifyProof: vi.fn(), getKpis: vi.fn() }));
vi.mock("@/lib/db", () => ({ db: { publicMaintenanceRequestToken: { findUnique: vi.fn() } } }));
vi.mock("@/lib/public-requests/tokens", async (importOriginal) => {
  const original = await importOriginal<typeof import("@/lib/public-requests/tokens")>();
  return { ...original, resolvePublicRequestToken: mocks.resolveToken };
});
vi.mock("@/lib/embed/proof", () => ({ verifyEmbedProof: mocks.verifyProof }));
vi.mock("@/lib/public-kpis/card", () => ({ getPublicKpiCard: mocks.getKpis, PublicKpiCardError: class PublicKpiCardError extends Error { constructor(public readonly code:string,message:string){super(message)} } }));

import { GET as getPublic } from "@/app/api/v1/public/kpis/route";
import { GET as getEmbed } from "@/app/api/v1/embed/kpi-card/route";

const token = { id:"token-kpi", organizationId:"org-a", siteId:"site-a", tokenHash:"hash", mode:"EMBEDDED" as const, allowedOrigins:["https://portal.example.local"], scopes:["kpi:read"] };
const data = { openWorkOrders:12, overdueWorkOrders:3, inProgressWorkOrders:4, outOfServiceAssets:2, generatedAt:new Date("2026-08-07T12:00:00.000Z") };

function publicRequest(){return new Request("http://localhost/api/v1/public/kpis?tokenId=token-kpi",{headers:{authorization:"Bearer scoped-token",origin:"https://portal.example.local"}})}
function embedRequest(){return new Request("http://localhost/api/v1/embed/kpi-card?tokenId=token-kpi",{headers:{authorization:"Bearer scoped-token","X-Embed-Proof":"signed-proof"}})}

describe("KPI card APIs",()=>{
  beforeEach(()=>{vi.clearAllMocks();mocks.resolveToken.mockResolvedValue(token);mocks.verifyProof.mockReturnValue({parentOrigin:"https://portal.example.local"});mocks.getKpis.mockResolvedValue(data)});

  it("returns aggregate KPI data with exact public CORS",async()=>{
    const response=await getPublic(publicRequest());
    expect(response?.status).toBe(200);expect(response?.headers.get("Access-Control-Allow-Origin")).toBe("https://portal.example.local");
    expect(mocks.getKpis).toHaveBeenCalledWith({token,origin:"https://portal.example.local"});
  });

  it("rejects public access without kpi:read",async()=>{
    mocks.resolveToken.mockResolvedValue({...token,scopes:["asset:read"]});
    const response=await getPublic(publicRequest());expect(response?.status).toBe(403);expect(mocks.getKpis).not.toHaveBeenCalled();
  });

  it("uses the validated parent origin for embedded KPI data",async()=>{
    const response=await getEmbed(embedRequest());expect(response?.status).toBe(200);expect(mocks.getKpis).toHaveBeenCalledWith({token,origin:"https://portal.example.local"});
  });

  it("rejects embedded access without kpi:read before proof verification",async()=>{
    mocks.resolveToken.mockResolvedValue({...token,scopes:["document:read"]});
    const response=await getEmbed(embedRequest());expect(response?.status).toBe(403);expect(mocks.verifyProof).not.toHaveBeenCalled();expect(mocks.getKpis).not.toHaveBeenCalled();
  });
});
