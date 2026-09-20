import { chmod, mkdir, mkdtemp, readFile, stat, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  CredentialBackendError,
  EnvironmentCredentialStore,
  LayeredCredentialStore,
  MacOsKeychainCredentialStore,
  PrivateFileCredentialStore,
  createSecretReference,
  recordCredentialMigration,
  resolveSecretReference,
  type SecurityCommand,
} from "./credentials.js";
import { JsonlEventLedger } from "./event-ledger.js";
import { projectRun } from "./projection.js";
import { removeControlledTemporaryDirectory } from "./workspace.js";

const roots: string[] = [];

afterEach(async () => {
  await Promise.all(roots.splice(0).map(removeControlledTemporaryDirectory));
});

describe("credential stores", () => {
  it("round-trips the private-file fallback with 0600 permissions and safe list metadata", async () => {
    const root = await temporaryRoot();
    const path = join(root, "private", "credentials.json");
    const store = new PrivateFileCredentialStore(path, {
      now: () => new Date("2026-09-18T00:00:00.000Z"),
    });

    await store.set("TRACEGRAPH_OPENAI_KEY", "opaque-file-secret");

    await expect(store.get("TRACEGRAPH_OPENAI_KEY")).resolves.toBe("opaque-file-secret");
    const listed = await store.list();
    expect(listed).toEqual([{
      name: "TRACEGRAPH_OPENAI_KEY",
      backend: "private_file",
      writable: true,
      last_updated_at: "2026-09-18T00:00:00.000Z",
    }]);
    expect(JSON.stringify(listed)).not.toContain("opaque-file-secret");
    expect((await stat(path)).mode & 0o777).toBe(0o600);
    expect((await stat(join(root, "private"))).mode & 0o777).toBe(0o700);

    await store.delete("TRACEGRAPH_OPENAI_KEY");
    await expect(store.get("TRACEGRAPH_OPENAI_KEY")).resolves.toBeNull();
  });

  it("fails closed when an existing fallback file is readable by group or others", async () => {
    const root = await temporaryRoot();
    const path = join(root, "credentials.json");
    await writeFile(path, `${JSON.stringify({
      version: 1,
      credentials: {
        TRACEGRAPH_OPENAI_KEY: {
          value: "opaque-file-secret",
          updated_at: "2026-09-18T00:00:00.000Z",
        },
      },
    })}\n`, { mode: 0o600 });
    await chmod(path, 0o644);
    const store = new PrivateFileCredentialStore(path);

    await expect(store.get("TRACEGRAPH_OPENAI_KEY")).rejects.toMatchObject({
      name: "CredentialBackendError",
      backend: "private_file",
    });
  });

  it("fails closed when the fallback path is a symbolic link", async () => {
    const root = await temporaryRoot();
    const target = join(root, "real-credentials.json");
    const path = join(root, "credentials.json");
    await writeFile(target, `${JSON.stringify({ version: 1, credentials: {} })}\n`, { mode: 0o600 });
    await symlink(target, path);

    await expect(new PrivateFileCredentialStore(path).list()).rejects.toMatchObject({
      name: "CredentialBackendError",
      backend: "private_file",
    });
  });

  it("fails closed when the fallback parent directory is a symbolic link", async () => {
    const root = await temporaryRoot();
    const targetDirectory = join(root, "real-private");
    const linkedDirectory = join(root, "linked-private");
    await mkdir(targetDirectory, { mode: 0o700 });
    await symlink(targetDirectory, linkedDirectory);

    await expect(new PrivateFileCredentialStore(
      join(linkedDirectory, "credentials.json"),
    ).set("TRACEGRAPH_OPENAI_KEY", "opaque-file-secret")).rejects.toMatchObject({
      name: "CredentialBackendError",
      backend: "private_file",
    });
  });

  it("fails closed when the fallback path is not a regular file", async () => {
    const root = await temporaryRoot();
    const path = join(root, "credentials.json");
    await mkdir(path, { mode: 0o700 });

    await expect(new PrivateFileCredentialStore(path).get("TRACEGRAPH_OPENAI_KEY")).rejects.toMatchObject({
      name: "CredentialBackendError",
      backend: "private_file",
    });
  });

  it("rejects an oversized fallback file before parsing it", async () => {
    const root = await temporaryRoot();
    const path = join(root, "credentials.json");
    await writeFile(path, "x".repeat(1024 * 1024 + 1), { mode: 0o600 });

    await expect(new PrivateFileCredentialStore(path).list()).rejects.toMatchObject({
      name: "CredentialBackendError",
      backend: "private_file",
      message: "The private credential file is too large",
    });
  });

  it("normalizes surrounding environment whitespace and rejects embedded control characters", async () => {
    const normalized = new EnvironmentCredentialStore({
      TRACEGRAPH_OPENAI_KEY: "  environment-secret  ",
    });
    await expect(normalized.get("TRACEGRAPH_OPENAI_KEY")).resolves.toBe("environment-secret");

    const unsafe = new EnvironmentCredentialStore({
      TRACEGRAPH_OPENAI_KEY: "unsafe\nsecret",
    });
    await expect(unsafe.get("TRACEGRAPH_OPENAI_KEY")).rejects.toThrow(
      "Credential value must not contain control characters",
    );
  });

  it("keeps a Keychain secret out of argv and returns only safe metadata", async () => {
    const commands: SecurityCommand[] = [];
    let saved = "";
    const run = vi.fn(async (command: SecurityCommand) => {
      commands.push(command);
      if (command.args[0] === "add-generic-password") {
        saved = command.input?.split("\n")[0] ?? "";
        return { stdout: "" };
      }
      if (command.args[0] === "find-generic-password") return { stdout: `${saved}\n` };
      return { stdout: "" };
    });
    const store = new MacOsKeychainCredentialStore({
      run,
      now: () => new Date("2026-09-18T00:00:00.000Z"),
    });

    await store.set("TRACEGRAPH_DEEPSEEK_KEY", "opaque-keychain-secret");
    await expect(store.get("TRACEGRAPH_DEEPSEEK_KEY")).resolves.toBe("opaque-keychain-secret");

    expect(commands[0]?.args).not.toContain("opaque-keychain-secret");
    expect(commands[0]?.args.at(-1)).toBe("-w");
    expect(commands[0]?.input).toBe("opaque-keychain-secret\nopaque-keychain-secret\n");
    const listed = await store.list();
    expect(listed).toEqual([{
      name: "TRACEGRAPH_DEEPSEEK_KEY",
      backend: "macos_keychain",
      writable: true,
      last_updated_at: "2026-09-18T00:00:00.000Z",
    }]);
    expect(JSON.stringify(listed)).not.toContain("opaque-keychain-secret");
  });

  it("does not fall through to an environment value when the selected Keychain backend fails", async () => {
    const keychain = new MacOsKeychainCredentialStore({
      run: async () => { throw Object.assign(new Error("locked"), { exitCode: 51 }); },
    });
    const environment = new EnvironmentCredentialStore({
      TRACEGRAPH_OPENAI_KEY: "environment-secret",
    });
    const store = new LayeredCredentialStore(keychain, environment);

    await expect(store.get("TRACEGRAPH_OPENAI_KEY")).rejects.toBeInstanceOf(CredentialBackendError);
    await expect(environment.list()).resolves.toEqual([]);
  });

  it("resolves a typed secret reference and reports its backend without exposing its value in metadata", async () => {
    const root = await temporaryRoot();
    const store = new PrivateFileCredentialStore(join(root, "credentials.json"));
    await store.set("TRACEGRAPH_CUSTOM_KEY", "custom-opaque-secret");
    const reference = createSecretReference("TRACEGRAPH_CUSTOM_KEY");

    const resolved = await resolveSecretReference(reference, store);

    expect(resolved.value).toBe("custom-opaque-secret");
    expect(resolved.metadata).toMatchObject({
      name: "TRACEGRAPH_CUSTOM_KEY",
      backend: "private_file",
      writable: true,
    });
    expect(JSON.stringify(resolved.metadata)).not.toContain("custom-opaque-secret");
  });

  it("records migration as a replayable system maintenance Run without the secret value", async () => {
    const root = await temporaryRoot();
    let id = 0;
    const record = () => recordCredentialMigration({
      dataDir: root,
      credential: {
        name: "TRACEGRAPH_OPENAI_KEY",
        backend: "private_file",
        writable: true,
        last_updated_at: "2026-09-18T00:00:00.000Z",
      },
      secretReference: "${secret:TRACEGRAPH_OPENAI_KEY}",
      migratedAt: "2026-09-18T00:00:00.000Z",
      migrationId: "9a660389-ab7a-46e5-860a-1a6f238d5a38",
      now: () => new Date("2026-09-18T00:00:00.000Z"),
      idFactory: (prefix) => `${prefix}:${++id}`,
    });
    const events = await record();
    const repeated = await record();

    expect(events.map((event) => event.type)).toEqual([
      "run.created",
      "credentials.migrated",
      "run.completed",
    ]);
    expect(projectRun(events)).toMatchObject({
      project_id: "system:tracegraph",
      status: "completed",
    });
    expect(repeated.map((event) => event.event_id)).toEqual(events.map((event) => event.event_id));
    const ledger = await readFile(
      join(root, "events", `${events[0]!.run_id.replace(/[^A-Za-z0-9_.-]/gu, "_")}.jsonl`),
      "utf8",
    );
    expect(ledger).toContain("TRACEGRAPH_OPENAI_KEY");
    expect(ledger).not.toContain("secret_reference");
    expect(ledger).not.toContain("opaque-file-secret");
    expect(ledger.trim().split("\n")).toHaveLength(3);
  });

  it("recovers an interrupted migration audit Run idempotently", async () => {
    const root = await temporaryRoot();
    const migrationId = "f5985f4a-b42c-47bc-bfe3-0d1b06bf7818";
    const runId = `run:credential-migration:${migrationId}`;
    const ledger = new JsonlEventLedger(join(root, "events"), {
      now: () => new Date("2026-09-18T00:00:00.000Z"),
      idFactory: (prefix) => `${prefix}:partial`,
    });
    await ledger.append({
      project_id: "system:tracegraph",
      run_id: runId,
      attempt: 0,
      artifact_refs: [],
      type: "run.created",
      summary: "Credential migration audit run created",
      idempotency_key: `${runId}:created`,
      data: {
        task: "Migrate a legacy model credential into the selected secure backend",
        mode: "plan",
        workspace_kind: "readonly_local",
        reasoning_effort: "default",
        system_maintenance: true,
      },
    });

    const recovered = await recordCredentialMigration({
      dataDir: root,
      credential: {
        name: "TRACEGRAPH_OPENAI_KEY",
        backend: "private_file",
        writable: true,
      },
      secretReference: "${secret:TRACEGRAPH_OPENAI_KEY}",
      migratedAt: "2026-09-18T00:00:00.000Z",
      migrationId,
      now: () => new Date("2026-09-18T00:00:00.000Z"),
      idFactory: (prefix) => `${prefix}:recovered`,
    });

    expect(recovered.map((event) => event.type)).toEqual([
      "run.created",
      "credentials.migrated",
      "run.completed",
    ]);
    expect((await ledger.list(runId)).map((event) => event.type)).toEqual([
      "run.created",
      "credentials.migrated",
      "run.completed",
    ]);
  });
});

async function temporaryRoot(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), "tracegraph-credentials-"));
  roots.push(root);
  return root;
}
