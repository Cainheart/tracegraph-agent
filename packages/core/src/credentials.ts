import { randomUUID } from "node:crypto";
import { spawn } from "node:child_process";
import { constants as fsConstants, type Stats } from "node:fs";
import {
  chmod,
  lstat,
  mkdir,
  open,
  rename,
  rm,
  writeFile,
} from "node:fs/promises";
import { dirname } from "node:path";
import {
  CredentialNameSchema,
  SafeCredentialMetadataSchema,
  SecretReferenceSchema,
  type CredentialBackend,
  type CredentialName,
  type ModelProvider,
  type SafeCredentialMetadata,
  type SecretReference,
  type SessionEvent,
} from "@tracegraph/contracts";
import { z } from "zod";
import { defaultIdFactory, registerSecretForRedaction } from "./crypto.js";
import { JsonlEventLedger } from "./event-ledger.js";

export interface CredentialStore {
  get(name: string): Promise<string | null>;
  set(name: string, value: string): Promise<void>;
  delete(name: string): Promise<void>;
  /** Safe metadata only. Implementations must never return credential values. */
  list(): Promise<SafeCredentialMetadata[]>;
}

export class CredentialBackendError extends Error {
  constructor(readonly backend: CredentialBackend, message: string) {
    super(message);
    this.name = "CredentialBackendError";
  }
}

export class CredentialNotFoundError extends Error {
  constructor(readonly credentialName: string) {
    super(`Credential ${credentialName} is not available`);
    this.name = "CredentialNotFoundError";
  }
}

const CredentialFileSchema = z.object({
  version: z.literal(1),
  credentials: z.record(CredentialNameSchema, z.object({
    value: z.string().min(8).max(16_384),
    updated_at: z.iso.datetime({ offset: true }),
  }).strict()),
}).strict();
type CredentialFile = z.infer<typeof CredentialFileSchema>;

const EMPTY_CREDENTIAL_FILE: CredentialFile = { version: 1, credentials: {} };
const MAXIMUM_CREDENTIAL_FILE_BYTES = 1024 * 1024;

/**
 * Strict-permission fallback for platforms where the macOS Keychain is not
 * available. This is selected by composition, never after a selected backend
 * fails to read, so backend errors remain fail-closed.
 */
export class PrivateFileCredentialStore implements CredentialStore {
  readonly #path: string;
  readonly #now: () => Date;
  #queue: Promise<void> = Promise.resolve();

  constructor(path: string, options: { now?: () => Date } = {}) {
    this.#path = path;
    this.#now = options.now ?? (() => new Date());
  }

  get(nameInput: string): Promise<string | null> {
    const name = CredentialNameSchema.parse(nameInput);
    return this.#serialize(async () => {
      const file = await this.#read();
      const value = file.credentials[name]?.value ?? null;
      if (value !== null) {
        credentialValue(value);
        registerSecretForRedaction(value);
      }
      return value;
    });
  }

  set(nameInput: string, valueInput: string): Promise<void> {
    const name = CredentialNameSchema.parse(nameInput);
    const value = credentialValue(valueInput);
    registerSecretForRedaction(value);
    return this.#serialize(async () => {
      const file = await this.#read();
      file.credentials[name] = {
        value,
        updated_at: this.#now().toISOString(),
      };
      await this.#write(file);
    });
  }

  delete(nameInput: string): Promise<void> {
    const name = CredentialNameSchema.parse(nameInput);
    return this.#serialize(async () => {
      const file = await this.#read();
      if (!(name in file.credentials)) return;
      delete file.credentials[name];
      await this.#write(file);
    });
  }

  list(): Promise<SafeCredentialMetadata[]> {
    return this.#serialize(async () => {
      const file = await this.#read();
      return Object.entries(file.credentials).map(([name, entry]) => SafeCredentialMetadataSchema.parse({
        name,
        backend: "private_file",
        writable: true,
        last_updated_at: entry.updated_at,
      }));
    });
  }

  async #read(): Promise<CredentialFile> {
    let text: string;
    try {
      await assertPrivateDirectory(dirname(this.#path), false);
      const info = await lstat(this.#path);
      assertPrivateCredentialFile(info);
      const handle = await open(this.#path, fsConstants.O_RDONLY | fsConstants.O_NOFOLLOW);
      try {
        const openedInfo = await handle.stat();
        assertPrivateCredentialFile(openedInfo);
        if (openedInfo.dev !== info.dev || openedInfo.ino !== info.ino) {
          throw new CredentialBackendError("private_file", "The private credential file changed while opening");
        }
        text = await handle.readFile({ encoding: "utf8" });
      } finally {
        await handle.close();
      }
    } catch (error) {
      if (isNodeError(error) && error.code === "ENOENT") return structuredClone(EMPTY_CREDENTIAL_FILE);
      if (error instanceof CredentialBackendError) throw error;
      throw new CredentialBackendError("private_file", "The private credential file could not be read");
    }
    try {
      return CredentialFileSchema.parse(JSON.parse(text));
    } catch {
      throw new CredentialBackendError("private_file", "The private credential file is invalid");
    }
  }

  async #write(file: CredentialFile): Promise<void> {
    const parent = dirname(this.#path);
    await assertPrivateDirectory(parent, true);
    const temporaryPath = `${this.#path}.${randomUUID()}.tmp`;
    try {
      await writeFile(temporaryPath, `${JSON.stringify(file, null, 2)}\n`, {
        encoding: "utf8",
        flag: "wx",
        mode: 0o600,
      });
      await chmod(temporaryPath, 0o600);
      await rename(temporaryPath, this.#path);
    } catch (error) {
      await rm(temporaryPath, { force: true }).catch(() => undefined);
      throw error;
    }
  }

  #serialize<T>(operation: () => Promise<T>): Promise<T> {
    const result = this.#queue.then(operation, operation);
    this.#queue = result.then(() => undefined, () => undefined);
    return result;
  }
}

function assertPrivateCredentialFile(info: Stats): void {
  if (!info.isFile() || info.isSymbolicLink()) {
    throw new CredentialBackendError(
      "private_file",
      "The private credential path must be a regular file and must not be a symbolic link",
    );
  }
  if ((info.mode & 0o077) !== 0) {
    throw new CredentialBackendError(
      "private_file",
      "The private credential file must not be readable or writable by group or others",
    );
  }
  if (typeof process.getuid === "function" && info.uid !== process.getuid()) {
    throw new CredentialBackendError(
      "private_file",
      "The private credential file must be owned by the current user",
    );
  }
  if (info.size > MAXIMUM_CREDENTIAL_FILE_BYTES) {
    throw new CredentialBackendError("private_file", "The private credential file is too large");
  }
}

async function assertPrivateDirectory(path: string, create: boolean): Promise<void> {
  if (create) await mkdir(path, { recursive: true, mode: 0o700 });
  let info: Stats;
  try {
    info = await lstat(path);
  } catch (error) {
    if (!create && isNodeError(error) && error.code === "ENOENT") return;
    throw error;
  }
  if (!info.isDirectory() || info.isSymbolicLink()) {
    throw new CredentialBackendError("private_file", "The private credential directory must not be a symbolic link");
  }
  if (typeof process.getuid === "function" && info.uid !== process.getuid()) {
    throw new CredentialBackendError("private_file", "The private credential directory must be owned by the current user");
  }
  if ((info.mode & 0o077) !== 0) {
    if (!create) {
      throw new CredentialBackendError("private_file", "The private credential directory must use private permissions");
    }
    await chmod(path, 0o700);
  }
}

export interface SecurityCommand {
  args: readonly string[];
  /** Sent over stdin so a credential never appears in the process argv. */
  input?: string;
}

export type SecurityCommandRunner = (command: SecurityCommand) => Promise<{ stdout: string }>;

/** macOS Keychain backend using the system `security` utility. */
export class MacOsKeychainCredentialStore implements CredentialStore {
  readonly #service: string;
  readonly #run: SecurityCommandRunner;
  readonly #now: () => Date;
  readonly #known = new Map<CredentialName, SafeCredentialMetadata>();

  constructor(options: {
    service?: string;
    run?: SecurityCommandRunner;
    now?: () => Date;
  } = {}) {
    this.#service = options.service ?? "io.tracegraph.agent";
    this.#run = options.run ?? runSecurityCommand;
    this.#now = options.now ?? (() => new Date());
  }

  async get(nameInput: string): Promise<string | null> {
    const name = CredentialNameSchema.parse(nameInput);
    try {
      const { stdout } = await this.#run({
        args: [
          "find-generic-password",
          "-s", this.#service,
          "-a", name,
          "-w",
        ],
      });
      const value = stdout.replace(/[\r\n]+$/u, "");
      if (!value) {
        throw new CredentialBackendError("macos_keychain", "The Keychain returned an empty credential");
      }
      credentialValue(value);
      registerSecretForRedaction(value);
      if (!this.#known.has(name)) {
        this.#known.set(name, { name, backend: "macos_keychain", writable: true });
      }
      return value;
    } catch (error) {
      if (isKeychainItemMissing(error)) return null;
      if (error instanceof CredentialBackendError) throw error;
      // Do not attach the raw command error: an add/update failure can include
      // command arguments, including the secret, in its diagnostic fields.
      throw new CredentialBackendError("macos_keychain", "The macOS Keychain could not read the credential");
    }
  }

  async set(nameInput: string, valueInput: string): Promise<void> {
    const name = CredentialNameSchema.parse(nameInput);
    const value = credentialValue(valueInput);
    registerSecretForRedaction(value);
    try {
      await this.#run({
        // `security` warns that `-w password` is insecure. With `-w` last it
        // prompts; the runner supplies the value over stdin instead of argv.
        args: [
          "add-generic-password",
          "-U",
          "-s", this.#service,
          "-a", name,
          "-w",
        ],
        // The utility asks for the password and a confirmation when `-w` has
        // no argv value.
        input: `${value}\n${value}\n`,
      });
    } catch {
      throw new CredentialBackendError("macos_keychain", "The macOS Keychain could not store the credential");
    }
    this.#known.set(name, {
      name,
      backend: "macos_keychain",
      writable: true,
      last_updated_at: this.#now().toISOString(),
    });
  }

  async delete(nameInput: string): Promise<void> {
    const name = CredentialNameSchema.parse(nameInput);
    try {
      await this.#run({
        args: [
          "delete-generic-password",
          "-s", this.#service,
          "-a", name,
        ],
      });
    } catch (error) {
      if (!isKeychainItemMissing(error)) {
        throw new CredentialBackendError("macos_keychain", "The macOS Keychain could not delete the credential");
      }
    }
    this.#known.delete(name);
  }

  async list(): Promise<SafeCredentialMetadata[]> {
    return [...this.#known.values()].map((metadata) => SafeCredentialMetadataSchema.parse(metadata));
  }
}

/** Read-only final source for explicit `${secret:ENV_NAME}` references. */
export class EnvironmentCredentialStore implements CredentialStore {
  readonly #environment: Readonly<Record<string, string | undefined>>;
  readonly #seen = new Set<CredentialName>();

  constructor(environment: Readonly<Record<string, string | undefined>>) {
    this.#environment = environment;
  }

  async get(nameInput: string): Promise<string | null> {
    const name = CredentialNameSchema.parse(nameInput);
    const value = this.#environment[name]?.trim();
    if (!value) return null;
    credentialValue(value);
    registerSecretForRedaction(value);
    this.#seen.add(name);
    return value;
  }

  async set(_name: string, _value: string): Promise<void> {
    throw new CredentialBackendError("environment", "Environment credentials are read-only");
  }

  async delete(_name: string): Promise<void> {
    throw new CredentialBackendError("environment", "Environment credentials are read-only");
  }

  async list(): Promise<SafeCredentialMetadata[]> {
    return [...this.#seen].map((name) => ({ name, backend: "environment", writable: false }));
  }
}

/**
 * Uses one selected writable backend, then the environment only when the
 * credential is absent. A backend error is propagated and never triggers a
 * plaintext fallback.
 */
export class LayeredCredentialStore implements CredentialStore {
  readonly #persistent: CredentialStore;
  readonly #environment: CredentialStore;

  constructor(persistent: CredentialStore, environment: CredentialStore) {
    this.#persistent = persistent;
    this.#environment = environment;
  }

  async get(name: string): Promise<string | null> {
    const persisted = await this.#persistent.get(name);
    return persisted ?? this.#environment.get(name);
  }

  set(name: string, value: string): Promise<void> {
    return this.#persistent.set(name, value);
  }

  delete(name: string): Promise<void> {
    return this.#persistent.delete(name);
  }

  async list(): Promise<SafeCredentialMetadata[]> {
    const ordered = [...await this.#persistent.list(), ...await this.#environment.list()];
    const unique = new Map<string, SafeCredentialMetadata>();
    for (const item of ordered) {
      if (!unique.has(item.name)) unique.set(item.name, item);
    }
    return [...unique.values()];
  }
}

export function createPlatformCredentialStore(options: {
  fallbackFile: string;
  environment?: Readonly<Record<string, string | undefined>>;
  platform?: NodeJS.Platform;
  keychainRunner?: SecurityCommandRunner;
  now?: () => Date;
}): CredentialStore {
  const environment = new EnvironmentCredentialStore(options.environment ?? process.env);
  const platform = options.platform ?? process.platform;
  const persistent = platform === "darwin"
    ? new MacOsKeychainCredentialStore({
        ...(options.keychainRunner === undefined ? {} : { run: options.keychainRunner }),
        ...(options.now === undefined ? {} : { now: options.now }),
      })
    : new PrivateFileCredentialStore(
        options.fallbackFile,
        options.now === undefined ? {} : { now: options.now },
      );
  return new LayeredCredentialStore(persistent, environment);
}

export function credentialNameForProvider(provider: ModelProvider): CredentialName {
  return CredentialNameSchema.parse(`TRACEGRAPH_${provider.toUpperCase()}_KEY`);
}

export function createSecretReference(nameInput: string): SecretReference {
  const name = CredentialNameSchema.parse(nameInput);
  return SecretReferenceSchema.parse(`\${secret:${name}}`);
}

export function credentialNameFromReference(referenceInput: string): CredentialName {
  const reference = SecretReferenceSchema.parse(referenceInput);
  return CredentialNameSchema.parse(reference.slice("${secret:".length, -1));
}

export async function resolveSecretReference(
  referenceInput: string,
  store: CredentialStore,
): Promise<{ value: string; metadata: SafeCredentialMetadata }> {
  const name = credentialNameFromReference(referenceInput);
  const value = await store.get(name);
  if (value === null) {
    throw new CredentialNotFoundError(name);
  }
  const metadata = (await store.list()).find((item) => item.name === name);
  if (metadata === undefined) {
    throw new Error(`Credential store did not report safe metadata for ${name}`);
  }
  return { value, metadata };
}

/**
 * Persist a migration fact in the canonical event ledger as a small,
 * replayable system maintenance Run. The event carries only safe metadata.
 */
export async function recordCredentialMigration(options: {
  dataDir: string;
  credential: SafeCredentialMetadata;
  secretReference: SecretReference;
  migratedAt: string;
  migrationId?: string;
  now?: () => Date;
  idFactory?: (prefix: string) => string;
}): Promise<SessionEvent[]> {
  const credential = SafeCredentialMetadataSchema.parse(options.credential);
  const secretReference = SecretReferenceSchema.parse(options.secretReference);
  if (credentialNameFromReference(secretReference) !== credential.name) {
    throw new TypeError("Credential migration metadata does not match its secret reference");
  }
  const now = options.now ?? (() => new Date());
  const idFactory = options.idFactory ?? defaultIdFactory;
  const migrationId = options.migrationId === undefined
    ? undefined
    : z.string().uuid().parse(options.migrationId);
  const runId = migrationId === undefined
    ? idFactory("run:credential-migration")
    : `run:credential-migration:${migrationId}`;
  const ledger = new JsonlEventLedger(`${options.dataDir}/events`, { now, idFactory });
  const common = {
    project_id: "system:tracegraph",
    run_id: runId,
    attempt: 0,
    artifact_refs: [],
  };
  const events: SessionEvent[] = [];
  events.push(await ledger.append({
    ...common,
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
  }));
  events.push(await ledger.append({
    ...common,
    type: "credentials.migrated",
    summary: `Credential ${credential.name} migrated to ${credential.backend}`,
    idempotency_key: `${runId}:credentials.migrated`,
    data: {
      credential_name: credential.name,
      backend: credential.backend,
      migrated_at: options.migratedAt,
      source: "legacy_model_config",
    },
  }));
  events.push(await ledger.append({
    ...common,
    type: "run.completed",
    summary: "Credential migration completed",
    idempotency_key: `${runId}:completed`,
    data: { outcome: "Legacy model credential migrated without persisting its value in the ledger" },
  }));
  return events;
}

function credentialValue(value: string): string {
  if (value.length < 8) throw new TypeError("Credential value must contain at least 8 characters");
  if (value.length > 16_384) throw new TypeError("Credential value is too large");
  if (/[\u0000-\u001f\u007f]/u.test(value)) {
    throw new TypeError("Credential value must not contain control characters");
  }
  return value;
}

function runSecurityCommand(command: SecurityCommand): Promise<{ stdout: string }> {
  return new Promise((resolve, reject) => {
    const child = spawn("/usr/bin/security", [...command.args], {
      stdio: ["pipe", "pipe", "pipe"],
    });
    let stdout = "";
    let stderr = "";
    let settled = false;
    const maximum = 64 * 1024;
    const timeout = setTimeout(() => child.kill("SIGKILL"), 15_000);
    const fail = (failure: SecurityCommandFailure): void => {
      if (settled) return;
      settled = true;
      clearTimeout(timeout);
      reject(failure);
    };
    child.stdout.setEncoding("utf8");
    child.stderr.setEncoding("utf8");
    child.stdout.on("data", (chunk: string) => {
      stdout = `${stdout}${chunk}`.slice(0, maximum);
    });
    child.stderr.on("data", (chunk: string) => {
      stderr = `${stderr}${chunk}`.slice(0, maximum);
    });
    child.once("error", () => {
      fail(new SecurityCommandFailure(undefined, "The security utility could not be started"));
    });
    child.once("close", (code) => {
      if (settled) return;
      settled = true;
      clearTimeout(timeout);
      if (code === 0) resolve({ stdout });
      else reject(new SecurityCommandFailure(code ?? undefined, stderr));
    });
    child.stdin.once("error", () => {
      child.kill("SIGKILL");
      fail(new SecurityCommandFailure(undefined, "The security utility closed its input stream"));
    });
    child.stdin.end(command.input ?? "");
  });
}

class SecurityCommandFailure extends Error {
  constructor(readonly exitCode: number | undefined, readonly stderr: string) {
    super("The security utility failed");
    this.name = "SecurityCommandFailure";
  }
}

function isKeychainItemMissing(error: unknown): boolean {
  if (typeof error !== "object" || error === null) return false;
  const record = error as Record<string, unknown>;
  return record.code === 44
    || record.exitCode === 44
    || (typeof record.stderr === "string" && /could not be found/iu.test(record.stderr));
}

function isNodeError(value: unknown): value is NodeJS.ErrnoException {
  return value instanceof Error && "code" in value;
}
