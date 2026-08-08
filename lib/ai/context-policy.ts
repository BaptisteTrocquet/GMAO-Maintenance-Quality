const FORBIDDEN_PROMPT_KEYS = new Set([
  "email",
  "phone",
  "requester",
  "requesterId",
  "assignee",
  "assigneeId",
  "user",
  "users",
  "createdBy",
  "createdById",
  "updatedBy",
  "updatedById",
  "storageKey",
  "attachments",
  "attachment",
  "audit",
  "auditLog",
  "auditLogs",
  "beforeJson",
  "afterJson",
  "completionNote",
  "checklistNote",
  "supplier",
  "supplierId",
  "unitCost",
  "cost",
  "credential",
  "credentials",
  "secret",
  "secrets",
  "token",
  "tokens",
]);

const FORBIDDEN_AUDIT_KEYS = new Set([
  ...FORBIDDEN_PROMPT_KEYS,
  "prompt",
  "messages",
  "question",
  "symptom",
  "answer",
  "summary",
  "suggestion",
  "content",
  "excerpt",
  "documentText",
  "label",
  "href",
]);

const MAX_DEPTH = 20;
const MAX_KEYS = 20_000;

export class AiContextPolicyError extends Error {
  constructor(
    public readonly code: "FORBIDDEN_FIELD" | "INVALID_CONTEXT",
    message: string,
  ) {
    super(message);
    this.name = "AiContextPolicyError";
  }
}

function assertObjectKeysSafe(value: unknown, forbidden: ReadonlySet<string>, contextLabel: string) {
  let visitedKeys = 0;

  function visit(current: unknown, depth: number) {
    if (depth > MAX_DEPTH) {
      throw new AiContextPolicyError("INVALID_CONTEXT", `${contextLabel} nesting is too deep`);
    }
    if (current === null || current === undefined) return;
    if (typeof current === "string" || typeof current === "number" || typeof current === "boolean") {
      return;
    }
    if (Array.isArray(current)) {
      for (const item of current) visit(item, depth + 1);
      return;
    }
    if (typeof current !== "object") {
      throw new AiContextPolicyError("INVALID_CONTEXT", `${contextLabel} contains an unsupported value`);
    }

    for (const [key, nested] of Object.entries(current as Record<string, unknown>)) {
      visitedKeys += 1;
      if (visitedKeys > MAX_KEYS) {
        throw new AiContextPolicyError("INVALID_CONTEXT", `${contextLabel} contains too many fields`);
      }
      if (forbidden.has(key)) {
        throw new AiContextPolicyError(
          "FORBIDDEN_FIELD",
          `${contextLabel} contains forbidden field '${key}'`,
        );
      }
      visit(nested, depth + 1);
    }
  }

  visit(value, 0);
}

export function assertAiPromptContextSafe(value: unknown) {
  assertObjectKeysSafe(value, FORBIDDEN_PROMPT_KEYS, "AI prompt context");
}

export function assertAiAuditPayloadSafe(value: unknown) {
  assertObjectKeysSafe(value, FORBIDDEN_AUDIT_KEYS, "AI audit payload");
}
