export type ExternalIdentity = {
  provider: string;
  subject: string;
  email: string;
  displayName: string;
};

export interface AuthenticationProvider {
  readonly id: string;
  verify(input: unknown): Promise<ExternalIdentity | null>;
}

export function normalizeExternalIdentity(identity: ExternalIdentity): ExternalIdentity {
  return {
    ...identity,
    provider: identity.provider.trim().toLowerCase(),
    subject: identity.subject.trim(),
    email: identity.email.trim().toLowerCase(),
    displayName: identity.displayName.trim(),
  };
}

export function isValidExternalIdentity(identity: ExternalIdentity): boolean {
  return Boolean(
    identity.provider &&
      identity.subject &&
      identity.email.includes("@") &&
      identity.displayName,
  );
}
