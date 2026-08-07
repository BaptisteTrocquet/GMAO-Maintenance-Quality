import { db } from "@/lib/db";
import { revokeAllUserSessions } from "@/lib/auth/session";

export async function disableUserAccount(userId: string) {
  await db.$transaction(async (tx) => {
    await tx.user.update({
      where: { id: userId },
      data: { active: false },
    });

    await tx.organizationMembership.updateMany({
      where: { userId, active: true },
      data: { active: false },
    });
  });

  await revokeAllUserSessions(userId);
}

export async function enableUserAccount(userId: string) {
  await db.user.update({
    where: { id: userId },
    data: { active: true },
  });
}
