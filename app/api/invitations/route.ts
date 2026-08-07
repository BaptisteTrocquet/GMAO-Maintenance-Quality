import { z } from "zod";
import { db } from "@/lib/db";
import { apiData, apiError } from "@/lib/api-response";
import { assertPermission, AccessDeniedError } from "@/lib/access-control";
import { authenticateRequest } from "@/lib/auth/request-auth";
import {
  createOrganizationInvitation,
  revokeOrganizationInvitation,
} from "@/lib/auth/invitations";

const createSchema = z.object({
  organizationId: z.string().min(1),
  email: z.string().email(),
  role: z.enum([
    "OWNER",
    "ADMIN",
    "MAINTENANCE_MANAGER",
    "TECHNICIAN",
    "QUALITY_MANAGER",
    "OPERATOR",
    "VIEWER",
  ]),
  allSites: z.boolean().optional(),
});

const revokeSchema = z.object({
  organizationId: z.string().min(1),
  invitationId: z.string().min(1),
});

function authorizeMemberManagement(scope: Parameters<typeof assertPermission>[0]) {
  try {
    assertPermission(scope, "member:manage");
    return null;
  } catch (error) {
    if (error instanceof AccessDeniedError) {
      return apiError(403, "ACCESS_DENIED", error.message);
    }
    throw error;
  }
}

export async function GET(request: Request) {
  const url = new URL(request.url);
  const organizationId = url.searchParams.get("organizationId");
  if (!organizationId) {
    return apiError(400, "INVALID_SCOPE", "organizationId is required");
  }

  const auth = await authenticateRequest(request, organizationId);
  if ("error" in auth) return auth.error;

  const denied = authorizeMemberManagement(auth.tenant.scope);
  if (denied) return denied;

  const invitations = await db.organizationInvitation.findMany({
    where: { organizationId },
    select: {
      id: true,
      email: true,
      role: true,
      allSites: true,
      status: true,
      expiresAt: true,
      createdAt: true,
    },
    orderBy: { createdAt: "desc" },
  });

  return apiData(invitations);
}

export async function POST(request: Request) {
  const parsed = createSchema.safeParse(await request.json());
  if (!parsed.success) {
    return apiError(400, "INVALID_PAYLOAD", "Invalid invitation payload", parsed.error.flatten());
  }

  const auth = await authenticateRequest(request, parsed.data.organizationId);
  if ("error" in auth) return auth.error;

  const denied = authorizeMemberManagement(auth.tenant.scope);
  if (denied) return denied;

  const invitation = await createOrganizationInvitation({
    organizationId: parsed.data.organizationId,
    email: parsed.data.email,
    role: parsed.data.role,
    allSites: parsed.data.allSites,
    createdById: auth.session.user.id,
  });

  return apiData(invitation, { status: 201 });
}

export async function DELETE(request: Request) {
  const parsed = revokeSchema.safeParse(await request.json());
  if (!parsed.success) {
    return apiError(400, "INVALID_PAYLOAD", "Invalid revocation payload", parsed.error.flatten());
  }

  const auth = await authenticateRequest(request, parsed.data.organizationId);
  if ("error" in auth) return auth.error;

  const denied = authorizeMemberManagement(auth.tenant.scope);
  if (denied) return denied;

  const result = await revokeOrganizationInvitation(
    parsed.data.invitationId,
    parsed.data.organizationId,
  );

  if (result.count === 0) {
    return apiError(404, "INVITATION_NOT_FOUND", "Pending invitation not found");
  }

  return apiData({ revoked: true });
}
