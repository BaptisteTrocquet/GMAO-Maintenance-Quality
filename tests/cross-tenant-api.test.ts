import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  authenticateRequest: vi.fn(),
  assetFindMany: vi.fn(),
  assetCreate: vi.fn(),
  siteFindFirst: vi.fn(),
  workOrderFindMany: vi.fn(),
  workOrderCreate: vi.fn(),
  workOrderCount: vi.fn(),
  organizationInvitationFindMany: vi.fn(),
  documentFindMany: vi.fn(),
  documentCreate: vi.fn(),
  organizationFindFirst: vi.fn(),
  createOrganizationInvitation: vi.fn(),
  revokeOrganizationInvitation: vi.fn(),
}));

vi.mock("@/lib/auth/request-auth", () => ({
  authenticateRequest: mocks.authenticateRequest,
}));

vi.mock("@/lib/db", () => ({
  db: {
    asset: { findMany: mocks.assetFindMany, create: mocks.assetCreate, findFirst: vi.fn() },
    site: { findFirst: mocks.siteFindFirst },
    workOrder: {
      findMany: mocks.workOrderFindMany,
      create: mocks.workOrderCreate,
      count: mocks.workOrderCount,
    },
    organizationInvitation: { findMany: mocks.organizationInvitationFindMany },
    document: { findMany: mocks.documentFindMany, create: mocks.documentCreate },
    organization: { findFirst: mocks.organizationFindFirst },
  },
}));

vi.mock("@/lib/auth/invitations", () => ({
  createOrganizationInvitation: mocks.createOrganizationInvitation,
  revokeOrganizationInvitation: mocks.revokeOrganizationInvitation,
}));

import { GET as getAssets, POST as postAsset } from "@/app/api/assets/route";
import { GET as getWorkOrders, POST as postWorkOrder } from "@/app/api/work-orders/route";
import {
  GET as getInvitations,
  POST as postInvitation,
  DELETE as deleteInvitation,
} from "@/app/api/invitations/route";
import { GET as getDocuments, POST as postDocument } from "@/app/api/documents/route";

function rejectForeignTenant() {
  mocks.authenticateRequest.mockResolvedValue({
    error: Response.json(
      { error: { code: "ACCESS_DENIED", message: "No active membership for organization" } },
      { status: 403 },
    ),
  });
}

async function expectDenied(response: Response | undefined) {
  expect(response).toBeDefined();
  expect(response?.status).toBe(403);
}

describe("cross-tenant API boundary", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    rejectForeignTenant();
  });

  it("blocks cross-tenant asset reads and writes before database access", async () => {
    await expectDenied(
      await getAssets(
        new Request("http://localhost/api/assets?organizationId=org-foreign&siteId=site-foreign"),
      ),
    );

    await expectDenied(
      await postAsset(
        new Request("http://localhost/api/assets", {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({
            organizationId: "org-foreign",
            siteId: "site-foreign",
            code: "A-001",
            name: "Foreign asset",
          }),
        }),
      ),
    );

    expect(mocks.siteFindFirst).not.toHaveBeenCalled();
    expect(mocks.assetFindMany).not.toHaveBeenCalled();
    expect(mocks.assetCreate).not.toHaveBeenCalled();
  });

  it("blocks cross-tenant work-order reads and writes before database access", async () => {
    await expectDenied(
      await getWorkOrders(
        new Request(
          "http://localhost/api/work-orders?organizationId=org-foreign&siteId=site-foreign",
        ),
      ),
    );

    await expectDenied(
      await postWorkOrder(
        new Request("http://localhost/api/work-orders", {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({
            organizationId: "org-foreign",
            siteId: "site-foreign",
            title: "Foreign WO",
            type: "CORRECTIVE",
          }),
        }),
      ),
    );

    expect(mocks.workOrderFindMany).not.toHaveBeenCalled();
    expect(mocks.workOrderCount).not.toHaveBeenCalled();
    expect(mocks.workOrderCreate).not.toHaveBeenCalled();
  });

  it("blocks cross-tenant invitation reads, creates and revocations", async () => {
    await expectDenied(
      await getInvitations(
        new Request("http://localhost/api/invitations?organizationId=org-foreign"),
      ),
    );

    await expectDenied(
      await postInvitation(
        new Request("http://localhost/api/invitations", {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({
            organizationId: "org-foreign",
            email: "foreign@example.local",
            role: "VIEWER",
          }),
        }),
      ),
    );

    await expectDenied(
      await deleteInvitation(
        new Request("http://localhost/api/invitations", {
          method: "DELETE",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({
            organizationId: "org-foreign",
            invitationId: "invite-foreign",
          }),
        }),
      ),
    );

    expect(mocks.organizationInvitationFindMany).not.toHaveBeenCalled();
    expect(mocks.createOrganizationInvitation).not.toHaveBeenCalled();
    expect(mocks.revokeOrganizationInvitation).not.toHaveBeenCalled();
  });

  it("blocks cross-tenant document reads and writes before database access", async () => {
    await expectDenied(
      await getDocuments(
        new Request("http://localhost/api/documents?organizationId=org-foreign"),
      ),
    );

    await expectDenied(
      await postDocument(
        new Request("http://localhost/api/documents", {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({
            organizationId: "org-foreign",
            code: "DOC-001",
            title: "Foreign document",
            type: "WORK_INSTRUCTION",
          }),
        }),
      ),
    );

    expect(mocks.documentFindMany).not.toHaveBeenCalled();
    expect(mocks.organizationFindFirst).not.toHaveBeenCalled();
    expect(mocks.documentCreate).not.toHaveBeenCalled();
  });
});
