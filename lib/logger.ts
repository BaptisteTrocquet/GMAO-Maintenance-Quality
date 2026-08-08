export type LogLevel = "debug" | "info" | "warn" | "error";
export type LogContext = Record<string, unknown>;

export type StructuredLogger = {
  debug: (message: string, context?: LogContext) => void;
  info: (message: string, context?: LogContext) => void;
  warn: (message: string, context?: LogContext) => void;
  error: (message: string, context?: LogContext) => void;
  child: (context: LogContext) => StructuredLogger;
};

const SERVICE_NAME = "opengmao";
const REDACTED = "[REDACTED]";
const CIRCULAR = "[CIRCULAR]";
const UNSERIALIZABLE = "[UNSERIALIZABLE]";
const MAX_DEPTH = 6;
const MAX_ARRAY_ITEMS = 50;
const MAX_OBJECT_KEYS = 100;
const MAX_STRING_CHARS = 4_000;

const LEVEL_PRIORITY: Record<LogLevel, number> = {
  debug: 10,
  info: 20,
  warn: 30,
  error: 40,
};

const SENSITIVE_KEYS = new Set([
  "authorization",
  "proxyauthorization",
  "cookie",
  "setcookie",
  "password",
  "passwd",
  "clientsecret",
  "secret",
  "token",
  "accesstoken",
  "refreshtoken",
  "idtoken",
  "apikey",
  "accesskey",
  "secretaccesskey",
  "privatekey",
  "credential",
  "credentials",
  "databaseurl",
  "connectionstring",
  "dsn",
  "session",
  "sessionid",
]);

function runtimeEnvironment() {
  return typeof process !== "undefined" && process.env.NODE_ENV
    ? process.env.NODE_ENV
    : "unknown";
}

function configuredLevel(): LogLevel {
  const candidate =
    typeof process !== "undefined" ? process.env.LOG_LEVEL?.trim().toLowerCase() : undefined;

  if (candidate === "debug" || candidate === "info" || candidate === "warn" || candidate === "error") {
    return candidate;
  }

  return runtimeEnvironment() === "production" ? "info" : "debug";
}

function shouldWrite(level: LogLevel) {
  return LEVEL_PRIORITY[level] >= LEVEL_PRIORITY[configuredLevel()];
}

function normalizeKey(key: string) {
  return key.replace(/[^a-z0-9]/gi, "").toLowerCase();
}

function isSensitiveKey(key: string) {
  const normalized = normalizeKey(key);
  return (
    SENSITIVE_KEYS.has(normalized) ||
    normalized.endsWith("password") ||
    normalized.endsWith("secret") ||
    normalized.endsWith("token") ||
    normalized.endsWith("apikey") ||
    normalized.endsWith("privatekey")
  );
}

function truncate(value: string) {
  if (value.length <= MAX_STRING_CHARS) return value;
  return `${value.slice(0, MAX_STRING_CHARS)}…[truncated]`;
}

function redactSecretLikeText(value: string) {
  let redacted = value;

  // URI userinfo commonly carries database/object-store credentials.
  redacted = redacted.replace(
    /([a-z][a-z0-9+.-]*:\/\/)([^@\s/]+)@/gi,
    "$1[REDACTED]@",
  );

  // HTTP authorization and cookie header fragments should never reach logs intact.
  redacted = redacted.replace(
    /\b(authorization|proxy-authorization|cookie|set-cookie)\s*[:=]\s*[^\r\n]+/gi,
    "$1=[REDACTED]",
  );
  redacted = redacted.replace(/\bBearer\s+[A-Za-z0-9._~+/=-]+/gi, "Bearer [REDACTED]");

  // Product/server secret prefixes and JWT-shaped values.
  redacted = redacted.replace(/\b(gmao_sk_|whsec_)[A-Za-z0-9._-]+/g, "$1[REDACTED]");
  redacted = redacted.replace(
    /\beyJ[A-Za-z0-9_-]{6,}\.[A-Za-z0-9_-]{6,}\.[A-Za-z0-9_-]{6,}\b/g,
    "[REDACTED_JWT]",
  );

  // Common secret-bearing URL/query/form parameter fragments.
  redacted = redacted.replace(
    /([?&;\s](?:access_token|refresh_token|id_token|token|password|passwd|secret|client_secret|api[_-]?key)=)[^&#;\s]*/gi,
    "$1[REDACTED]",
  );

  return truncate(redacted);
}

function safeError(error: Error) {
  const result: Record<string, unknown> = {
    name: redactSecretLikeText(error.name || "Error"),
  };

  const code = (error as Error & { code?: unknown }).code;
  if (typeof code === "string" || typeof code === "number") {
    result.code = redactSecretLikeText(String(code));
  }

  // Error messages and stacks often contain SQL, URLs, headers or provider payloads.
  // Callers should emit a stable application error code as separate context instead.
  return result;
}

function sanitizeValue(value: unknown, depth: number, seen: WeakSet<object>): unknown {
  if (value === null || value === undefined) return value ?? null;

  if (typeof value === "string") return redactSecretLikeText(value);
  if (typeof value === "boolean") return value;
  if (typeof value === "number") return Number.isFinite(value) ? value : null;
  if (typeof value === "bigint") return value.toString();
  if (typeof value === "symbol" || typeof value === "function") return UNSERIALIZABLE;

  if (value instanceof Date) {
    const time = value.getTime();
    return Number.isFinite(time) ? value.toISOString() : "Invalid Date";
  }
  if (value instanceof URL) return redactSecretLikeText(value.toString());
  if (value instanceof Error) return safeError(value);

  if (typeof value !== "object") return UNSERIALIZABLE;
  if (depth >= MAX_DEPTH) return "[MAX_DEPTH]";
  if (seen.has(value)) return CIRCULAR;

  seen.add(value);
  try {
    if (Array.isArray(value)) {
      const items = value
        .slice(0, MAX_ARRAY_ITEMS)
        .map((item) => sanitizeValue(item, depth + 1, seen));
      if (value.length > MAX_ARRAY_ITEMS) {
        items.push(`[${value.length - MAX_ARRAY_ITEMS} more items]`);
      }
      return items;
    }

    let keys: string[];
    try {
      keys = Object.keys(value).slice(0, MAX_OBJECT_KEYS);
    } catch {
      return UNSERIALIZABLE;
    }

    const output: Record<string, unknown> = {};
    for (const key of keys) {
      if (isSensitiveKey(key)) {
        output[key] = REDACTED;
        continue;
      }

      try {
        output[key] = sanitizeValue(
          (value as Record<string, unknown>)[key],
          depth + 1,
          seen,
        );
      } catch {
        output[key] = UNSERIALIZABLE;
      }
    }

    try {
      if (Object.keys(value).length > MAX_OBJECT_KEYS) {
        output._truncatedKeys = true;
      }
    } catch {
      output._truncatedKeys = true;
    }

    return output;
  } finally {
    seen.delete(value);
  }
}

function sanitizeContext(context: LogContext) {
  const sanitized = sanitizeValue(context, 0, new WeakSet<object>());
  if (!sanitized || typeof sanitized !== "object" || Array.isArray(sanitized)) return {};
  return sanitized as Record<string, unknown>;
}

function emit(level: LogLevel, serialized: string) {
  if (level === "error") {
    console.error(serialized);
    return;
  }
  if (level === "warn") {
    console.warn(serialized);
    return;
  }
  if (level === "debug") {
    console.debug(serialized);
    return;
  }
  console.info(serialized);
}

function createLogger(baseContext: LogContext = {}): StructuredLogger {
  const write = (level: LogLevel, message: string, context: LogContext = {}) => {
    if (!shouldWrite(level)) return;

    const safeContext = sanitizeContext({ ...baseContext, ...context });
    const entry = {
      ...safeContext,
      timestamp: new Date().toISOString(),
      level,
      service: SERVICE_NAME,
      environment: runtimeEnvironment(),
      message: redactSecretLikeText(message),
    };

    emit(level, JSON.stringify(entry));
  };

  return {
    debug: (message, context) => write("debug", message, context),
    info: (message, context) => write("info", message, context),
    warn: (message, context) => write("warn", message, context),
    error: (message, context) => write("error", message, context),
    child: (context) => createLogger({ ...baseContext, ...context }),
  };
}

export const logger = createLogger();
