import { PrismaClient } from "@prisma/client";
import { createPostgresVectorStore } from "@/lib/ai/postgres-vector-store";

const prisma = new PrismaClient();
const NAMESPACE = "ci-controlled-documents";
const LIMIT_NAMESPACE = "ci-vector-limit";

async function main() {
  const organization = await prisma.organization.findUnique({
    where: { slug: "demo-operations" },
    select: { id: true },
  });
  if (!organization) throw new Error("Synthetic demo organization is unavailable");

  const site = await prisma.site.findFirst({
    where: { organizationId: organization.id, code: "NORTH" },
    select: { id: true },
  });
  if (!site) throw new Error("Synthetic demo site is unavailable");

  await prisma.aiVectorRecord.deleteMany({
    where: {
      organizationId: organization.id,
      namespace: { in: [NAMESPACE, LIMIT_NAMESPACE] },
    },
  });

  try {
    const store = createPostgresVectorStore(prisma);

    await store.upsert({
      scope: { organizationId: organization.id, siteId: null },
      namespace: NAMESPACE,
      dimensions: 3,
      records: [
        {
          id: "rev-a",
          vector: [1, 0, 0],
          metadata: { documentId: "doc-a", revisionId: "rev-a", kind: "SOP", revision: 1 },
        },
        {
          id: "rev-b",
          vector: [0.8, 0.2, 0],
          metadata: { documentId: "doc-b", revisionId: "rev-b", kind: "SOP", revision: 2 },
        },
        {
          id: "rev-c",
          vector: [0, 1, 0],
          metadata: { documentId: "doc-c", revisionId: "rev-c", kind: "WI", revision: 1 },
        },
      ],
    });

    await store.upsert({
      scope: { organizationId: organization.id, siteId: site.id },
      namespace: NAMESPACE,
      dimensions: 3,
      records: [
        {
          id: "rev-site",
          vector: [1, 0, 0],
          metadata: { documentId: "doc-site", revisionId: "rev-site", kind: "SOP" },
        },
      ],
    });

    const restarted = createPostgresVectorStore(prisma);
    const ranked = await restarted.query({
      scope: { organizationId: organization.id, siteId: null },
      namespace: NAMESPACE,
      dimensions: 3,
      vector: [1, 0, 0],
      limit: 3,
    });

    if (ranked.map((hit) => hit.id).join(",") !== "rev-a,rev-b,rev-c") {
      throw new Error("PostgreSQL vector ranking is not deterministic");
    }
    if (ranked.some((hit) => hit.siteId !== null)) {
      throw new Error("Organization-level vector query crossed into a site scope");
    }

    const filtered = await restarted.query({
      scope: { organizationId: organization.id, siteId: null },
      namespace: NAMESPACE,
      dimensions: 3,
      vector: [1, 0, 0],
      limit: 5,
      filter: { kind: "SOP" },
    });
    if (filtered.map((hit) => hit.id).join(",") !== "rev-a,rev-b") {
      throw new Error("PostgreSQL vector metadata filtering is incorrect");
    }

    const siteHits = await restarted.query({
      scope: { organizationId: organization.id, siteId: site.id },
      namespace: NAMESPACE,
      dimensions: 3,
      vector: [1, 0, 0],
      limit: 5,
    });
    if (siteHits.length !== 1 || siteHits[0]?.id !== "rev-site" || siteHits[0]?.siteId !== site.id) {
      throw new Error("PostgreSQL vector site scope is not exact");
    }

    const foreignOrganizationHits = await restarted.query({
      scope: { organizationId: "other-organization", siteId: null },
      namespace: NAMESPACE,
      dimensions: 3,
      vector: [1, 0, 0],
      limit: 5,
    });
    if (foreignOrganizationHits.length !== 0) {
      throw new Error("PostgreSQL vector query crossed organization scope");
    }

    await restarted.upsert({
      scope: { organizationId: organization.id, siteId: null },
      namespace: NAMESPACE,
      dimensions: 3,
      records: [
        {
          id: "rev-c",
          vector: [1, 0, 0],
          metadata: { documentId: "doc-c", revisionId: "rev-c", kind: "SOP", revision: 3 },
        },
      ],
    });
    const updated = await restarted.query({
      scope: { organizationId: organization.id, siteId: null },
      namespace: NAMESPACE,
      dimensions: 3,
      vector: [1, 0, 0],
      limit: 5,
      filter: { revision: 3 },
    });
    if (updated.length !== 1 || updated[0]?.id !== "rev-c" || updated[0]?.score !== 1) {
      throw new Error("PostgreSQL vector upsert did not replace the stored vector and metadata");
    }

    const deleted = await restarted.delete({
      scope: { organizationId: organization.id, siteId: null },
      namespace: NAMESPACE,
      ids: ["rev-b"],
    });
    if (deleted.deleted !== 1) throw new Error("PostgreSQL vector delete count is incorrect");

    const afterDelete = await restarted.query({
      scope: { organizationId: organization.id, siteId: null },
      namespace: NAMESPACE,
      dimensions: 3,
      vector: [1, 0, 0],
      limit: 5,
    });
    if (afterDelete.some((hit) => hit.id === "rev-b")) {
      throw new Error("PostgreSQL vector deletion did not persist");
    }

    const bounded = createPostgresVectorStore(prisma, { maxCandidates: 2 });
    await bounded.upsert({
      scope: { organizationId: organization.id, siteId: null },
      namespace: LIMIT_NAMESPACE,
      dimensions: 2,
      records: [
        { id: "a", vector: [1, 0], metadata: {} },
        { id: "b", vector: [0, 1], metadata: {} },
        { id: "c", vector: [1, 1], metadata: {} },
      ],
    });

    let boundedFailure = false;
    try {
      await bounded.query({
        scope: { organizationId: organization.id, siteId: null },
        namespace: LIMIT_NAMESPACE,
        dimensions: 2,
        vector: [1, 0],
      });
    } catch (error) {
      boundedFailure =
        typeof error === "object" && error !== null && "code" in error && error.code === "STORE_ERROR";
    }
    if (!boundedFailure) throw new Error("PostgreSQL vector candidate safety limit did not fail closed");

    console.log("PostgreSQL vector store database drill passed");
  } finally {
    await prisma.aiVectorRecord.deleteMany({
      where: {
        organizationId: organization.id,
        namespace: { in: [NAMESPACE, LIMIT_NAMESPACE] },
      },
    });
  }
}

main()
  .catch((error) => {
    console.error(error);
    process.exitCode = 1;
  })
  .finally(async () => {
    await prisma.$disconnect();
  });
