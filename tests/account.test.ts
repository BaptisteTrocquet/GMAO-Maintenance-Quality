import { beforeEach, describe, expect, it, vi } from "vitest";

const userUpdate = vi.fn();
const membershipUpdateMany = vi.fn();
const transaction = vi.fn(async (callback: (tx: unknown) => Promise<void>) =>
  callback({
    user: { update: userUpdate },
    organizationMembership: { updateMany: membershipUpdateMany },
  }),
);
const revokeAllUserSessions = vi.fn();

vi.mock("@/lib/db", () => ({
  db: {
    $transaction: transaction,
    user: { update: userUpdate },
  },
}));

vi.mock("@/lib/auth/session", () => ({ revokeAllUserSessions }));

import { disableUserAccount, enableUserAccount } from "@/lib/auth/account";

describe("account lifecycle", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("disables the user, memberships and active sessions", async () => {
    await disableUserAccount("user-1");

    expect(userUpdate).toHaveBeenCalledWith({
      where: { id: "user-1" },
      data: { active: false },
    });
    expect(membershipUpdateMany).toHaveBeenCalledWith({
      where: { userId: "user-1", active: true },
      data: { active: false },
    });
    expect(revokeAllUserSessions).toHaveBeenCalledWith("user-1");
  });

  it("can reactivate the account without restoring memberships", async () => {
    await enableUserAccount("user-1");

    expect(userUpdate).toHaveBeenCalledWith({
      where: { id: "user-1" },
      data: { active: true },
    });
  });
});
