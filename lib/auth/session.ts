import { createHash, randomBytes } from "node:crypto";
import { db } from "@/lib/db";

const SESSION_TTL_MS = 1000 * 60 * 60 * 24 * 7;

export function hashToken(token: string): string {
  return createHash("sha256").update(token).digest("hex");
}

export async function createSession(userId: string) {
  const token = randomBytes(32).toString("base64url");
  const expiresAt = new Date(Date.now() + SESSION_TTL_MS);
  const session = await db.session.create({
    data: { userId, tokenHash: hashToken(token), expiresAt },
    select: { id: true, expiresAt: true },
  });
  return { token, ...session };
}

export async function resolveSession(token: string) {
  const session = await db.session.findUnique({
    where: { tokenHash: hashToken(token) },
    include: { user: { select: { id: true, email: true, displayName: true, active: true } } },
  });

  if (!session || session.revokedAt || session.expiresAt <= new Date() || !session.user.active) {
    return null;
  }

  await db.session.update({ where: { id: session.id }, data: { lastSeenAt: new Date() } });
  return session;
}

export async function revokeSession(token: string) {
  await db.session.updateMany({
    where: { tokenHash: hashToken(token), revokedAt: null },
    data: { revokedAt: new Date() },
  });
}

export async function revokeAllUserSessions(userId: string) {
  await db.session.updateMany({
    where: { userId, revokedAt: null },
    data: { revokedAt: new Date() },
  });
}
