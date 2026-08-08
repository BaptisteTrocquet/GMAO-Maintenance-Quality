# Release and versioning process

GMAO Maintenance Quality uses **Semantic Versioning** for the source release line. The authoritative release relationship used by CI is committed in [`release/release-policy.json`](../release/release-policy.json).

A source version is not considered a published release merely because `package.json` changed. Publication is complete only when the reviewed release commit has passed all required checks, an immutable `v${VERSION}` tag points to that exact commit, and release artifacts are built from that same source revision.

## Version semantics

Before 1.0, use versions deliberately:

- **patch** (`0.x.Y`) for backward-compatible fixes that do not change the supported upgrade boundary;
- **minor** (`0.X.0`) for a new tested product line that may contain substantial features while preserving the documented direct upgrade from the previous supported release;
- **major** (`X.0.0`) once the project declares a stable 1.0+ compatibility contract and a deliberate breaking release is required.

Do not use a version bump as a substitute for a migration review. Prisma migration safety, historical stability, tenant isolation and controlled-document invariants remain mandatory independently of SemVer.

## Supported upgrade boundary

`release/release-policy.json` contains exactly one **previous supported release** baseline for the current source line. It is pinned to a full 40-character commit SHA, never a branch, shortened SHA or floating tag.

For the 0.2.0 source line, the baseline is 0.1.0 at commit `bdb214640c047185aa25f59c16a52aff1cbabc53`. This is the first explicitly recorded support baseline; the repository had no formal release/versioning process before E14.

CI must prove a direct upgrade from that immutable baseline to the current source using the same PostgreSQL database. The upgrade drill installs the previous source, applies its committed migrations, loads only its deterministic synthetic seed data, captures critical synthetic record identities, then applies the current migrations and verifies that those historical records are unchanged.

Only N-1 direct upgrade support is promised by this manifest. Older installations must first follow the supported release chain unless a release note explicitly documents a wider tested range.

## Release preparation

A release PR must keep these items coherent:

1. `package.json` source version;
2. `release/release-policy.json` current version;
3. the full immutable commit for the previous supported release;
4. committed Prisma migrations and `docs/UPGRADING.md` when the schema changes;
5. release notes describing operator-visible changes, migration/backup impact and known compatibility constraints.

The PR must pass at least:

```sh
npm ci
npm run release:check
npm run upgrade:check
npm run check
```

GitHub CI additionally runs the real previous-release **upgrade drill** against disposable PostgreSQL. A release cannot be promoted if that drill fails.

## Publishing a release

After the release PR is merged and all checks are green:

1. identify the merge commit that will be released;
2. verify the commit still has successful CI and upgrade-drill results;
3. create an immutable annotated or signed tag named `v${VERSION}` at that exact commit;
4. build both the `runner` and `migration` Docker targets from the tagged source revision;
5. publish images using immutable registry digests and a version tag; never publish a different source revision under the same version;
6. publish release notes with upgrade prerequisites, backup/restore guidance, schema compatibility and any operator actions;
7. retain the prior supported release artifact long enough to exercise and support the documented N-1 upgrade path.

If a tag or artifact is wrong, do not silently move or overwrite it. Publish a corrected patch version.

## Advancing the support baseline

When preparing the next source line, update `previousSupportedRelease` to the exact commit of the release immediately preceding it. The version stored beside that commit must match the source version at that commit.

The upgrade workflow resolves the baseline from the committed policy file. Changing the baseline therefore changes an auditable, reviewable security/operations contract rather than a hidden CI setting.

## Database compatibility and rollback

Release publication does not make database downgrades safe. `downgradeSupported` remains false.

Follow [`UPGRADING.md`](UPGRADING.md): use expand/backfill/contract migrations, take coordinated backups before material upgrades, and keep the previous application compatible during the documented rollback window. After an incompatible migration, prefer a **forward-fix** or the isolated restore-and-switch procedure rather than an improvised down migration.

## Public repository safety

Release notes, manifests, examples, test fixtures and upgrade-drill data must remain synthetic and public-safe. Never place real employee names, equipment identifiers, serial numbers, company documents, credentials or production database snapshots in a release artifact or the repository.
