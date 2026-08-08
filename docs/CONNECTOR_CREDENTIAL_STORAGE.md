# Durable connector credential storage

Connector secrets are persisted through the encrypted vault boundary in `lib/integrations/credential-vault.ts` and the production Prisma store in `lib/integrations/prisma-credential-store.ts`.

## Runtime composition

Use `createPrismaConnectorCredentialVault()` for the repository-provided durable implementation. It composes:

- `PrismaConnectorCredentialRecordStore` for PostgreSQL persistence;
- `createCredentialEncryptionKeyProviderFromEnv()` for current/previous master keys;
- `EncryptedConnectorCredentialVault` for AES-256-GCM encryption, authenticated tenant/connector binding and safe runtime resolution.

The required current key is configured with:

```text
CONNECTOR_CREDENTIAL_KEY_VERSION=v1
CONNECTOR_CREDENTIAL_MASTER_KEY_BASE64=<32-byte base64 key>
```

During key rotation, keep exactly one previous key available:

```text
CONNECTOR_CREDENTIAL_PREVIOUS_KEY_VERSION=v1
CONNECTOR_CREDENTIAL_PREVIOUS_MASTER_KEY_BASE64=<previous 32-byte base64 key>
```

New and updated credentials are encrypted with the current key. Existing records remain readable with the previous key until they are re-saved under the current version.

## Persistence boundary

`ConnectorCredentialRecord` stores only encrypted material plus bounded metadata:

- credential ID;
- organization ID;
- connector ID;
- label;
- credential kind;
- key version;
- ciphertext;
- IV;
- authentication tag;
- creation/update timestamps.

Plaintext bearer tokens and API-key values never enter PostgreSQL columns, `AuditLog`, structured logs or public metadata.

The store performs all find/list/delete operations with exact organization + connector scope. Updates refuse to move an existing credential ID across organization or connector boundaries.

## Audit behavior

Create, update and delete operations write `ConnectorCredential` audit events. Audit JSON intentionally contains metadata only: organization, connector, credential ID, label, kind, key version and timestamps.

Ciphertext, IV, authentication tags and plaintext secret values are never copied into audit payloads.

## Operational requirements

The encryption master key is application secret material and must be supplied at runtime through the deployment secret mechanism. Do not commit it, bake it into an image, put it in connector definitions or expose it through client-side configuration.

Backups of PostgreSQL contain encrypted credential records. A usable disaster-recovery plan therefore requires both the database backup and the matching credential master-key versions. Losing all configured key versions makes the encrypted records intentionally unrecoverable.

Before removing a previous key version, rotate/re-save every credential still encrypted with that version and verify that no `ConnectorCredentialRecord.keyVersion` references it.

## Verification

The normal database smoke check exercises the durable store against PostgreSQL: create, encrypted-at-rest inspection, vault re-instantiation, exact connector-scope rejection, key rotation, metadata-only audit verification and deletion.
