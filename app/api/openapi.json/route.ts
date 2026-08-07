import { publicOpenApiSpec } from "@/lib/api/openapi";

export async function GET() {
  return Response.json(publicOpenApiSpec, {
    headers: {
      "Cache-Control": "public, max-age=300, must-revalidate",
      "X-API-Spec-Version": publicOpenApiSpec.info.version,
    },
  });
}
