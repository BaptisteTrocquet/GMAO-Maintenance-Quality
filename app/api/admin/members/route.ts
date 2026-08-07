import { z } from "zod";
import { db } from "@/lib/db";
import { apiData, apiError } from "@/lib/api-response";
import { assertPermission, AccessDeniedError } from "@/lib/access-control";
import { authenticateRequest } from "@/lib/auth/request-auth";

const updateSchema = z.object({
  organizationId: z.string().min(1),
  membershipId: z.string().min(1),
  role: z.enum([
    "OWNER",
    "ADMIN",
    "MAINTENANCE_MANAGER",
    "TECHNICIAN",
    "QUALITY_MANAGER",
    "OPERATOR",
    "VIEWER",
  ]).optional(),
  active: z.boolean().optional(),
});

function authorize(scope: Parameters<typeof assertPermission>[0]) {
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
  const organizationId = new URL(request.url).searchParams.get("organizationId");
  if (!organizationId) return apiError(400, "INVALID_SCOPE", "organizationId is required");

  const auth = await authenticateRequest(request, organizationId);
  if ("error" in auth) return auth.error;
  const denied = authorize(auth.tenant.scope);
  if (denied) return denied;

  const rows = await db.organizationMembership.findMany({
    where: { organizationId },
    select: {
      id: true,
      role: true,
      allSites: true,
      active: true,
      createdAt: true,
      user: { select: { id: true, email: true, displayName: true, active: true } },
      siteMemberships: { select: { site: { select: { id: true, name: true } } } },
    },
    orderBy: { user: { displayName: "asc" } },
  });

  return apiData(rows);
}

export async function PATCH(request: Request) {
  const parsed = updateSchema.safeParse(await request.json());
  if (!parsed.success) {
    return apiError(400, "INVALID_PAYLOAD", "Invalid member update payload", parsed.error.flatten());
  }

  const auth = await authenticateRequest(request, parsed.data.organizationId);
  if ("error" in auth) return auth.error;
  const denied = authorize(auth.tenant.scope);
  if (denied) return denied;

  const target = await db.organizationMembership.findFirst({
    where: { id: parsed.data.membershipId, organizationId: parsed.data.organizationId },
    select: { id: true, userId: true },
  });
  if (!target) return apiError(404, "MEMBERSHIP_NOT_FOUND", "Membership not found");

  const updated = await db.organizationMembership.update({
    where: { id: target.id },
    data: {
      ...(parsed.data.role === undefined ? {} : { role: parsed.data.role }),
      ...(parsed.data.active === undefined ? {} : { active: parsed.data.active }),
    },
    select: { id: true, role: true, active: true, allSites: true },
  });

  if (parsed.data.active === false) {
    await db.session.updateMany({
      where: { userId: target.userId, revokedAt: null },
      data: { revokedAt: new Date() },
    });
  }

  return apiData(updated);
}
