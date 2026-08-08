-- CreateSchema
CREATE SCHEMA IF NOT EXISTS "public";

-- CreateEnum
CREATE TYPE "MembershipRole" AS ENUM ('OWNER', 'ADMIN', 'MAINTENANCE_MANAGER', 'TECHNICIAN', 'QUALITY_MANAGER', 'OPERATOR', 'VIEWER');

-- CreateEnum
CREATE TYPE "InvitationStatus" AS ENUM ('PENDING', 'ACCEPTED', 'REVOKED', 'EXPIRED');

-- CreateEnum
CREATE TYPE "AssetStatus" AS ENUM ('ACTIVE', 'INACTIVE', 'OUT_OF_SERVICE', 'DECOMMISSIONED');

-- CreateEnum
CREATE TYPE "Criticality" AS ENUM ('LOW', 'MEDIUM', 'HIGH', 'CRITICAL');

-- CreateEnum
CREATE TYPE "WorkOrderType" AS ENUM ('CORRECTIVE', 'PREVENTIVE', 'INSPECTION', 'IMPROVEMENT', 'SAFETY', 'OTHER');

-- CreateEnum
CREATE TYPE "WorkOrderStatus" AS ENUM ('REQUESTED', 'APPROVED', 'PLANNED', 'IN_PROGRESS', 'BLOCKED', 'COMPLETED', 'CANCELLED');

-- CreateEnum
CREATE TYPE "Priority" AS ENUM ('LOW', 'NORMAL', 'HIGH', 'URGENT');

-- CreateEnum
CREATE TYPE "DocumentStatus" AS ENUM ('DRAFT', 'IN_REVIEW', 'APPROVED', 'EFFECTIVE', 'OBSOLETE', 'REJECTED');

-- CreateEnum
CREATE TYPE "ApprovalDecision" AS ENUM ('PENDING', 'APPROVED', 'REJECTED');

-- CreateEnum
CREATE TYPE "MaintenanceFrequencyUnit" AS ENUM ('DAY', 'WEEK', 'MONTH', 'YEAR', 'METER');

-- CreateEnum
CREATE TYPE "PublicRequestMode" AS ENUM ('PUBLIC', 'EMBEDDED');

-- CreateEnum
CREATE TYPE "MaintenanceReminderStatus" AS ENUM ('ACTIVE', 'DISMISSED', 'EXPIRED');

-- CreateEnum
CREATE TYPE "StockMovementType" AS ENUM ('RECEIPT', 'ISSUE', 'ADJUSTMENT', 'WORK_ORDER_CONSUMPTION');

-- CreateTable
CREATE TABLE "User" (
    "id" TEXT NOT NULL,
    "email" TEXT NOT NULL,
    "displayName" TEXT NOT NULL,
    "active" BOOLEAN NOT NULL DEFAULT true,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "User_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Session" (
    "id" TEXT NOT NULL,
    "tokenHash" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "expiresAt" TIMESTAMP(3) NOT NULL,
    "revokedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "lastSeenAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "Session_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Organization" (
    "id" TEXT NOT NULL,
    "slug" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "timezone" TEXT NOT NULL DEFAULT 'UTC',
    "locale" TEXT NOT NULL DEFAULT 'en',
    "active" BOOLEAN NOT NULL DEFAULT true,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "Organization_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "OrganizationInvitation" (
    "id" TEXT NOT NULL,
    "organizationId" TEXT NOT NULL,
    "email" TEXT NOT NULL,
    "role" "MembershipRole" NOT NULL DEFAULT 'VIEWER',
    "tokenHash" TEXT NOT NULL,
    "status" "InvitationStatus" NOT NULL DEFAULT 'PENDING',
    "allSites" BOOLEAN NOT NULL DEFAULT false,
    "expiresAt" TIMESTAMP(3) NOT NULL,
    "createdById" TEXT NOT NULL,
    "acceptedById" TEXT,
    "acceptedAt" TIMESTAMP(3),
    "revokedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "OrganizationInvitation_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "OrganizationMembership" (
    "id" TEXT NOT NULL,
    "organizationId" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "role" "MembershipRole" NOT NULL DEFAULT 'VIEWER',
    "allSites" BOOLEAN NOT NULL DEFAULT false,
    "active" BOOLEAN NOT NULL DEFAULT true,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "OrganizationMembership_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "SiteMembership" (
    "id" TEXT NOT NULL,
    "organizationMembershipId" TEXT NOT NULL,
    "siteId" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "SiteMembership_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Site" (
    "id" TEXT NOT NULL,
    "organizationId" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "code" TEXT NOT NULL,
    "description" TEXT,
    "active" BOOLEAN NOT NULL DEFAULT true,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "Site_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "MaintenanceTeam" (
    "id" TEXT NOT NULL,
    "siteId" TEXT NOT NULL,
    "code" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "description" TEXT,
    "active" BOOLEAN NOT NULL DEFAULT true,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "MaintenanceTeam_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "MaintenanceTeamMember" (
    "teamId" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "MaintenanceTeamMember_pkey" PRIMARY KEY ("teamId","userId")
);

-- CreateTable
CREATE TABLE "Location" (
    "id" TEXT NOT NULL,
    "siteId" TEXT NOT NULL,
    "parentId" TEXT,
    "name" TEXT NOT NULL,
    "code" TEXT NOT NULL,
    "description" TEXT,

    CONSTRAINT "Location_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Asset" (
    "id" TEXT NOT NULL,
    "siteId" TEXT NOT NULL,
    "locationId" TEXT,
    "parentAssetId" TEXT,
    "code" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "description" TEXT,
    "category" TEXT,
    "manufacturer" TEXT,
    "model" TEXT,
    "serialNumber" TEXT,
    "status" "AssetStatus" NOT NULL DEFAULT 'ACTIVE',
    "criticality" "Criticality" NOT NULL DEFAULT 'MEDIUM',
    "installedAt" TIMESTAMP(3),
    "commissionedAt" TIMESTAMP(3),
    "decommissionedAt" TIMESTAMP(3),
    "archivedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "Asset_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "AssetStatusHistory" (
    "id" TEXT NOT NULL,
    "assetId" TEXT NOT NULL,
    "fromStatus" "AssetStatus",
    "toStatus" "AssetStatus" NOT NULL,
    "note" TEXT,
    "changedById" TEXT,
    "changedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "AssetStatusHistory_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "AssetAttachment" (
    "id" TEXT NOT NULL,
    "assetId" TEXT NOT NULL,
    "fileName" TEXT NOT NULL,
    "storageKey" TEXT NOT NULL,
    "mimeType" TEXT,
    "sizeBytes" INTEGER,
    "kind" TEXT NOT NULL DEFAULT 'ATTACHMENT',
    "createdBy" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "AssetAttachment_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "WorkOrder" (
    "id" TEXT NOT NULL,
    "number" TEXT NOT NULL,
    "siteId" TEXT NOT NULL,
    "assetId" TEXT,
    "requesterId" TEXT,
    "assigneeId" TEXT,
    "teamId" TEXT,
    "title" TEXT NOT NULL,
    "description" TEXT,
    "type" "WorkOrderType" NOT NULL,
    "status" "WorkOrderStatus" NOT NULL DEFAULT 'REQUESTED',
    "priority" "Priority" NOT NULL DEFAULT 'NORMAL',
    "requestedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "plannedStart" TIMESTAMP(3),
    "dueAt" TIMESTAMP(3),
    "startedAt" TIMESTAMP(3),
    "completedAt" TIMESTAMP(3),
    "downtimeMinutes" INTEGER,
    "laborMinutes" INTEGER,
    "completionNote" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "WorkOrder_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "WorkOrderCheckItem" (
    "id" TEXT NOT NULL,
    "workOrderId" TEXT NOT NULL,
    "label" TEXT NOT NULL,
    "completed" BOOLEAN NOT NULL DEFAULT false,
    "note" TEXT,

    CONSTRAINT "WorkOrderCheckItem_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "WorkOrderAttachment" (
    "id" TEXT NOT NULL,
    "workOrderId" TEXT NOT NULL,
    "fileName" TEXT NOT NULL,
    "storageKey" TEXT NOT NULL,
    "mimeType" TEXT,
    "sizeBytes" INTEGER,
    "kind" TEXT NOT NULL DEFAULT 'ATTACHMENT',
    "createdBy" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "WorkOrderAttachment_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "MaintenanceReminder" (
    "id" TEXT NOT NULL,
    "siteId" TEXT NOT NULL,
    "workOrderId" TEXT NOT NULL,
    "occurrenceKey" TEXT NOT NULL,
    "title" TEXT NOT NULL,
    "assetCode" TEXT,
    "dueAt" TIMESTAMP(3) NOT NULL,
    "remindAt" TIMESTAMP(3) NOT NULL,
    "leadDays" INTEGER NOT NULL,
    "status" "MaintenanceReminderStatus" NOT NULL DEFAULT 'ACTIVE',
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "dismissedAt" TIMESTAMP(3),

    CONSTRAINT "MaintenanceReminder_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "MaintenancePlan" (
    "id" TEXT NOT NULL,
    "assetId" TEXT NOT NULL,
    "meterId" TEXT,
    "name" TEXT NOT NULL,
    "description" TEXT,
    "frequencyValue" INTEGER NOT NULL,
    "frequencyUnit" "MaintenanceFrequencyUnit" NOT NULL,
    "nextDueAt" TIMESTAMP(3),
    "nextDueMeterValue" DOUBLE PRECISION,
    "active" BOOLEAN NOT NULL DEFAULT true,
    "estimatedMinutes" INTEGER,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "MaintenancePlan_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "MaintenancePlanCheckItem" (
    "id" TEXT NOT NULL,
    "maintenancePlanId" TEXT NOT NULL,
    "sequence" INTEGER NOT NULL,
    "label" TEXT NOT NULL,
    "mandatory" BOOLEAN NOT NULL DEFAULT true,

    CONSTRAINT "MaintenancePlanCheckItem_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Part" (
    "id" TEXT NOT NULL,
    "organizationId" TEXT NOT NULL,
    "sku" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "description" TEXT,
    "unit" TEXT NOT NULL DEFAULT 'EA',
    "quantityOnHand" DOUBLE PRECISION NOT NULL DEFAULT 0,
    "reorderPoint" DOUBLE PRECISION NOT NULL DEFAULT 0,
    "unitCost" DECIMAL(14,4),
    "active" BOOLEAN NOT NULL DEFAULT true,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "Part_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Supplier" (
    "id" TEXT NOT NULL,
    "organizationId" TEXT NOT NULL,
    "code" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "contactName" TEXT,
    "email" TEXT,
    "phone" TEXT,
    "website" TEXT,
    "active" BOOLEAN NOT NULL DEFAULT true,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "Supplier_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "PartSupplier" (
    "partId" TEXT NOT NULL,
    "supplierId" TEXT NOT NULL,
    "supplierPartNumber" TEXT NOT NULL,
    "preferred" BOOLEAN NOT NULL DEFAULT false,
    "leadTimeDays" INTEGER,
    "minOrderQuantity" DOUBLE PRECISION,
    "unitCost" DECIMAL(14,4),
    "currency" TEXT NOT NULL DEFAULT 'EUR',
    "active" BOOLEAN NOT NULL DEFAULT true,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "PartSupplier_pkey" PRIMARY KEY ("partId","supplierId")
);

-- CreateTable
CREATE TABLE "Warehouse" (
    "id" TEXT NOT NULL,
    "siteId" TEXT NOT NULL,
    "code" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "description" TEXT,
    "active" BOOLEAN NOT NULL DEFAULT true,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "Warehouse_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "StockBin" (
    "id" TEXT NOT NULL,
    "warehouseId" TEXT NOT NULL,
    "code" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "description" TEXT,
    "active" BOOLEAN NOT NULL DEFAULT true,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "StockBin_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "StockBalance" (
    "id" TEXT NOT NULL,
    "binId" TEXT NOT NULL,
    "partId" TEXT NOT NULL,
    "quantity" DOUBLE PRECISION NOT NULL DEFAULT 0,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "StockBalance_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "StockMovement" (
    "id" TEXT NOT NULL,
    "binId" TEXT NOT NULL,
    "partId" TEXT NOT NULL,
    "type" "StockMovementType" NOT NULL,
    "delta" DOUBLE PRECISION NOT NULL,
    "balanceAfter" DOUBLE PRECISION NOT NULL,
    "partQuantityAfter" DOUBLE PRECISION NOT NULL,
    "unitCost" DECIMAL(14,4),
    "referenceType" TEXT,
    "referenceId" TEXT,
    "idempotencyKey" TEXT NOT NULL,
    "requestHash" TEXT NOT NULL,
    "actorId" TEXT,
    "note" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "StockMovement_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "AssetPart" (
    "assetId" TEXT NOT NULL,
    "partId" TEXT NOT NULL,
    "quantityRecommended" DOUBLE PRECISION,

    CONSTRAINT "AssetPart_pkey" PRIMARY KEY ("assetId","partId")
);

-- CreateTable
CREATE TABLE "WorkOrderPart" (
    "workOrderId" TEXT NOT NULL,
    "partId" TEXT NOT NULL,
    "quantity" DOUBLE PRECISION NOT NULL,
    "unitCost" DECIMAL(14,4),

    CONSTRAINT "WorkOrderPart_pkey" PRIMARY KEY ("workOrderId","partId")
);

-- CreateTable
CREATE TABLE "WorkOrderPartConsumption" (
    "id" TEXT NOT NULL,
    "workOrderId" TEXT NOT NULL,
    "partId" TEXT NOT NULL,
    "binId" TEXT,
    "quantity" DOUBLE PRECISION NOT NULL,
    "unitCost" DECIMAL(14,4),
    "idempotencyKey" TEXT NOT NULL,
    "actorId" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "WorkOrderPartConsumption_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Document" (
    "id" TEXT NOT NULL,
    "organizationId" TEXT NOT NULL,
    "code" TEXT NOT NULL,
    "title" TEXT NOT NULL,
    "type" TEXT NOT NULL,
    "owner" TEXT,
    "description" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "Document_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "DocumentRevision" (
    "id" TEXT NOT NULL,
    "documentId" TEXT NOT NULL,
    "revision" TEXT NOT NULL,
    "status" "DocumentStatus" NOT NULL DEFAULT 'DRAFT',
    "effectiveAt" TIMESTAMP(3),
    "expiresAt" TIMESTAMP(3),
    "storageKey" TEXT,
    "fileName" TEXT,
    "mimeType" TEXT,
    "checksum" TEXT,
    "changeSummary" TEXT,
    "createdBy" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "DocumentRevision_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "DocumentApproval" (
    "id" TEXT NOT NULL,
    "documentRevisionId" TEXT NOT NULL,
    "approverId" TEXT NOT NULL,
    "decision" "ApprovalDecision" NOT NULL DEFAULT 'PENDING',
    "comment" TEXT,
    "decidedAt" TIMESTAMP(3),

    CONSTRAINT "DocumentApproval_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "AssetDocument" (
    "assetId" TEXT NOT NULL,
    "documentId" TEXT NOT NULL,
    "relation" TEXT NOT NULL DEFAULT 'APPLICABLE',

    CONSTRAINT "AssetDocument_pkey" PRIMARY KEY ("assetId","documentId")
);

-- CreateTable
CREATE TABLE "WorkOrderDocument" (
    "workOrderId" TEXT NOT NULL,
    "documentId" TEXT NOT NULL,

    CONSTRAINT "WorkOrderDocument_pkey" PRIMARY KEY ("workOrderId","documentId")
);

-- CreateTable
CREATE TABLE "Meter" (
    "id" TEXT NOT NULL,
    "assetId" TEXT NOT NULL,
    "code" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "unit" TEXT NOT NULL,
    "allowRollover" BOOLEAN NOT NULL DEFAULT false,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "Meter_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "MeterReading" (
    "id" TEXT NOT NULL,
    "meterId" TEXT NOT NULL,
    "value" DOUBLE PRECISION NOT NULL,
    "note" TEXT,
    "readingAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "MeterReading_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "PublicMaintenanceRequestToken" (
    "id" TEXT NOT NULL,
    "organizationId" TEXT NOT NULL,
    "siteId" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "tokenHash" TEXT NOT NULL,
    "mode" "PublicRequestMode" NOT NULL DEFAULT 'PUBLIC',
    "allowedOrigins" TEXT[] DEFAULT ARRAY[]::TEXT[],
    "expiresAt" TIMESTAMP(3),
    "revokedAt" TIMESTAMP(3),
    "createdById" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "lastUsedAt" TIMESTAMP(3),

    CONSTRAINT "PublicMaintenanceRequestToken_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "PublicMaintenanceRequestSubmission" (
    "id" TEXT NOT NULL,
    "tokenId" TEXT NOT NULL,
    "workOrderId" TEXT NOT NULL,
    "idempotencyKey" TEXT NOT NULL,
    "requesterName" TEXT,
    "requesterEmail" TEXT,
    "requesterRef" TEXT,
    "origin" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "PublicMaintenanceRequestSubmission_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "AuditLog" (
    "id" TEXT NOT NULL,
    "actorId" TEXT,
    "entityType" TEXT NOT NULL,
    "entityId" TEXT NOT NULL,
    "action" TEXT NOT NULL,
    "beforeJson" TEXT,
    "afterJson" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "AuditLog_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "User_email_key" ON "User"("email");

-- CreateIndex
CREATE UNIQUE INDEX "Session_tokenHash_key" ON "Session"("tokenHash");

-- CreateIndex
CREATE INDEX "Session_userId_revokedAt_idx" ON "Session"("userId", "revokedAt");

-- CreateIndex
CREATE INDEX "Session_expiresAt_idx" ON "Session"("expiresAt");

-- CreateIndex
CREATE UNIQUE INDEX "Organization_slug_key" ON "Organization"("slug");

-- CreateIndex
CREATE UNIQUE INDEX "OrganizationInvitation_tokenHash_key" ON "OrganizationInvitation"("tokenHash");

-- CreateIndex
CREATE INDEX "OrganizationInvitation_organizationId_email_status_idx" ON "OrganizationInvitation"("organizationId", "email", "status");

-- CreateIndex
CREATE INDEX "OrganizationInvitation_expiresAt_status_idx" ON "OrganizationInvitation"("expiresAt", "status");

-- CreateIndex
CREATE INDEX "OrganizationMembership_userId_active_idx" ON "OrganizationMembership"("userId", "active");

-- CreateIndex
CREATE UNIQUE INDEX "OrganizationMembership_organizationId_userId_key" ON "OrganizationMembership"("organizationId", "userId");

-- CreateIndex
CREATE INDEX "SiteMembership_siteId_idx" ON "SiteMembership"("siteId");

-- CreateIndex
CREATE UNIQUE INDEX "SiteMembership_organizationMembershipId_siteId_key" ON "SiteMembership"("organizationMembershipId", "siteId");

-- CreateIndex
CREATE INDEX "Site_organizationId_active_idx" ON "Site"("organizationId", "active");

-- CreateIndex
CREATE UNIQUE INDEX "Site_organizationId_code_key" ON "Site"("organizationId", "code");

-- CreateIndex
CREATE INDEX "MaintenanceTeam_siteId_active_idx" ON "MaintenanceTeam"("siteId", "active");

-- CreateIndex
CREATE UNIQUE INDEX "MaintenanceTeam_siteId_code_key" ON "MaintenanceTeam"("siteId", "code");

-- CreateIndex
CREATE INDEX "MaintenanceTeamMember_userId_idx" ON "MaintenanceTeamMember"("userId");

-- CreateIndex
CREATE UNIQUE INDEX "Location_siteId_code_key" ON "Location"("siteId", "code");

-- CreateIndex
CREATE INDEX "Asset_siteId_archivedAt_idx" ON "Asset"("siteId", "archivedAt");

-- CreateIndex
CREATE UNIQUE INDEX "Asset_siteId_code_key" ON "Asset"("siteId", "code");

-- CreateIndex
CREATE INDEX "AssetStatusHistory_assetId_changedAt_idx" ON "AssetStatusHistory"("assetId", "changedAt");

-- CreateIndex
CREATE INDEX "AssetAttachment_assetId_createdAt_idx" ON "AssetAttachment"("assetId", "createdAt");

-- CreateIndex
CREATE UNIQUE INDEX "WorkOrder_number_key" ON "WorkOrder"("number");

-- CreateIndex
CREATE INDEX "WorkOrder_siteId_status_requestedAt_idx" ON "WorkOrder"("siteId", "status", "requestedAt");

-- CreateIndex
CREATE INDEX "WorkOrder_teamId_idx" ON "WorkOrder"("teamId");

-- CreateIndex
CREATE INDEX "WorkOrderAttachment_workOrderId_createdAt_idx" ON "WorkOrderAttachment"("workOrderId", "createdAt");

-- CreateIndex
CREATE UNIQUE INDEX "MaintenanceReminder_occurrenceKey_key" ON "MaintenanceReminder"("occurrenceKey");

-- CreateIndex
CREATE INDEX "MaintenanceReminder_siteId_status_dueAt_idx" ON "MaintenanceReminder"("siteId", "status", "dueAt");

-- CreateIndex
CREATE INDEX "MaintenanceReminder_workOrderId_status_idx" ON "MaintenanceReminder"("workOrderId", "status");

-- CreateIndex
CREATE INDEX "MaintenancePlan_meterId_active_idx" ON "MaintenancePlan"("meterId", "active");

-- CreateIndex
CREATE INDEX "Part_organizationId_active_idx" ON "Part"("organizationId", "active");

-- CreateIndex
CREATE UNIQUE INDEX "Part_organizationId_sku_key" ON "Part"("organizationId", "sku");

-- CreateIndex
CREATE INDEX "Supplier_organizationId_active_idx" ON "Supplier"("organizationId", "active");

-- CreateIndex
CREATE UNIQUE INDEX "Supplier_organizationId_code_key" ON "Supplier"("organizationId", "code");

-- CreateIndex
CREATE INDEX "PartSupplier_supplierId_active_idx" ON "PartSupplier"("supplierId", "active");

-- CreateIndex
CREATE INDEX "PartSupplier_partId_preferred_active_idx" ON "PartSupplier"("partId", "preferred", "active");

-- CreateIndex
CREATE INDEX "Warehouse_siteId_active_idx" ON "Warehouse"("siteId", "active");

-- CreateIndex
CREATE UNIQUE INDEX "Warehouse_siteId_code_key" ON "Warehouse"("siteId", "code");

-- CreateIndex
CREATE INDEX "StockBin_warehouseId_active_idx" ON "StockBin"("warehouseId", "active");

-- CreateIndex
CREATE UNIQUE INDEX "StockBin_warehouseId_code_key" ON "StockBin"("warehouseId", "code");

-- CreateIndex
CREATE INDEX "StockBalance_partId_idx" ON "StockBalance"("partId");

-- CreateIndex
CREATE UNIQUE INDEX "StockBalance_binId_partId_key" ON "StockBalance"("binId", "partId");

-- CreateIndex
CREATE INDEX "StockMovement_binId_createdAt_idx" ON "StockMovement"("binId", "createdAt");

-- CreateIndex
CREATE INDEX "StockMovement_partId_createdAt_idx" ON "StockMovement"("partId", "createdAt");

-- CreateIndex
CREATE INDEX "StockMovement_referenceType_referenceId_idx" ON "StockMovement"("referenceType", "referenceId");

-- CreateIndex
CREATE UNIQUE INDEX "StockMovement_binId_idempotencyKey_key" ON "StockMovement"("binId", "idempotencyKey");

-- CreateIndex
CREATE INDEX "WorkOrderPartConsumption_workOrderId_createdAt_idx" ON "WorkOrderPartConsumption"("workOrderId", "createdAt");

-- CreateIndex
CREATE INDEX "WorkOrderPartConsumption_partId_createdAt_idx" ON "WorkOrderPartConsumption"("partId", "createdAt");

-- CreateIndex
CREATE INDEX "WorkOrderPartConsumption_binId_createdAt_idx" ON "WorkOrderPartConsumption"("binId", "createdAt");

-- CreateIndex
CREATE UNIQUE INDEX "WorkOrderPartConsumption_workOrderId_idempotencyKey_key" ON "WorkOrderPartConsumption"("workOrderId", "idempotencyKey");

-- CreateIndex
CREATE INDEX "Document_organizationId_type_idx" ON "Document"("organizationId", "type");

-- CreateIndex
CREATE UNIQUE INDEX "Document_organizationId_code_key" ON "Document"("organizationId", "code");

-- CreateIndex
CREATE UNIQUE INDEX "DocumentRevision_documentId_revision_key" ON "DocumentRevision"("documentId", "revision");

-- CreateIndex
CREATE UNIQUE INDEX "DocumentApproval_documentRevisionId_approverId_key" ON "DocumentApproval"("documentRevisionId", "approverId");

-- CreateIndex
CREATE UNIQUE INDEX "Meter_assetId_code_key" ON "Meter"("assetId", "code");

-- CreateIndex
CREATE INDEX "MeterReading_meterId_readingAt_idx" ON "MeterReading"("meterId", "readingAt");

-- CreateIndex
CREATE UNIQUE INDEX "PublicMaintenanceRequestToken_tokenHash_key" ON "PublicMaintenanceRequestToken"("tokenHash");

-- CreateIndex
CREATE INDEX "PublicMaintenanceRequestToken_organizationId_siteId_revoked_idx" ON "PublicMaintenanceRequestToken"("organizationId", "siteId", "revokedAt");

-- CreateIndex
CREATE INDEX "PublicMaintenanceRequestToken_expiresAt_idx" ON "PublicMaintenanceRequestToken"("expiresAt");

-- CreateIndex
CREATE INDEX "PublicMaintenanceRequestSubmission_tokenId_createdAt_idx" ON "PublicMaintenanceRequestSubmission"("tokenId", "createdAt");

-- CreateIndex
CREATE INDEX "PublicMaintenanceRequestSubmission_workOrderId_idx" ON "PublicMaintenanceRequestSubmission"("workOrderId");

-- CreateIndex
CREATE UNIQUE INDEX "PublicMaintenanceRequestSubmission_tokenId_idempotencyKey_key" ON "PublicMaintenanceRequestSubmission"("tokenId", "idempotencyKey");

-- CreateIndex
CREATE INDEX "AuditLog_entityType_entityId_idx" ON "AuditLog"("entityType", "entityId");

-- CreateIndex
CREATE INDEX "AuditLog_createdAt_idx" ON "AuditLog"("createdAt");

-- AddForeignKey
ALTER TABLE "Session" ADD CONSTRAINT "Session_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "OrganizationInvitation" ADD CONSTRAINT "OrganizationInvitation_organizationId_fkey" FOREIGN KEY ("organizationId") REFERENCES "Organization"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "OrganizationInvitation" ADD CONSTRAINT "OrganizationInvitation_createdById_fkey" FOREIGN KEY ("createdById") REFERENCES "User"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "OrganizationInvitation" ADD CONSTRAINT "OrganizationInvitation_acceptedById_fkey" FOREIGN KEY ("acceptedById") REFERENCES "User"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "OrganizationMembership" ADD CONSTRAINT "OrganizationMembership_organizationId_fkey" FOREIGN KEY ("organizationId") REFERENCES "Organization"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "OrganizationMembership" ADD CONSTRAINT "OrganizationMembership_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "SiteMembership" ADD CONSTRAINT "SiteMembership_organizationMembershipId_fkey" FOREIGN KEY ("organizationMembershipId") REFERENCES "OrganizationMembership"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "SiteMembership" ADD CONSTRAINT "SiteMembership_siteId_fkey" FOREIGN KEY ("siteId") REFERENCES "Site"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Site" ADD CONSTRAINT "Site_organizationId_fkey" FOREIGN KEY ("organizationId") REFERENCES "Organization"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "MaintenanceTeam" ADD CONSTRAINT "MaintenanceTeam_siteId_fkey" FOREIGN KEY ("siteId") REFERENCES "Site"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "MaintenanceTeamMember" ADD CONSTRAINT "MaintenanceTeamMember_teamId_fkey" FOREIGN KEY ("teamId") REFERENCES "MaintenanceTeam"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "MaintenanceTeamMember" ADD CONSTRAINT "MaintenanceTeamMember_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Location" ADD CONSTRAINT "Location_siteId_fkey" FOREIGN KEY ("siteId") REFERENCES "Site"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Location" ADD CONSTRAINT "Location_parentId_fkey" FOREIGN KEY ("parentId") REFERENCES "Location"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Asset" ADD CONSTRAINT "Asset_siteId_fkey" FOREIGN KEY ("siteId") REFERENCES "Site"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Asset" ADD CONSTRAINT "Asset_locationId_fkey" FOREIGN KEY ("locationId") REFERENCES "Location"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Asset" ADD CONSTRAINT "Asset_parentAssetId_fkey" FOREIGN KEY ("parentAssetId") REFERENCES "Asset"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "AssetStatusHistory" ADD CONSTRAINT "AssetStatusHistory_assetId_fkey" FOREIGN KEY ("assetId") REFERENCES "Asset"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "AssetAttachment" ADD CONSTRAINT "AssetAttachment_assetId_fkey" FOREIGN KEY ("assetId") REFERENCES "Asset"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "WorkOrder" ADD CONSTRAINT "WorkOrder_siteId_fkey" FOREIGN KEY ("siteId") REFERENCES "Site"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "WorkOrder" ADD CONSTRAINT "WorkOrder_assetId_fkey" FOREIGN KEY ("assetId") REFERENCES "Asset"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "WorkOrder" ADD CONSTRAINT "WorkOrder_requesterId_fkey" FOREIGN KEY ("requesterId") REFERENCES "User"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "WorkOrder" ADD CONSTRAINT "WorkOrder_assigneeId_fkey" FOREIGN KEY ("assigneeId") REFERENCES "User"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "WorkOrder" ADD CONSTRAINT "WorkOrder_teamId_fkey" FOREIGN KEY ("teamId") REFERENCES "MaintenanceTeam"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "WorkOrderCheckItem" ADD CONSTRAINT "WorkOrderCheckItem_workOrderId_fkey" FOREIGN KEY ("workOrderId") REFERENCES "WorkOrder"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "WorkOrderAttachment" ADD CONSTRAINT "WorkOrderAttachment_workOrderId_fkey" FOREIGN KEY ("workOrderId") REFERENCES "WorkOrder"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "MaintenanceReminder" ADD CONSTRAINT "MaintenanceReminder_siteId_fkey" FOREIGN KEY ("siteId") REFERENCES "Site"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "MaintenanceReminder" ADD CONSTRAINT "MaintenanceReminder_workOrderId_fkey" FOREIGN KEY ("workOrderId") REFERENCES "WorkOrder"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "MaintenancePlan" ADD CONSTRAINT "MaintenancePlan_assetId_fkey" FOREIGN KEY ("assetId") REFERENCES "Asset"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "MaintenancePlan" ADD CONSTRAINT "MaintenancePlan_meterId_fkey" FOREIGN KEY ("meterId") REFERENCES "Meter"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "MaintenancePlanCheckItem" ADD CONSTRAINT "MaintenancePlanCheckItem_maintenancePlanId_fkey" FOREIGN KEY ("maintenancePlanId") REFERENCES "MaintenancePlan"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Part" ADD CONSTRAINT "Part_organizationId_fkey" FOREIGN KEY ("organizationId") REFERENCES "Organization"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Supplier" ADD CONSTRAINT "Supplier_organizationId_fkey" FOREIGN KEY ("organizationId") REFERENCES "Organization"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "PartSupplier" ADD CONSTRAINT "PartSupplier_partId_fkey" FOREIGN KEY ("partId") REFERENCES "Part"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "PartSupplier" ADD CONSTRAINT "PartSupplier_supplierId_fkey" FOREIGN KEY ("supplierId") REFERENCES "Supplier"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Warehouse" ADD CONSTRAINT "Warehouse_siteId_fkey" FOREIGN KEY ("siteId") REFERENCES "Site"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "StockBin" ADD CONSTRAINT "StockBin_warehouseId_fkey" FOREIGN KEY ("warehouseId") REFERENCES "Warehouse"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "StockBalance" ADD CONSTRAINT "StockBalance_binId_fkey" FOREIGN KEY ("binId") REFERENCES "StockBin"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "StockBalance" ADD CONSTRAINT "StockBalance_partId_fkey" FOREIGN KEY ("partId") REFERENCES "Part"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "StockMovement" ADD CONSTRAINT "StockMovement_binId_fkey" FOREIGN KEY ("binId") REFERENCES "StockBin"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "StockMovement" ADD CONSTRAINT "StockMovement_partId_fkey" FOREIGN KEY ("partId") REFERENCES "Part"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "AssetPart" ADD CONSTRAINT "AssetPart_assetId_fkey" FOREIGN KEY ("assetId") REFERENCES "Asset"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "AssetPart" ADD CONSTRAINT "AssetPart_partId_fkey" FOREIGN KEY ("partId") REFERENCES "Part"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "WorkOrderPart" ADD CONSTRAINT "WorkOrderPart_workOrderId_fkey" FOREIGN KEY ("workOrderId") REFERENCES "WorkOrder"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "WorkOrderPart" ADD CONSTRAINT "WorkOrderPart_partId_fkey" FOREIGN KEY ("partId") REFERENCES "Part"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "WorkOrderPartConsumption" ADD CONSTRAINT "WorkOrderPartConsumption_workOrderId_fkey" FOREIGN KEY ("workOrderId") REFERENCES "WorkOrder"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "WorkOrderPartConsumption" ADD CONSTRAINT "WorkOrderPartConsumption_partId_fkey" FOREIGN KEY ("partId") REFERENCES "Part"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "WorkOrderPartConsumption" ADD CONSTRAINT "WorkOrderPartConsumption_binId_fkey" FOREIGN KEY ("binId") REFERENCES "StockBin"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Document" ADD CONSTRAINT "Document_organizationId_fkey" FOREIGN KEY ("organizationId") REFERENCES "Organization"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "DocumentRevision" ADD CONSTRAINT "DocumentRevision_documentId_fkey" FOREIGN KEY ("documentId") REFERENCES "Document"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "DocumentApproval" ADD CONSTRAINT "DocumentApproval_documentRevisionId_fkey" FOREIGN KEY ("documentRevisionId") REFERENCES "DocumentRevision"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "DocumentApproval" ADD CONSTRAINT "DocumentApproval_approverId_fkey" FOREIGN KEY ("approverId") REFERENCES "User"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "AssetDocument" ADD CONSTRAINT "AssetDocument_assetId_fkey" FOREIGN KEY ("assetId") REFERENCES "Asset"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "AssetDocument" ADD CONSTRAINT "AssetDocument_documentId_fkey" FOREIGN KEY ("documentId") REFERENCES "Document"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "WorkOrderDocument" ADD CONSTRAINT "WorkOrderDocument_workOrderId_fkey" FOREIGN KEY ("workOrderId") REFERENCES "WorkOrder"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "WorkOrderDocument" ADD CONSTRAINT "WorkOrderDocument_documentId_fkey" FOREIGN KEY ("documentId") REFERENCES "Document"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Meter" ADD CONSTRAINT "Meter_assetId_fkey" FOREIGN KEY ("assetId") REFERENCES "Asset"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "MeterReading" ADD CONSTRAINT "MeterReading_meterId_fkey" FOREIGN KEY ("meterId") REFERENCES "Meter"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "PublicMaintenanceRequestSubmission" ADD CONSTRAINT "PublicMaintenanceRequestSubmission_tokenId_fkey" FOREIGN KEY ("tokenId") REFERENCES "PublicMaintenanceRequestToken"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "AuditLog" ADD CONSTRAINT "AuditLog_actorId_fkey" FOREIGN KEY ("actorId") REFERENCES "User"("id") ON DELETE SET NULL ON UPDATE CASCADE;

