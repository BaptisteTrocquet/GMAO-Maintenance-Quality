import { z } from "zod";
import { AccessDeniedError, assertSitePermission } from "@/lib/access-control";
import { apiData, apiError } from "@/lib/api-response";
import {
  disableLaborCapacityProfile,
  LaborCapacityError,
  listLaborCapacityProfiles,
  setLaborCapacityProfile,
} from "@/lib/analytics/labor-capacity";
import { authenticateRequest } from "@/lib/auth/request-auth";
import { db } from "@/lib/db";

const querySchema = z.object({
  organizationId: z.string().min(1),
  siteId: z.string().min(1),
});

const patchSchema = querySchema.extend({
  userId: z.string().min(1),
  weeklyCapacityMinutes: z.number().int().positive().max(7 * 24 * 60).nullable(),
});

function denied(error: unknown) {
  if (error instanceof AccessDeniedError) {
    return apiError(403, "ACCESS_DENIED", error.message);
  }
  throw error;
}

async function activeSite(organizationId: string, siteId: string) {
  return db.site.findFirst({
    where: { id: siteId, organizationId, active: true },
    select: { id: true },
  });
}

export async function GET(request: Request): Promise<Response> {
  const url = new URL(request.url);
  const parsed = querySchema.safeParse({
    organizationId: url.searchParams.get("organizationId"),
    siteId: url.searchParams.get("siteId"),
  });
  if (!parsed.success) {
    return apiError(400, "INVALID_QUERY", "organizationId and siteId are required");
  }

  const auth = await authenticateRequest(request, parsed.data.organizationId);
  if ("error" in auth) {
    return auth.error ?? apiError(401, "UNAUTHENTICATED", "Authentication required");
  }
  try {
    assertSitePermission(auth.tenant.scope, parsed.data.siteId, "maintenance:read");
  } catch (error) {
    return denied(error);
  }
  if (!(await activeSite(parsed.data.organizationId, parsed.data.siteId))) {
    return apiError(404, "SITE_NOT_FOUND", "Active site not found in organization scope");
  }

  const [profiles, memberships] = await Promise.all([
    listLaborCapacityProfiles({
      organizationId: parsed.data.organizationId,
      siteId: parsed.data.siteId,
    }),
    db.organizationMembership.findMany({
      where: {
        organizationId: parsed.data.organizationId,
        active: true,
        role: { in: ["OWNER", "ADMIN", "MAINTENANCE_MANAGER", "TECHNICIAN"] },
        user: { active: true },
        OR: [
          { allSites: true },
          { siteMemberships: { some: { siteId: parsed.data.siteId } } },
        ],
      },
      select: { user: { select: { id: true, displayName: true } } },
      orderBy: { user: { displayName: "asc" } },
      take: 250,
    }),
  ]);

  return apiData({
    profiles,
    users: memberships.map((membership) => membership.user),
  });
}

export async function PATCH(request: Request): Promise<Response> {
  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return apiError(400, "INVALID_JSON", "Request body must be valid JSON");
  }
  const parsed = patchSchema.safeParse(body);
  if (!parsed.success) {
    return apiError(400, "INVALID_PAYLOAD", "Invalid labor capacity payload", parsed.error.flatten());
  }

  const auth = await authenticateRequest(request, parsed.data.organizationId);
  if ("error" in auth) {
    return auth.error ?? apiError(401, "UNAUTHENTICATED", "Authentication required");
  }
  try {
    assertSitePermission(auth.tenant.scope, parsed.data.siteId, "maintenance:manage");
  } catch (error) {
    return denied(error);
  }

  try {
    const result = parsed.data.weeklyCapacityMinutes === null
      ? await disableLaborCapacityProfile({
          organizationId: parsed.data.organizationId,
          siteId: parsed.data.siteId,
          userId: parsed.data.userId,
          actorId: auth.session.user.id,
        })
      : await setLaborCapacityProfile({
          organizationId: parsed.data.organizationId,
          siteId: parsed.data.siteId,
          userId: parsed.data.userId,
          weeklyCapacityMinutes: parsed.data.weeklyCapacityMinutes,
          actorId: auth.session.user.id,
        });
    return apiData(result);
  } catch (error) {
    if (error instanceof LaborCapacityError) {
      const status = error.code === "SITE_NOT_FOUND" || error.code === "PROFILE_NOT_FOUND" ? 404 : 400;
      return apiError(status, error.code, error.message);
    }
    throw error;
  }
}
