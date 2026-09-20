import { createHash, randomUUID } from "node:crypto";

const registeredSecretValues = new Set<string>();

export function sha256(value: string | Uint8Array): `sha256:${string}` {
  return `sha256:${createHash("sha256").update(value).digest("hex")}`;
}

export function defaultIdFactory(prefix: string): string {
  return `${prefix}:${randomUUID()}`;
}

export function stableStringify(value: unknown): string {
  if (Array.isArray(value)) {
    return `[${value.map((item) => stableStringify(item)).join(",")}]`;
  }
  if (value !== null && typeof value === "object") {
    const entries = Object.entries(value as Record<string, unknown>)
      .filter(([, item]) => item !== undefined)
      .sort(([left], [right]) => left.localeCompare(right));
    return `{${entries.map(([key, item]) => `${JSON.stringify(key)}:${stableStringify(item)}`).join(",")}}`;
  }
  return JSON.stringify(value);
}

/**
 * Register an opaque credential value with the process-wide redaction guard.
 *
 * Pattern matching cannot recognize every provider's key format. Credential
 * backends and model adapters therefore register the exact value as soon as
 * it enters the trusted Host process. Values are intentionally retained for
 * the lifetime of the process so rotating a key cannot make an older value
 * leak through a later log or ledger write.
 */
export function registerSecretForRedaction(value: string): void {
  // Extremely short values (for example "x") would erase ordinary prose.
  // Credential ingress validates a minimum length; keep this generic helper
  // defensive for direct library callers as well.
  if (value.length >= 8) registeredSecretValues.add(value);
}

export function redactSecrets(value: string): string {
  let redacted = value;
  const registeredForms = new Set<string>();
  for (const secret of registeredSecretValues) {
    registeredForms.add(secret);
    // Provider errors and structured logs often echo a credential inside a
    // JSON string. Match that encoded form as well as the raw in-memory value.
    registeredForms.add(JSON.stringify(secret).slice(1, -1));
  }
  for (const secret of [...registeredForms].sort((left, right) => right.length - left.length)) {
    redacted = redacted.split(secret).join("[REDACTED_REGISTERED_SECRET]");
  }
  return redacted
    .replace(
      /-----BEGIN [A-Z0-9 ]*PRIVATE KEY-----[\s\S]*?-----END [A-Z0-9 ]*PRIVATE KEY-----/gu,
      "[REDACTED_PRIVATE_KEY]",
    )
    .replace(/\b(sk-[A-Za-z0-9_-]{12,})\b/gu, "[REDACTED_API_KEY]")
    .replace(/\bgh[pousr]_[A-Za-z0-9_]{20,}\b/gu, "[REDACTED_GITHUB_TOKEN]")
    .replace(/\bxox[baprs]-[A-Za-z0-9-]{10,}\b/gu, "[REDACTED_SLACK_TOKEN]")
    .replace(/\bAKIA[A-Z0-9]{16}\b/gu, "[REDACTED_AWS_ACCESS_KEY]")
    .replace(
      /(["'])([A-Za-z_][A-Za-z0-9_.-]*)\1(\s*:\s*)(?:"[^"\r\n]*"|'[^'\r\n]*'|[^\s,;}'"\r\n]+)/gu,
      (assignment, quote: string, key: string, separator: string) =>
        isSensitiveKey(key) ? `${quote}${key}${quote}${separator}"[REDACTED]"` : assignment,
    )
    .replace(
      /\b([A-Za-z_][A-Za-z0-9_.-]*)\s*[:=]\s*(?:"[^"\r\n]*"|'[^'\r\n]*'|[^\s,;'"\r\n]+)/gu,
      (assignment, key: string) => isSensitiveKey(key) ? `${key}=[REDACTED]` : assignment,
    )
    .replace(/\b(Bearer\s+)[A-Za-z0-9._~+/-]+=*/giu, "$1[REDACTED]");
}

export function redactSensitiveText(value: string): string {
  return redactSecrets(value)
    .replace(
      /(^|[\s"'(])\/(?:Users|home|tmp|private|var|Volumes|opt|etc)\/[^\s"')]+/gmu,
      "$1[REDACTED_LOCAL_PATH]",
    )
    .replace(
      /(^|[\s"'(=])\/(?!\/|dev\/null(?:\s|$))(?:[^/\s"')]+\/)+[^\s"')]+/gmu,
      "$1[REDACTED_LOCAL_PATH]",
    )
    .replace(/\b[A-Za-z]:\\[^\s"']+/gu, "[REDACTED_LOCAL_PATH]");
}

const sensitiveKeys = new Set([
  "apikey",
  "authorization",
  "credential",
  "cwd",
  "password",
  "privatekey",
  "realroot",
  "refreshtoken",
  "secret",
  "token",
]);

export function isSensitiveKey(key: string): boolean {
  const normalized = key.toLowerCase().replace(/[^a-z0-9]/gu, "");
  return sensitiveKeys.has(normalized)
    || normalized.endsWith("token")
    || normalized.endsWith("secret")
    || normalized.endsWith("password")
    || normalized.endsWith("apikey")
    || normalized.endsWith("accesskey")
    || normalized.endsWith("privatekey")
    || normalized.endsWith("credential");
}

export function containsSensitiveStructuredData(value: unknown, depth = 0): boolean {
  if (depth > 12 || value === null) return false;
  if (typeof value === "string") return redactSecrets(value) !== value;
  if (typeof value !== "object") return false;
  if (Array.isArray(value)) {
    return value.some((item) => containsSensitiveStructuredData(item, depth + 1));
  }
  return Object.entries(value).some(
    ([key, item]) => isSensitiveKey(key)
      || redactSecrets(key) !== key
      || containsSensitiveStructuredData(item, depth + 1),
  );
}

export function redactStructuredValue(value: unknown, depth = 0): unknown {
  if (depth > 8) return "[TRUNCATED_DEPTH]";
  if (typeof value === "string") return redactSensitiveText(value).slice(0, 8_000);
  if (value === null || typeof value === "number" || typeof value === "boolean") return value;
  if (Array.isArray(value)) {
    return value.slice(0, 100).map((item) => redactStructuredValue(item, depth + 1));
  }
  if (typeof value === "object") {
    const output: Record<string, unknown> = {};
    for (const [key, item] of Object.entries(value).slice(0, 100)) {
      const safeKey = uniqueRedactedKey(output, redactSensitiveText(key));
      output[safeKey] = isSensitiveKey(key)
        ? "[REDACTED]"
        : redactStructuredValue(item, depth + 1);
    }
    return output;
  }
  return String(value);
}

/**
 * Redacts a parsed JSON Artifact without applying the projection-oriented
 * collection and string limits used by `redactStructuredValue`.
 *
 * Artifact hashes describe the complete stored payload, so silently dropping
 * array members, object properties, or string suffixes here would make an
 * apparently valid evidence object incomplete. A depth guard remains to keep
 * adversarial JSON from exhausting the JavaScript call stack.
 */
export function redactStructuredArtifactValue(value: unknown, depth = 0): unknown {
  if (depth > 100) return "[TRUNCATED_DEPTH]";
  if (typeof value === "string") return redactSensitiveText(value);
  if (value === null || typeof value === "number" || typeof value === "boolean") return value;
  if (Array.isArray(value)) {
    return value.map((item) => redactStructuredArtifactValue(item, depth + 1));
  }
  if (typeof value === "object") {
    const output: Record<string, unknown> = {};
    for (const [key, item] of Object.entries(value)) {
      const safeKey = uniqueRedactedKey(output, redactSensitiveText(key));
      output[safeKey] = isSensitiveKey(key)
        ? "[REDACTED]"
        : redactStructuredArtifactValue(item, depth + 1);
    }
    return output;
  }
  return String(value);
}

function uniqueRedactedKey(output: Record<string, unknown>, redactedKey: string): string {
  if (!Object.hasOwn(output, redactedKey)) return redactedKey;
  let suffix = 2;
  while (Object.hasOwn(output, `${redactedKey}#${suffix}`)) suffix += 1;
  return `${redactedKey}#${suffix}`;
}
