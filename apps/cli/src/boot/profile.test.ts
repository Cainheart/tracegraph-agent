import type { ResolveCliProfileInput } from "./profile.js";
import {
  dumpResolvedCliProfile,
  hashResolvedCliProfile,
  resolveCliProfile,
} from "./profile.js";
import { describe, expect, it } from "vitest";

describe("CLI resolved profile", () => {
  it("dumps and hashes the same immutable safe profile deterministically", () => {
    const first = resolveCliProfile(input());
    const second = resolveCliProfile(input());

    expect(first).toEqual(second);
    expect(hashResolvedCliProfile(first)).toBe(first.digest);
    expect(dumpResolvedCliProfile(first)).toBe(dumpResolvedCliProfile(second));
    expect(JSON.parse(dumpResolvedCliProfile(first))).toEqual(first);
    expect(Object.isFrozen(first.selections.subagents.profiles)).toBe(true);
  });

  it("changes the digest when a safe resolved selection changes", () => {
    const original = resolveCliProfile(input());
    const changed = resolveCliProfile({
      ...input(),
      retrievalMode: "remote_with_local_fallback",
    });

    expect(changed.digest).not.toBe(original.digest);
  });

  it("preserves configured server order in the dump and digest", () => {
    const configured = input();
    const reversed = resolveCliProfile({
      ...configured,
      mcpServers: [...configured.mcpServers].reverse(),
    });
    const original = resolveCliProfile(configured);

    expect(reversed.selections.mcp_servers.map(({ name }) => name)).toEqual([
      "filesystem",
      "review",
    ]);
    expect(reversed.digest).not.toBe(original.digest);
  });

  it("excludes credential values, paths, process arguments, endpoints, raw prompts, and status errors", () => {
    const unsafe = input();
    const contaminated = {
      ...unsafe,
      model: {
        provider: "custom",
        protocol: "openai-chat-completions",
        model: "private-model",
        baseUrl: "https://private.invalid/secret-endpoint",
        credentialRef: "[secret:PRIVATE_MODEL_KEY]",
        apiKey: "raw-model-api-key",
      },
      mcpServers: unsafe.mcpServers.map((server) => ({
        ...server,
        command: "/private/path/mcp-server",
        args: ["--token=raw-mcp-token"],
        env: { PRIVATE_TOKEN: "raw-mcp-env-secret" },
      })),
      lspServers: unsafe.lspServers.map((server) => ({
        ...server,
        command: "/private/path/lsp-server",
        args: ["--private-argument"],
      })),
      extensions: unsafe.extensions.map((extension) => ({
        ...extension,
        error_message: "private extension error",
        stderr_tail: "private stderr content",
      })),
    } as unknown as ResolveCliProfileInput;

    const dump = dumpResolvedCliProfile(resolveCliProfile(contaminated));

    for (const privateValue of [
      "private.invalid",
      "PRIVATE_MODEL_KEY",
      "raw-model-api-key",
      "/private/path",
      "raw-mcp-token",
      "raw-mcp-env-secret",
      "--private-argument",
      "private extension error",
      "private stderr content",
    ]) {
      expect(dump).not.toContain(privateValue);
    }
  });

  it("rejects a stale digest rather than dumping a modified profile", () => {
    const profile = resolveCliProfile(input());
    const changed = {
      ...profile,
      selections: {
        ...profile.selections,
        retrieval_mode: "remote_with_local_fallback" as const,
      },
    };

    expect(() => dumpResolvedCliProfile(changed)).toThrow("digest does not match");
  });
});

function input(): ResolveCliProfileInput {
  return {
    permission: { selectedPreset: "workspace-write", sandboxMode: "workspace-write" },
    runtime: {
      maxTurns: 12,
      rollbackPolicy: { enabled: false, allowForce: false },
      imageInput: false,
    },
    model: { provider: "openai", protocol: "openai-chat-completions", model: "gpt-4.1-mini" },
    telemetrySink: "noop",
    retrievalMode: "local",
    subagents: {
      profiles: [],
      limits: { max_parallel_subagents: 2, max_depth: 1 },
    },
    mcpServers: [
      {
        name: "review",
        required: true,
        transport: "stdio",
        command: "mcp-review",
        args: [],
        env: {},
        tool_policy: { allow: ["read"], deny: [] },
      },
      {
        name: "filesystem",
        required: false,
        transport: "stdio",
        command: "mcp-filesystem",
        args: [],
        env: {},
      },
    ],
    lspServers: [
      {
        name: "typescript",
        command: "typescript-language-server",
        args: ["--stdio"],
        language_ids: ["typescript"],
        file_extensions: [".ts"],
        request_timeout_ms: 15_000,
        diagnostics_wait_ms: 350,
      },
    ],
    extensions: [
      {
        name: "builtin-run-state-tools",
        api_version: "tracegraph.extension.v1",
        state: "active",
        registration_count: 8,
        generation: 1,
        updated_at: "2026-09-30T00:00:00.000Z",
      },
    ],
  };
}
