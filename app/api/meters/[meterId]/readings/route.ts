import { z } from "zod";
import { apiData, apiError } from "@/lib/api-response";
import { authenticateRequest } from "@/lib/auth/request-auth";
import { AccessDeniedError, assertSitePermission } from "@/lib/access-control";
import { addMeterReading, MeterReadingError } from "@/lib/assets/meters";

const createSchema = z.object({
  organizationId: z.string().min(1),
  siteId: z.string().min(1),
  value: z.number().finite(),
  note: z.string().max(500).nullable().optional(),
  readingAt: z.coerce.date().optional(),
});

export async function POST(request: Request, context: { params: Promise<{ meterId: string }> }) {
  const parsed = createSchema.safeParse(await request.json());
  if (!parsed.success) return apiError(400, "INVALID_PAYLOAD", "Invalid meter reading payload", parsed.error.flatten());

  const auth = await authenticateRequest(request, parsed.data.organizationId);
  if ("error" in auth) return auth.error;

  try {
    assertSitePermission(auth.tenant.scope, parsed.data.siteId, "asset:write");
  } catch (error) {
    if (error instanceof AccessDeniedError) return apiError(403, "ACCESS_DENIED", error.message);
    throw error;
  }

  const { meterId } = await context.params;
  try {
    const reading = await addMeterReading({ ...parsed.data, meterId, actorId: auth.session.user.id });
    if (!reading) return apiError(404, "METER_NOT_FOUND", "Meter not found");
    return apiData(reading, { status: 201 });
  } catch (error) {
    if (error instanceof MeterReadingError) return apiError(409, error.code, error.message);
    throw error;
  }
}
