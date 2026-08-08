export type ReleasePolicy = {
  schemaVersion: number;
  currentVersion: string;
  previousSupportedRelease: {
    version: string;
    commit: string;
  };
  versioning: string;
  upgradePolicy: {
    directUpgradeFromPreviousSupportedRelease: boolean;
    downgradeSupported: boolean;
  };
};

export class ReleasePolicyError extends Error {
  constructor(message: string) {
    super(`Release policy check failed: ${message}`);
    this.name = "ReleasePolicyError";
  }
}

type Semver = {
  major: number;
  minor: number;
  patch: number;
};

const SEMVER = /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$/;
const FULL_COMMIT_SHA = /^[0-9a-f]{40}$/;

function parseSemver(value: string, label: string): Semver {
  const match = SEMVER.exec(value);
  if (!match) throw new ReleasePolicyError(`${label} must be an exact stable SemVer (x.y.z)`);
  return {
    major: Number(match[1]),
    minor: Number(match[2]),
    patch: Number(match[3]),
  };
}

function compareSemver(left: Semver, right: Semver) {
  if (left.major !== right.major) return left.major - right.major;
  if (left.minor !== right.minor) return left.minor - right.minor;
  return left.patch - right.patch;
}

export function assertReleasePolicy(policy: ReleasePolicy, packageVersion: string) {
  if (policy.schemaVersion !== 1) {
    throw new ReleasePolicyError("schemaVersion must be 1");
  }
  if (policy.versioning !== "semver") {
    throw new ReleasePolicyError('versioning must be "semver"');
  }

  const current = parseSemver(policy.currentVersion, "currentVersion");
  const previous = parseSemver(
    policy.previousSupportedRelease.version,
    "previousSupportedRelease.version",
  );

  if (packageVersion !== policy.currentVersion) {
    throw new ReleasePolicyError(
      `package.json version ${packageVersion} does not match currentVersion ${policy.currentVersion}`,
    );
  }
  if (compareSemver(current, previous) <= 0) {
    throw new ReleasePolicyError("currentVersion must be newer than previousSupportedRelease.version");
  }
  if (!FULL_COMMIT_SHA.test(policy.previousSupportedRelease.commit)) {
    throw new ReleasePolicyError("previousSupportedRelease.commit must be a full lowercase 40-character SHA");
  }
  if (/^0{40}$/.test(policy.previousSupportedRelease.commit)) {
    throw new ReleasePolicyError("previousSupportedRelease.commit cannot be an all-zero placeholder");
  }
  if (policy.upgradePolicy.directUpgradeFromPreviousSupportedRelease !== true) {
    throw new ReleasePolicyError("direct upgrade from the previous supported release must remain supported");
  }
  if (policy.upgradePolicy.downgradeSupported !== false) {
    throw new ReleasePolicyError("downgradeSupported must remain false; use forward-fix or restore procedures");
  }
}
