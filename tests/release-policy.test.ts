import { describe, expect, it } from "vitest";

import {
  assertReleasePolicy,
  ReleasePolicyError,
  type ReleasePolicy,
} from "@/lib/release-policy";

function validPolicy(): ReleasePolicy {
  return {
    schemaVersion: 1,
    currentVersion: "0.2.0",
    previousSupportedRelease: {
      version: "0.1.0",
      commit: "bdb214640c047185aa25f59c16a52aff1cbabc53",
    },
    versioning: "semver",
    upgradePolicy: {
      directUpgradeFromPreviousSupportedRelease: true,
      downgradeSupported: false,
    },
  };
}

describe("release policy", () => {
  it("accepts an exact SemVer progression pinned to an immutable commit", () => {
    expect(() => assertReleasePolicy(validPolicy(), "0.2.0")).not.toThrow();
  });

  it("rejects source version drift", () => {
    expect(() => assertReleasePolicy(validPolicy(), "0.2.1")).toThrow(ReleasePolicyError);
  });

  it("rejects a floating or abbreviated previous release ref", () => {
    const policy = validPolicy();
    policy.previousSupportedRelease.commit = "main";
    expect(() => assertReleasePolicy(policy, "0.2.0")).toThrow(/40-character SHA/);
  });

  it("rejects an all-zero previous release placeholder", () => {
    const policy = validPolicy();
    policy.previousSupportedRelease.commit = "0".repeat(40);
    expect(() => assertReleasePolicy(policy, "0.2.0")).toThrow(/all-zero/);
  });

  it("rejects versions that do not advance", () => {
    const policy = validPolicy();
    policy.currentVersion = "0.1.0";
    expect(() => assertReleasePolicy(policy, "0.1.0")).toThrow(/newer/);
  });

  it("rejects prerelease shorthand in the stable support manifest", () => {
    const policy = validPolicy();
    policy.currentVersion = "0.2.0-rc.1";
    expect(() => assertReleasePolicy(policy, "0.2.0-rc.1")).toThrow(/exact stable SemVer/);
  });

  it("keeps direct N-1 upgrades mandatory and downgrades unsupported", () => {
    const noUpgrade = validPolicy();
    noUpgrade.upgradePolicy.directUpgradeFromPreviousSupportedRelease = false;
    expect(() => assertReleasePolicy(noUpgrade, "0.2.0")).toThrow(/direct upgrade/);

    const downgrade = validPolicy();
    downgrade.upgradePolicy.downgradeSupported = true;
    expect(() => assertReleasePolicy(downgrade, "0.2.0")).toThrow(/downgradeSupported/);
  });
});
