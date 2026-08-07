import { describe, expect, it } from "vitest";
import { GET } from "@/app/api/openapi.json/route";
import { PUBLIC_API_VERSION, publicOpenApiSpec } from "@/lib/api/openapi";

describe("public OpenAPI specification", () => {
  it("publishes an OpenAPI 3.1 contract for versioned public integrations", () => {
    expect(publicOpenApiSpec.openapi).toBe("3.1.0");
    expect(publicOpenApiSpec.info.version).toBe(PUBLIC_API_VERSION);
    const route = publicOpenApiSpec.paths["/api/v1/public/maintenance-requests"];
    expect(route.post.operationId).toBe("createPublicMaintenanceRequestV1");
    expect(route.post.security).toEqual([{ scopedPublicRequestToken: [] }]);
    expect(route.post.parameters).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ name: "tokenId", in: "query", required: true }),
        expect.objectContaining({ name: "Idempotency-Key", in: "header", required: true }),
        expect.objectContaining({ name: "Origin", in: "header" }),
      ]),
    );
    expect(route.post.responses).toHaveProperty("429");
  });

  it("documents the site-scoped asset:read card contract", () => {
    const route = publicOpenApiSpec.paths["/api/v1/public/assets"];
    expect(route.get.operationId).toBe("getPublicAssetCardV1");
    expect(route.get.description).toContain("asset:read");
    expect(route.get.parameters).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ name: "tokenId", in: "query", required: true }),
        expect.objectContaining({ name: "assetCode", in: "query", required: true }),
      ]),
    );
    expect(publicOpenApiSpec.components.schemas.PublicAssetCard.properties).not.toHaveProperty(
      "serialNumber",
    );
    expect(publicOpenApiSpec.components.schemas.PublicAssetCard.properties).not.toHaveProperty(
      "description",
    );
  });

  it("documents the effective integrity-verified document:read contract", () => {
    const route = publicOpenApiSpec.paths["/api/v1/public/documents"];
    expect(route.get.operationId).toBe("getPublicControlledDocumentV1");
    expect(route.get.description).toContain("document:read");
    expect(route.get.description).toContain("effective revision");
    expect(route.get.description).toContain("SHA-256");
    expect(route.get.parameters).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ name: "tokenId", in: "query", required: true }),
        expect.objectContaining({ name: "documentCode", in: "query", required: true }),
        expect.objectContaining({ name: "asOf", in: "query", required: false }),
      ]),
    );
    expect(route.get.responses["200"].headers).toHaveProperty("X-Content-SHA256");
    expect(route.get.responses).toHaveProperty("409");
  });

  it("documents scoped bearer credentials rather than administrator secrets", () => {
    expect(publicOpenApiSpec.components.securitySchemes.scopedPublicRequestToken).toMatchObject({
      type: "http",
      scheme: "bearer",
    });
    expect(publicOpenApiSpec.components.securitySchemes.scopedPublicRequestToken.description).toContain(
      "not an administrator credential",
    );
  });

  it("serves the specification as JSON with an explicit API spec version header", async () => {
    const response = await GET();
    expect(response.status).toBe(200);
    expect(response.headers.get("X-API-Spec-Version")).toBe(PUBLIC_API_VERSION);
    await expect(response.json()).resolves.toEqual(publicOpenApiSpec);
  });
});
