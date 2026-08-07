import { PrismaClient } from "@prisma/client";

const prisma = new PrismaClient();
const DEMO_EFFECTIVE_AT = new Date("2026-01-01T00:00:00.000Z");
const DEMO_WORK_ORDER_DUE_AT = new Date("2026-02-01T00:00:00.000Z");
const DEMO_PM_NEXT_DUE_AT = new Date("2026-02-15T00:00:00.000Z");

async function main() {
  const manager = await prisma.user.upsert({
    where: { email: "manager@example.local" },
    update: {},
    create: {
      email: "manager@example.local",
      displayName: "Demo Maintenance Manager",
      role: "MAINTENANCE_MANAGER",
    },
  });

  const technician = await prisma.user.upsert({
    where: { email: "technician@example.local" },
    update: {},
    create: {
      email: "technician@example.local",
      displayName: "Demo Technician",
      role: "TECHNICIAN",
    },
  });

  const approver = await prisma.user.upsert({
    where: { email: "approver@example.local" },
    update: {},
    create: {
      email: "approver@example.local",
      displayName: "Demo Document Approver",
      role: "APPROVER",
    },
  });

  const site = await prisma.site.upsert({
    where: { code: "NORTH" },
    update: {},
    create: {
      code: "NORTH",
      name: "North Plant",
      description: "Synthetic demonstration site",
    },
  });

  let utilities = await prisma.location.findFirst({
    where: { siteId: site.id, code: "UTIL" },
  });

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

  const existingWo = await prisma.workOrder.findUnique({
    where: { number: "WO-000001" },
  });

  if (!existingWo) {
    await prisma.workOrder.create({
      data: {
        number: "WO-000001",
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

  const doc = await prisma.document.upsert({
    where: { code: "WI-MNT-001" },
    update: {},
    create: {
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
    create: {
      assetId: pump.id,
      documentId: doc.id,
      relation: "APPLICABLE",
    },
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
