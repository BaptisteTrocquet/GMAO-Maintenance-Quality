import { PrismaClient } from "@prisma/client";

const prisma = new PrismaClient();
const DEMO_EFFECTIVE_AT = new Date("2026-01-01T00:00:00.000Z");
const DEMO_WORK_ORDER_DUE_AT = new Date("2026-02-01T00:00:00.000Z");
const DEMO_PM_NEXT_DUE_AT = new Date("2026-02-15T00:00:00.000Z");

async function main() {
  const organization = await prisma.organization.upsert({
    where: { slug: "demo-operations" },
    update: {},
    create: {
      slug: "demo-operations",
      name: "Demo Operations",
      timezone: "Europe/Paris",
      locale: "en",
    },
  });

  const manager = await prisma.user.upsert({
    where: { email: "manager@example.local" },
    update: {},
    create: {
      email: "manager@example.local",
      displayName: "Demo Maintenance Manager",
    },
  });

  const technician = await prisma.user.upsert({
    where: { email: "technician@example.local" },
    update: {},
    create: {
      email: "technician@example.local",
      displayName: "Demo Technician",
    },
  });

  const approver = await prisma.user.upsert({
    where: { email: "approver@example.local" },
    update: {},
    create: {
      email: "approver@example.local",
      displayName: "Demo Document Approver",
    },
  });

  await prisma.organizationMembership.upsert({
    where: { organizationId_userId: { organizationId: organization.id, userId: manager.id } },
    update: { role: "MAINTENANCE_MANAGER", allSites: true, active: true },
    create: {
      organizationId: organization.id,
      userId: manager.id,
      role: "MAINTENANCE_MANAGER",
      allSites: true,
    },
  });

  await prisma.organizationMembership.upsert({
    where: { organizationId_userId: { organizationId: organization.id, userId: technician.id } },
    update: { role: "TECHNICIAN", allSites: true, active: true },
    create: {
      organizationId: organization.id,
      userId: technician.id,
      role: "TECHNICIAN",
      allSites: true,
    },
  });

  await prisma.organizationMembership.upsert({
    where: { organizationId_userId: { organizationId: organization.id, userId: approver.id } },
    update: { role: "QUALITY_MANAGER", allSites: true, active: true },
    create: {
      organizationId: organization.id,
      userId: approver.id,
      role: "QUALITY_MANAGER",
      allSites: true,
    },
  });

  const site = await prisma.site.upsert({
    where: { organizationId_code: { organizationId: organization.id, code: "NORTH" } },
    update: {},
    create: {
      organizationId: organization.id,
      code: "NORTH",
      name: "North Plant",
      description: "Synthetic demonstration site",
    },
  });

  let warehouse = await prisma.warehouse.findFirst({
    where: { siteId: site.id, code: "MAIN" },
  });
  if (!warehouse) {
    warehouse = await prisma.warehouse.create({
      data: {
        siteId: site.id,
        code: "MAIN",
        name: "Main spare-parts store",
        description: "Synthetic demonstration warehouse",
      },
    });
  }

  let stockBin = await prisma.stockBin.findFirst({
    where: { warehouseId: warehouse.id, code: "A-01" },
  });
  if (!stockBin) {
    stockBin = await prisma.stockBin.create({
      data: {
        warehouseId: warehouse.id,
        code: "A-01",
        name: "Rack A / 01",
        description: "Synthetic demonstration stock bin",
      },
    });
  }

  let utilities = await prisma.location.findFirst({ where: { siteId: site.id, code: "UTIL" } });
  if (!utilities) {
    utilities = await prisma.location.create({
      data: { siteId: site.id, code: "UTIL", name: "Utilities Area" },
    });
  }

  const pump = await prisma.asset.upsert({
    where: { siteId_code: { siteId: site.id, code: "P-100" } },
    update: {},
    create: {
      siteId: site.id,
      locationId: utilities.id,
      code: "P-100",
      name: "Cooling Water Pump",
      manufacturer: "Generic Industrial",
      model: "GX-200",
      serialNumber: "DEMO-0001",
      criticality: "HIGH",
    },
  });

  const existingWo = await prisma.workOrder.findUnique({ where: { number: "WO-000001" } });
  if (!existingWo) {
    await prisma.workOrder.create({
      data: {
        number: "WO-000001",
        siteId: site.id,
        assetId: pump.id,
        requesterId: manager.id,
        assigneeId: technician.id,
        title: "Investigate abnormal vibration",
        description: "Synthetic demonstration corrective request.",
        type: "CORRECTIVE",
        status: "IN_PROGRESS",
        priority: "HIGH",
        dueAt: DEMO_WORK_ORDER_DUE_AT,
      },
    });
  }

  let plan = await prisma.maintenancePlan.findFirst({
    where: { assetId: pump.id, name: "Monthly pump inspection" },
  });
  if (!plan) {
    plan = await prisma.maintenancePlan.create({
      data: {
        assetId: pump.id,
        name: "Monthly pump inspection",
        description: "Generic preventive inspection checklist.",
        frequencyValue: 1,
        frequencyUnit: "MONTH",
        nextDueAt: DEMO_PM_NEXT_DUE_AT,
        estimatedMinutes: 30,
      },
    });
  }

  const checklistCount = await prisma.maintenancePlanCheckItem.count({
    where: { maintenancePlanId: plan.id },
  });
  if (checklistCount === 0) {
    await prisma.maintenancePlanCheckItem.createMany({
      data: [
        {
          maintenancePlanId: plan.id,
          sequence: 1,
          label: "Inspect leakage",
          mandatory: true,
        },
        {
          maintenancePlanId: plan.id,
          sequence: 2,
          label: "Check abnormal noise or vibration",
          mandatory: true,
        },
        {
          maintenancePlanId: plan.id,
          sequence: 3,
          label: "Record operating hours",
          mandatory: true,
        },
      ],
    });
  }

  const sealKit = await prisma.part.upsert({
    where: { organizationId_sku: { organizationId: organization.id, sku: "SP-001" } },
    update: { active: true },
    create: {
      organizationId: organization.id,
      sku: "SP-001",
      name: "Generic seal kit",
      description: "Synthetic spare part for demo BOM.",
      unit: "EA",
      quantityOnHand: 0,
      reorderPoint: 1,
    },
  });

  const supplier = await prisma.supplier.upsert({
    where: { organizationId_code: { organizationId: organization.id, code: "SUP-001" } },
    update: { active: true },
    create: {
      organizationId: organization.id,
      code: "SUP-001",
      name: "Generic Components Supply",
      contactName: "Demo Purchasing Contact",
      email: "supplier@example.local",
      website: "https://supplier.example.local",
    },
  });

  await prisma.partSupplier.upsert({
    where: { partId_supplierId: { partId: sealKit.id, supplierId: supplier.id } },
    update: {
      supplierPartNumber: "GCS-SEAL-200",
      preferred: true,
      leadTimeDays: 7,
      minOrderQuantity: 2,
      unitCost: 24.5,
      currency: "EUR",
      active: true,
    },
    create: {
      partId: sealKit.id,
      supplierId: supplier.id,
      supplierPartNumber: "GCS-SEAL-200",
      preferred: true,
      leadTimeDays: 7,
      minOrderQuantity: 2,
      unitCost: 24.5,
      currency: "EUR",
    },
  });

  const openingKey = "synthetic-seed-opening-SP-001";
  const existingOpening = await prisma.stockMovement.findUnique({
    where: {
      binId_idempotencyKey: {
        binId: stockBin.id,
        idempotencyKey: openingKey,
      },
    },
  });
  if (!existingOpening) {
    await prisma.$transaction(async (tx) => {
      await tx.stockBalance.upsert({
        where: { binId_partId: { binId: stockBin.id, partId: sealKit.id } },
        create: { binId: stockBin.id, partId: sealKit.id, quantity: 4 },
        update: { quantity: 4 },
      });
      await tx.part.update({
        where: { id: sealKit.id },
        data: { quantityOnHand: 4 },
      });
      await tx.stockMovement.create({
        data: {
          binId: stockBin.id,
          partId: sealKit.id,
          type: "ADJUSTMENT",
          delta: 4,
          balanceAfter: 4,
          partQuantityAfter: 4,
          idempotencyKey: openingKey,
          requestHash: "synthetic-seed-opening-v1",
          referenceType: "Seed",
          referenceId: "SP-001",
          note: "Synthetic opening balance",
        },
      });
    });
  }

  await prisma.assetPart.upsert({
    where: { assetId_partId: { assetId: pump.id, partId: sealKit.id } },
    update: { quantityRecommended: 1 },
    create: { assetId: pump.id, partId: sealKit.id, quantityRecommended: 1 },
  });

  const doc = await prisma.document.upsert({
    where: {
      organizationId_code: { organizationId: organization.id, code: "WI-MNT-001" },
    },
    update: {},
    create: {
      organizationId: organization.id,
      code: "WI-MNT-001",
      title: "Generic Pump Inspection Work Instruction",
      type: "WORK_INSTRUCTION",
      owner: "Maintenance",
      description: "Synthetic controlled document used in demo data.",
    },
  });

  let revision = await prisma.documentRevision.findUnique({
    where: { documentId_revision: { documentId: doc.id, revision: "A" } },
  });
  if (!revision) {
    revision = await prisma.documentRevision.create({
      data: {
        documentId: doc.id,
        revision: "A",
        status: "EFFECTIVE",
        effectiveAt: DEMO_EFFECTIVE_AT,
        changeSummary: "Initial synthetic demo revision",
        fileName: "generic-pump-inspection.pdf",
        mimeType: "application/pdf",
      },
    });
  }

  await prisma.documentApproval.upsert({
    where: {
      documentRevisionId_approverId: {
        documentRevisionId: revision.id,
        approverId: approver.id,
      },
    },
    update: {},
    create: {
      documentRevisionId: revision.id,
      approverId: approver.id,
      decision: "APPROVED",
      decidedAt: DEMO_EFFECTIVE_AT,
      comment: "Synthetic demo approval",
    },
  });

  await prisma.assetDocument.upsert({
    where: { assetId_documentId: { assetId: pump.id, documentId: doc.id } },
    update: {},
    create: { assetId: pump.id, documentId: doc.id, relation: "APPLICABLE" },
  });
}

main()
  .catch((error) => {
    console.error(error);
    process.exitCode = 1;
  })
  .finally(async () => {
    await prisma.$disconnect();
  });
