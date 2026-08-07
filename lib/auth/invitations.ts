import { createHash, randomBytes } from "node:crypto";
import type { MembershipRole } from "@prisma/client";
import { db } from "@/lib/db";

const INVITE_TTL_MS = 1000 * 60 * 60 * 24 * 7;

function hashInviteToken(token: string) {
  return createHash("sha256").update(token).digest("hex");
}

export async function createOrganizationInvitation(input: {
  organizationId: string;
  email: string;
  role: MembershipRole;
  allSites?: boolean;
  createdById: string;
}) {
  const token = randomBytes(32).toString("base64url");
  const invitation = await db.organizationInvitation.create({
    data: {
      organizationId: input.organizationId,
      email: input.email.trim().toLowerCase(),
      role: input.role,
      allSites: input.allSites ?? false,
      tokenHash: hashInviteToken(token),
      expiresAt: new Date(Date.now() + INVITE_TTL_MS),
      createdById: input.createdById,
    },
    select: { id: true, expiresAt: true, email: true, role: true, allSites: true },
  });
  return { token, ...invitation };
}

export async function acceptOrganizationInvitation(token: string, userId: string) {
  const invitation = await db.organizationInvitation.findUnique({
    where: { tokenHash: hashInviteToken(token) },
  });

  if (!invitation || invitation.status !== "PENDING" || invitation.expiresAt <= new Date()) {
    return null;
  }

  return db.$transaction(async (tx) => {
    const membership = await tx.organizationMembership.upsert({
      where: {
        organizationId_userId: {
          organizationId: invitation.organizationId,
          userId,
        },
      },
      update: { active: true, role: invitation.role, allSites: invitation.allSites },
      create: {
        organizationId: invitation.organizationId,
        userId,
        role: invitation.role,
        allSites: invitation.allSites,
      },
    });

    await tx.organizationInvitation.update({
      where: { id: invitation.id },
      data: { status: "ACCEPTED", acceptedById: userId, acceptedAt: new Date() },
    });

    return membership;
  });
}

export async function revokeOrganizationInvitation(id: string, organizationId: string) {
  return db.organizationInvitation.updateMany({
    where: { id, organizationId, status: "PENDING" },
    data: { status: "REVOKED", revokedAt: new Date() },
  });
}
