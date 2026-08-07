import type { MembershipRole } from "@prisma/client";
import { db } from "@/lib/db";
import { can } from "@/lib/permissions";

export async function canExecuteWorkOrder(input: {
  role: MembershipRole;
  userId: string;
  siteId: string;
  assigneeId: string | null;
  teamId: string | null;
}) {
  if (can(input.role, "work:manage")) return true;
  if (input.assigneeId === input.userId) return true;
  if (!input.teamId) return false;

  const teamMembership = await db.maintenanceTeamMember.findFirst({
    where: {
      teamId: input.teamId,
      userId: input.userId,
      user: { active: true },
      team: { siteId: input.siteId, active: true },
    },
    select: { teamId: true },
  });

  return Boolean(teamMembership);
}
