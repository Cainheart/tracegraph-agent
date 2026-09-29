import { describe, expect, it } from "vitest";
import {
  containsSensitiveStructuredData,
  redactSensitiveText,
  redactStructuredArtifactValue,
  registerSecretForRedaction,
} from "./crypto.js";

// These fixtures must look like real provider credentials so the redactor
// exercises its provider-pattern rules. They are assembled from fragments at
// runtime so secret scanners do not flag this test's own sample values.
const GITHUB_TOKEN_FIXTURE = "gh" + "p_abcdefghijklmnopqrstuvwxyz123456";
const AWS_SECRET_FIXTURE = "abcdefghijklmnopqrstuvwxyz12345" + "67890ABCD";
const SLACK_TOKEN_FIXTURE = "xo" + "xb-1234567890-abcdefghijklmno";
const AWS_KEY_ID_FIXTURE = "AK" + "IAABCDEFGHIJKLMNOP";

describe("credential redaction", () => {
  it("redacts common provider tokens, secret assignments, and private keys", () => {
    const input = [
      `const githubToken="${GITHUB_TOKEN_FIXTURE}";`,
      `AWS_SECRET_ACCESS_KEY=${AWS_SECRET_FIXTURE}`,
      `SLACK_BOT_TOKEN=${SLACK_TOKEN_FIXTURE}`,
      `AWS_ACCESS_KEY_ID=${AWS_KEY_ID_FIXTURE}`,
      "-----BEGIN PRIVATE KEY-----",
      "private-key-material",
      "-----END PRIVATE KEY-----",
    ].join("\n");

    const redacted = redactSensitiveText(input);

    expect(redacted).not.toContain(GITHUB_TOKEN_FIXTURE);
    expect(redacted).not.toContain(AWS_SECRET_FIXTURE);
    expect(redacted).not.toContain(SLACK_TOKEN_FIXTURE);
    expect(redacted).not.toContain(AWS_KEY_ID_FIXTURE);
    expect(redacted).not.toContain("private-key-material");
    expect(redacted).toContain("[REDACTED_PRIVATE_KEY]");
  });

  it("does not treat context token budgets as credentials", () => {
    const input = "token_limit=12000 reserved_output_tokens=2000";
    expect(redactSensitiveText(input)).toBe(input);
  });

  it("preserves JSON syntax when an assignment ends at a JSON string boundary", () => {
    const secret = GITHUB_TOKEN_FIXTURE;
    const input = JSON.stringify({ content: `GITHUB_TOKEN=${secret}` });
    const redacted = redactSensitiveText(input);

    expect(() => JSON.parse(redacted)).not.toThrow();
    expect(redacted).not.toContain(secret);
    expect(JSON.parse(redacted)).toEqual({ content: "GITHUB_TOKEN=[REDACTED]" });
  });

  it("redacts quoted JSON credential keys without invalidating the JSON", () => {
    const input = JSON.stringify({
      apiKey: "opaque-secret-value",
      content: "safe",
    });
    const redacted = redactSensitiveText(input);

    expect(JSON.parse(redacted)).toEqual({ apiKey: "[REDACTED]", content: "safe" });
    expect(redacted).not.toContain("opaque-secret-value");
  });

  it("redacts an exact registered secret even when its shape is not recognizable", () => {
    const secret = "opaque.value/without-a-provider-prefix";
    registerSecretForRedaction(secret);

    expect(redactSensitiveText(`provider replied with ${secret}`)).toBe(
      "provider replied with [REDACTED_REGISTERED_SECRET]",
    );
  });

  it("redacts registered secrets from structured keys and detects escaped values before serialization", () => {
    const secret = "opaque-\"quoted\\credential-value";
    registerSecretForRedaction(secret);
    const structured = {
      [secret]: "first",
      "[REDACTED_REGISTERED_SECRET]": "second",
      nested: { value: secret },
    };

    const redacted = redactStructuredArtifactValue(structured);
    const serialized = JSON.stringify(redacted);
    expect(serialized).not.toContain(secret);
    expect(redacted).toMatchObject({
      "[REDACTED_REGISTERED_SECRET]": "first",
      "[REDACTED_REGISTERED_SECRET]#2": "[REDACTED]",
      nested: { value: "[REDACTED_REGISTERED_SECRET]" },
    });
    expect(containsSensitiveStructuredData({ arguments: { value: secret } })).toBe(true);
    expect(containsSensitiveStructuredData({ [secret]: "safe" })).toBe(true);
    const jsonEcho = redactSensitiveText(JSON.stringify({ error: secret }));
    expect(jsonEcho).not.toContain(JSON.stringify(secret).slice(1, -1));
    expect(JSON.parse(jsonEcho)).toEqual({ error: "[REDACTED_REGISTERED_SECRET]" });
  });
});
