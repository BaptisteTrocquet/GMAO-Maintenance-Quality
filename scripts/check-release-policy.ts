import { readFile } from "node:fs/promises";
import path from "node:path";

import { assertReleasePolicy, type ReleasePolicy } from "../lib/release-policy";

type PackageJson = {
  version?: string;
};

type PackageLock = {
  version?: string;
  packages?: {
    ""?: {
      version?: string;
    };
  };
};

const root = process.cwd();

async function main() {
  const [packageJsonRaw, packageLockRaw, policyRaw, releasingGuide] = await Promise.all([
    readFile(path.join(root, "package.json"), "utf8"),
    readFile(path.join(root, "package-lock.json"), "utf8"),
    readFile(path.join(root, "release", "release-policy.json"), "utf8"),
    readFile(path.join(root, "docs", "RELEASING.md"), "utf8"),
  ]);

  const packageJson = JSON.parse(packageJsonRaw) as PackageJson;
  const packageLock = JSON.parse(packageLockRaw) as PackageLock;
  const policy = JSON.parse(policyRaw) as ReleasePolicy;
  if (!packageJson.version) throw new Error("Release policy check failed: package.json version is missing");

  assertReleasePolicy(policy, packageJson.version);

  const lockVersions = [packageLock.version, packageLock.packages?.[""]?.version];
  if (lockVersions.some((version) => version !== packageJson.version)) {
    throw new Error(
      `Release policy check failed: package-lock.json must match package.json version ${packageJson.version}`,
    );
  }

  const requiredGuideTerms = [
    "Semantic Versioning",
    "previous supported release",
    "upgrade drill",
    "immutable",
    "v${VERSION}",
    "forward-fix",
    "release/release-policy.json",
  ];
  for (const term of requiredGuideTerms) {
    if (!releasingGuide.includes(term)) {
      throw new Error(`Release policy check failed: docs/RELEASING.md must document ${term}`);
    }
  }

  process.stdout.write(
    `Release policy check passed: ${policy.previousSupportedRelease.version} (${policy.previousSupportedRelease.commit}) -> ${policy.currentVersion}\n`,
  );
}

main().catch((error: unknown) => {
  process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
  process.exitCode = 1;
});
