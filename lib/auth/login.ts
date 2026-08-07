import { db } from "@/lib/db";
import { createSession } from "@/lib/auth/session";
import {
  isValidExternalIdentity,
  normalizeExternalIdentity,
  type AuthenticationProvider,
} from "@/lib/auth/provider";

export type LoginResult =
  | { ok: true; token: string; expiresAt: Date; user: { id: string; email: string; displayName: string } }
  | { ok: false; code: "INVALID_IDENTITY" | "ACCOUNT_DISABLED" };

export async function loginWithProvider(
  provider: AuthenticationProvider,
  input: unknown,
): Promise<LoginResult> {
  const verified = await provider.verify(input);
  if (!verified) return { ok: false, code: "INVALID_IDENTITY" };

  const identity = normalizeExternalIdentity(verified);
  if (!isValidExternalIdentity(identity)) {
    return { ok: false, code: "INVALID_IDENTITY" };
  }

  const user = await db.user.findUnique({
    where: { email: identity.email },
    select: { id: true, email: true, displayName: true, active: true },
  });

  if (!user || !user.active) {
    return { ok: false, code: "ACCOUNT_DISABLED" };
  }

  const session = await createSession(user.id);
  return {
    ok: true,
    token: session.token,
    expiresAt: session.expiresAt,
    user: { id: user.id, email: user.email, displayName: user.displayName },
  };
}
