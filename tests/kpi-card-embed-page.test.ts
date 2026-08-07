import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks=vi.hoisted(()=>({tokenFindUnique:vi.fn(),getScopes:vi.fn(),createProof:vi.fn()}));
vi.mock("@/lib/db",()=>({db:{publicMaintenanceRequestToken:{findUnique:mocks.tokenFindUnique}}}));
vi.mock("@/lib/public-requests/tokens",async(importOriginal)=>{const original=await importOriginal<typeof import("@/lib/public-requests/tokens")>();return{...original,getPublicRequestTokenScopes:mocks.getScopes}});
vi.mock("@/lib/embed/proof",async(importOriginal)=>{const original=await importOriginal<typeof import("@/lib/embed/proof")>();return{...original,createEmbedProof:mocks.createProof}});

import { GET } from "@/app/embed/kpi-card/route";

const token={id:"token-kpi",tokenHash:"hash",mode:"EMBEDDED" as const,allowedOrigins:["https://portal.example.local"],revokedAt:null,expiresAt:new Date("2026-09-01T00:00:00.000Z"),createdAt:new Date("2026-08-07T21:00:00.000Z")};
function request(referer="https://portal.example.local/dashboard"){return new Request("http://localhost/embed/kpi-card?tokenId=token-kpi",{headers:{referer}})}

describe("KPI card iframe",()=>{
  beforeEach(()=>{vi.clearAllMocks();mocks.tokenFindUnique.mockResolvedValue(token);mocks.getScopes.mockResolvedValue(["kpi:read"]);mocks.createProof.mockReturnValue("signed-proof")});
  it("renders aggregate-only UI with exact frame-ancestors",async()=>{const response=await GET(request());const html=await response.text();expect(response.status).toBe(200);expect(response.headers.get("Content-Security-Policy")).toContain("frame-ancestors https://portal.example.local");expect(html).toContain("Open work orders");expect(html).toContain("Assets out of service");expect(html).not.toContain("assignee");expect(html).not.toContain("workOrderId")});
  it("does not render without kpi:read",async()=>{mocks.getScopes.mockResolvedValue(["asset:read"]);const response=await GET(request());expect(response.status).toBe(404);expect(mocks.createProof).not.toHaveBeenCalled()});
  it("rejects an unconfigured parent origin",async()=>{const response=await GET(request("https://evil.example.local/page"));expect(response.status).toBe(403);expect(mocks.createProof).not.toHaveBeenCalled()});
});
