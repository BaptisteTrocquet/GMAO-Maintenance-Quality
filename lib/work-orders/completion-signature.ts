export const WORK_ORDER_COMPLETION_ATTESTATION_VERSION = "work-completion-v1";
export const WORK_ORDER_COMPLETION_ATTESTATION =
  "I confirm that the recorded work, checklist, and completion note are accurate to the best of my knowledge.";

export type WorkOrderCompletionSignature = {
  method: "TYPED_NAME";
  signedById: string;
  signedByName: string;
  capturedName: string;
  signedAt: string;
  attestationVersion: typeof WORK_ORDER_COMPLETION_ATTESTATION_VERSION;
};

export function normalizeSignatureName(value: string) {
  return value.normalize("NFKC").trim().replace(/\s+/g, " ").toLocaleLowerCase("en-US");
}

export function signatureNameMatchesIdentity(input: string, displayName: string) {
  return normalizeSignatureName(input) === normalizeSignatureName(displayName);
}

export function parseCompletionSignatureFromAudit(afterJson: string | null) {
  if (!afterJson) return null;
  try {
    const parsed = JSON.parse(afterJson) as { signature?: unknown };
    const value = parsed.signature;
    if (!value || typeof value !== "object") return null;
    const signature = value as Partial<WorkOrderCompletionSignature>;
    if (
      signature.method !== "TYPED_NAME" ||
      typeof signature.signedById !== "string" ||
      typeof signature.signedByName !== "string" ||
      typeof signature.capturedName !== "string" ||
      typeof signature.signedAt !== "string" ||
      signature.attestationVersion !== WORK_ORDER_COMPLETION_ATTESTATION_VERSION
    ) {
      return null;
    }
    return signature as WorkOrderCompletionSignature;
  } catch {
    return null;
  }
}
