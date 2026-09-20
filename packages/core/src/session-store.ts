import { createHash, randomUUID } from "node:crypto";
import { constants as fsConstants, type Stats } from "node:fs";
import {
  chmod,
  lstat,
  mkdir,
  open,
  readdir,
  rename,
  rm,
} from "node:fs/promises";
import { hostname as systemHostname } from "node:os";
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from "node:path";
import {
  SESSION_FORMAT_VERSION,
  SessionEventReferenceSchema,
  SessionHeaderSchema,
  SessionListQuerySchema,
  SessionListResponseSchema,
  SessionReadResultSchema,
  SessionRecordSchema,
  SessionSummarySchema,
  SessionTitleSchema,
  type SessionEventReference,
  type SessionHeader,
  type SessionListQuery,
  type SessionListResponse,
  type SessionReadResult,
  type SessionRecord,
  type SessionSummary,
} from "@tracegraph/contracts";
import { z } from "zod";
import { redactSensitiveText } from "./crypto.js";

const MAX_SESSION_FILE_BYTES = 16 * 1024 * 1024;
const MAX_LEASE_FILE_BYTES = 16 * 1024;
const DEFAULT_STALE_LEASE_TIMEOUT_MS = 30_000;
const utf8Decoder = new TextDecoder("utf-8", { fatal: true });

const LegacySessionHeaderV0Schema = z.object({
  kind: z.literal("header"),
  session_version: z.literal(0),
  id: z.string().trim().min(1).max(160),
  projectId: z.string().trim().min(1).max(160),
  createdAt: z.iso.datetime({ offset: true }),
  title: z.string().trim().min(1).max(200).optional(),
  parentSessionId: z.string().trim().min(1).max(160).optional(),
  runIds: z.array(z.string().trim().min(1).max(160)).max(10_000).optional(),
}).strict();

const LegacySessionEventReferenceV0Schema = z.object({
  kind: z.literal("event"),
  session_version: z.literal(0),
  id: z.string().trim().min(1).max(160),
  parentId: z.string().trim().min(1).max(160).optional(),
  createdAt: z.iso.datetime({ offset: true }),
  eventId: z.string().trim().min(1).max(160),
  runId: z.string().trim().min(1).max(160),
  sequence: z.number().int().positive(),
}).strict();

const SessionLeaseFileSchema = z.object({
  version: z.literal(1),
  session_id: z.string().trim().min(1).max(160),
  owner_token: z.uuid(),
  pid: z.number().int().positive(),
  hostname: z.string().trim().min(1).max(255),
  acquired_at: z.iso.datetime({ offset: true }),
  heartbeat_at: z.iso.datetime({ offset: true }),
}).strict();
type SessionLeaseFile = z.infer<typeof SessionLeaseFileSchema>;

export interface SessionLease {
  readonly sessionId: string;
  readonly pid: number;
  readonly hostname: string;
  heartbeat(): Promise<void>;
  release(): Promise<void>;
}

export interface SessionStore {
  initialize(): Promise<void>;
  create(header: SessionHeader): Promise<SessionHeader>;
  append(sessionId: string, entry: SessionEventReference, lease: SessionLease): Promise<void>;
  /** A supplied lease authorizes physical repair of an incomplete final line. */
  readAll(sessionId: string, lease?: SessionLease): Promise<SessionReadResult>;
  list(query?: Partial<SessionListQuery>, allowedProjectIds?: ReadonlySet<string>): Promise<SessionListResponse>;
  rename(sessionId: string, title: string, lease?: SessionLease): Promise<SessionSummary>;
  delete(sessionId: string, lease?: SessionLease): Promise<void>;
  acquireLease(sessionId: string): Promise<SessionLease>;
}

interface LocatedSession {
  readonly path: string;
  readonly result: SessionReadResult;
  readonly info: Stats;
  readonly truncateAt?: number;
}

interface LeaseRegistration {
  readonly sessionId: string;
  readonly lockPath: string;
  readonly ownerToken: string;
  timer?: ReturnType<typeof setInterval>;
  released: boolean;
}

/**
 * Upgrade one on-disk JSONL record to the current format. Version dispatch is
 * explicit: an unknown or missing version never falls through to a best-effort
 * parse that could silently discard fields.
 */
export function migrateSessionEntry(input: unknown): SessionRecord {
  if (!isRecord(input) || !("session_version" in input)) {
    throw new SessionCorruptionError("session record is missing session_version");
  }
  const version = input.session_version;
  if (version === SESSION_FORMAT_VERSION) {
    try {
      const current = SessionRecordSchema.parse(input);
      return current.kind === "header" && current.title !== undefined
        ? SessionHeaderSchema.parse({ ...current, title: redactSensitiveText(current.title) })
        : current;
    } catch (error) {
      throw new SessionCorruptionError("session v1 record does not match its schema", { cause: error });
    }
  }
  if (version !== 0) {
    throw new UnsupportedSessionVersionError(version);
  }

  try {
    if (input.kind === "header") {
      const legacy = LegacySessionHeaderV0Schema.parse(input);
      return SessionHeaderSchema.parse({
        kind: "header",
        session_version: SESSION_FORMAT_VERSION,
        session_id: legacy.id,
        project_id: legacy.projectId,
        created_at: legacy.createdAt,
        ...(legacy.title === undefined ? {} : { title: redactSensitiveText(legacy.title) }),
        ...(legacy.parentSessionId === undefined ? {} : { parent_session_id: legacy.parentSessionId }),
        run_ids: legacy.runIds ?? [],
      });
    }
    if (input.kind === "event") {
      const legacy = LegacySessionEventReferenceV0Schema.parse(input);
      return SessionEventReferenceSchema.parse({
        kind: "event_ref",
        session_version: SESSION_FORMAT_VERSION,
        entry_id: legacy.id,
        ...(legacy.parentId === undefined ? {} : { parent_entry_id: legacy.parentId }),
        created_at: legacy.createdAt,
        event_ref: {
          event_id: legacy.eventId,
          run_id: legacy.runId,
          sequence: legacy.sequence,
        },
      });
    }
    throw new SessionCorruptionError("session v0 record has an unknown kind");
  } catch (error) {
    if (error instanceof SessionStoreError) throw error;
    throw new SessionCorruptionError("session v0 record cannot be migrated", { cause: error });
  }
}

export class JsonlSessionStore implements SessionStore {
  readonly #root: string;
  readonly #trashRoot: string;
  readonly #now: () => Date;
  readonly #pid: number;
  readonly #hostname: string;
  readonly #staleLeaseTimeoutMs: number;
  readonly #heartbeatIntervalMs: number;
  readonly #leaseRegistrations = new WeakMap<SessionLease, LeaseRegistration>();
  #queue: Promise<void> = Promise.resolve();

  constructor(root: string, options: {
    trashRoot?: string;
    now?: () => Date;
    pid?: number;
    hostname?: string;
    staleLeaseTimeoutMs?: number;
    heartbeatIntervalMs?: number;
  } = {}) {
    if (!isAbsolute(root)) {
      throw new SessionPathSafetyError("session root must be an absolute path");
    }
    const trashRoot = options.trashRoot ?? resolve(dirname(root), "sessions-trash");
    if (!isAbsolute(trashRoot)) {
      throw new SessionPathSafetyError("session trash root must be an absolute path");
    }
    if (pathsOverlap(resolve(root), resolve(trashRoot))) {
      throw new SessionPathSafetyError("session and trash roots must be separate sibling trees");
    }
    const pid = options.pid ?? process.pid;
    const host = options.hostname ?? systemHostname();
    const staleLeaseTimeoutMs = options.staleLeaseTimeoutMs ?? DEFAULT_STALE_LEASE_TIMEOUT_MS;
    const heartbeatIntervalMs = options.heartbeatIntervalMs
      ?? Math.max(10, Math.floor(staleLeaseTimeoutMs / 3));
    if (!Number.isSafeInteger(pid) || pid <= 0) throw new TypeError("session lease pid must be positive");
    if (host.trim().length === 0 || host.length > 255) throw new TypeError("session lease hostname is invalid");
    if (!Number.isSafeInteger(staleLeaseTimeoutMs) || staleLeaseTimeoutMs <= 0) {
      throw new TypeError("stale lease timeout must be a positive integer");
    }
    if (!Number.isSafeInteger(heartbeatIntervalMs) || heartbeatIntervalMs <= 0
      || heartbeatIntervalMs >= staleLeaseTimeoutMs) {
      throw new TypeError("heartbeat interval must be positive and shorter than the stale lease timeout");
    }
    this.#root = resolve(root);
    this.#trashRoot = resolve(trashRoot);
    this.#now = options.now ?? (() => new Date());
    this.#pid = pid;
    this.#hostname = host;
    this.#staleLeaseTimeoutMs = staleLeaseTimeoutMs;
    this.#heartbeatIntervalMs = heartbeatIntervalMs;
  }

  initialize(): Promise<void> {
    return this.#serialize(async () => this.#initialize());
  }

  create(headerInput: SessionHeader): Promise<SessionHeader> {
    const parsed = SessionHeaderSchema.parse(headerInput);
    const header = SessionHeaderSchema.parse({
      ...parsed,
      ...(parsed.title === undefined ? {} : { title: redactSensitiveText(parsed.title) }),
    });
    return this.#serialize(async () => {
      await this.#initialize();
      const existing = await this.#scanSessions();
      if (existing.some((session) => session.result.header.session_id === header.session_id)) {
        throw new SessionAlreadyExistsError(header.session_id);
      }
      const projectDirectory = join(this.#root, projectDirectoryName(header.project_id));
      await ensurePrivateDirectory(projectDirectory, true);
      const path = join(projectDirectory, sessionFileName(header));
      assertDirectChild(projectDirectory, path);
      try {
        await writeExclusiveFileDurably(path, `${JSON.stringify(header)}\n`);
      } catch (error) {
        if (isNodeError(error) && error.code === "EEXIST") {
          throw new SessionAlreadyExistsError(header.session_id);
        }
        throw error;
      }
      return header;
    });
  }

  append(sessionId: string, entryInput: SessionEventReference, lease: SessionLease): Promise<void> {
    const entry = SessionEventReferenceSchema.parse(entryInput);
    return this.#serialize(async () => {
      const registration = await this.#assertLease(sessionId, lease);
      const located = await this.#locateSession(sessionId);
      if (located.path !== leaseSessionPath(registration.lockPath)) {
        throw new SessionLeaseConflictError(sessionId, "lease does not belong to the current session file");
      }
      if (located.truncateAt !== undefined) {
        throw new SessionCorruptionError("session tail must be repaired and audited before appending");
      }
      const existingEntryIds = new Set(located.result.entries.map((item) => item.entry_id));
      if (existingEntryIds.has(entry.entry_id)) {
        throw new SessionCorruptionError(`duplicate session entry_id ${entry.entry_id}`);
      }
      if (entry.parent_entry_id !== undefined && !existingEntryIds.has(entry.parent_entry_id)) {
        throw new SessionCorruptionError(`parent session entry ${entry.parent_entry_id} does not exist`);
      }
      if (located.result.entries.some((item) => item.event_ref.event_id === entry.event_ref.event_id)) {
        throw new SessionCorruptionError(`duplicate event reference ${entry.event_ref.event_id}`);
      }
      const runIds = located.result.header.run_ids.includes(entry.event_ref.run_id)
        ? located.result.header.run_ids
        : [...located.result.header.run_ids, entry.event_ref.run_id];
      const header = SessionHeaderSchema.parse({ ...located.result.header, run_ids: runIds });
      await writeSessionRecordsAtomic(located.path, [header, ...located.result.entries, entry]);
    });
  }

  readAll(sessionId: string, lease?: SessionLease): Promise<SessionReadResult> {
    return this.#serialize(async () => {
      const located = await this.#locateSession(sessionId);
      if (located.truncateAt !== undefined && lease !== undefined) {
        const registration = await this.#assertLease(sessionId, lease);
        if (located.path !== leaseSessionPath(registration.lockPath)) {
          throw new SessionLeaseConflictError(sessionId, "lease does not belong to the current session file");
        }
        await truncateSessionPath(located.path, located.info, located.truncateAt);
      }
      return located.result;
    });
  }

  list(
    queryInput: Partial<SessionListQuery> = {},
    allowedProjectIds?: ReadonlySet<string>,
  ): Promise<SessionListResponse> {
    const query = SessionListQuerySchema.parse(queryInput);
    const allowedProjects = allowedProjectIds === undefined ? undefined : new Set(allowedProjectIds);
    return this.#serialize(async () => {
      await this.#initialize();
      const locatedSessions = await this.#scanSessions();
      const needle = query.q?.toLocaleLowerCase();
      const summaries = locatedSessions
        .filter(({ result }) => query.view === "all" || result.header.parent_session_id === undefined)
        .map(toSummary)
        .filter((summary) => allowedProjects === undefined || allowedProjects.has(summary.project_id))
        .filter((summary) => query.project_id === undefined || summary.project_id === query.project_id)
        .filter((summary) => needle === undefined || sessionSearchText(summary).includes(needle))
        .sort(compareSessionSummaries);
      const start = query.cursor === undefined ? 0 : cursorStartIndex(summaries, query.cursor);
      const sessions = summaries.slice(start, start + query.limit);
      const hasMore = start + sessions.length < summaries.length;
      return SessionListResponseSchema.parse({
        sessions,
        ...(hasMore && sessions.length > 0
          ? { next_cursor: encodeCursor(sessions[sessions.length - 1]!) }
          : {}),
      });
    });
  }

  rename(sessionId: string, titleInput: string, lease?: SessionLease): Promise<SessionSummary> {
    const title = SessionTitleSchema.parse(redactSensitiveText(SessionTitleSchema.parse(titleInput)));
    return this.#serialize(async () => this.#withLease(sessionId, lease, async () => {
      const located = await this.#locateSession(sessionId);
      if (located.truncateAt !== undefined) {
        throw new SessionCorruptionError("session tail must be repaired and audited before renaming");
      }
      const header = SessionHeaderSchema.parse({ ...located.result.header, title });
      await writeSessionRecordsAtomic(located.path, [header, ...located.result.entries]);
      const info = await checkedFileInfo(located.path, MAX_SESSION_FILE_BYTES);
      return SessionSummarySchema.parse({
        ...headerSummary(header, located.result.entries.length, info.mtime),
      });
    }));
  }

  delete(sessionId: string, lease?: SessionLease): Promise<void> {
    return this.#serialize(async () => this.#withLease(sessionId, lease, async () => {
      const located = await this.#locateSession(sessionId);
      const trashProjectDirectory = join(this.#trashRoot, projectDirectoryName(located.result.header.project_id));
      await ensurePrivateDirectory(this.#trashRoot, true);
      await ensurePrivateDirectory(trashProjectDirectory, true);
      const target = join(
        trashProjectDirectory,
        `${basename(located.path, ".jsonl")}.${randomUUID()}.deleted.jsonl`,
      );
      assertDirectChild(trashProjectDirectory, target);
      await rename(located.path, target);
      await chmod(target, 0o600);
      await Promise.all([syncDirectory(dirname(located.path)), syncDirectory(trashProjectDirectory)]);
    }));
  }

  acquireLease(sessionId: string): Promise<SessionLease> {
    return this.#serialize(async () => this.#acquireLease(sessionId));
  }

  async #initialize(): Promise<void> {
    await ensurePrivateDirectory(this.#root, true);
  }

  async #acquireLease(sessionId: string): Promise<SessionLease> {
    const located = await this.#locateSession(sessionId);
    const lockPath = `${located.path}.lock`;
    const ownerToken = randomUUID();
    const acquiredAt = this.#now().toISOString();
    const file = SessionLeaseFileSchema.parse({
      version: 1,
      session_id: sessionId,
      owner_token: ownerToken,
      pid: this.#pid,
      hostname: this.#hostname,
      acquired_at: acquiredAt,
      heartbeat_at: acquiredAt,
    });

    for (let attempt = 0; attempt < 3; attempt += 1) {
      try {
        await writeExclusiveFileDurably(lockPath, `${JSON.stringify(file)}\n`);
        const lease: SessionLease = {
          sessionId,
          pid: this.#pid,
          hostname: this.#hostname,
          heartbeat: async () => this.#serialize(async () => this.#heartbeatLease(lease)),
          release: async () => this.#serialize(async () => this.#releaseLease(lease)),
        };
        const registration: LeaseRegistration = {
          sessionId,
          lockPath,
          ownerToken,
          released: false,
        };
        registration.timer = setInterval(() => {
          void this.#serialize(async () => this.#heartbeatLease(lease)).catch(() => {
            clearLeaseTimer(registration);
          });
        }, this.#heartbeatIntervalMs);
        registration.timer.unref?.();
        this.#leaseRegistrations.set(lease, registration);
        return lease;
      } catch (error) {
        if (!isNodeError(error) || error.code !== "EEXIST") throw error;
        const held = await readLeaseFile(lockPath);
        if (held.value.session_id !== sessionId) {
          throw new SessionCorruptionError("session lease identifies a different session");
        }
        const heartbeat = Date.parse(held.value.heartbeat_at);
        const age = this.#now().getTime() - heartbeat;
        const localHolderAlive = held.value.hostname !== this.#hostname || processIsAlive(held.value.pid);
        if (age < this.#staleLeaseTimeoutMs && localHolderAlive) {
          throw new SessionLeaseConflictError(
            sessionId,
            `held by pid ${held.value.pid} on ${held.value.hostname}`,
          );
        }
        await removeStaleLease(lockPath, held);
      }
    }
    throw new SessionLeaseConflictError(sessionId, "stale lease takeover did not converge");
  }

  async #heartbeatLease(lease: SessionLease): Promise<void> {
    const registration = await this.#assertLease(lease.sessionId, lease);
    const held = await readLeaseFile(registration.lockPath, true);
    try {
      if (held.value.owner_token !== registration.ownerToken) {
        registration.released = true;
        clearLeaseTimer(registration);
        throw new SessionLeaseConflictError(lease.sessionId, "lease ownership changed");
      }
      const next = SessionLeaseFileSchema.parse({
        ...held.value,
        heartbeat_at: this.#now().toISOString(),
      });
      await replaceOpenFileContents(held.handle!, `${JSON.stringify(next)}\n`);
    } finally {
      await held.handle!.close();
    }
  }

  async #releaseLease(lease: SessionLease): Promise<void> {
    const registration = this.#leaseRegistrations.get(lease);
    if (registration === undefined || registration.released) return;
    let held: Awaited<ReturnType<typeof readLeaseFile>>;
    try {
      held = await readLeaseFile(registration.lockPath);
    } catch (error) {
      if (error instanceof SessionNotFoundError) {
        registration.released = true;
        clearLeaseTimer(registration);
        return;
      }
      throw error;
    }
    if (held.value.owner_token !== registration.ownerToken) {
      registration.released = true;
      clearLeaseTimer(registration);
      throw new SessionLeaseConflictError(registration.sessionId, "lease ownership changed before release");
    }
    const current = await lstat(registration.lockPath);
    if (current.dev !== held.info.dev || current.ino !== held.info.ino) {
      registration.released = true;
      clearLeaseTimer(registration);
      throw new SessionLeaseConflictError(registration.sessionId, "lease file changed before release");
    }
    await rm(registration.lockPath);
    await syncDirectory(dirname(registration.lockPath));
    registration.released = true;
    clearLeaseTimer(registration);
  }

  async #assertLease(sessionId: string, lease: SessionLease): Promise<LeaseRegistration> {
    const registration = this.#leaseRegistrations.get(lease);
    if (registration === undefined || registration.released || registration.sessionId !== sessionId) {
      throw new SessionLeaseConflictError(sessionId, "a live lease from this store is required");
    }
    const held = await readLeaseFile(registration.lockPath);
    if (held.value.session_id !== sessionId) {
      registration.released = true;
      clearLeaseTimer(registration);
      throw new SessionCorruptionError("session lease identifies a different session");
    }
    if (held.value.owner_token !== registration.ownerToken) {
      registration.released = true;
      clearLeaseTimer(registration);
      throw new SessionLeaseConflictError(sessionId, "lease ownership changed");
    }
    return registration;
  }

  async #withLease<T>(sessionId: string, supplied: SessionLease | undefined, operation: () => Promise<T>): Promise<T> {
    if (supplied !== undefined) {
      await this.#assertLease(sessionId, supplied);
      return operation();
    }
    const acquired = await this.#acquireLease(sessionId);
    try {
      return await operation();
    } finally {
      await this.#releaseLease(acquired);
    }
  }

  async #locateSession(sessionId: string): Promise<LocatedSession> {
    await this.#initialize();
    const matches = (await this.#scanSessions())
      .filter((session) => session.result.header.session_id === sessionId);
    if (matches.length === 0) throw new SessionNotFoundError(sessionId);
    if (matches.length > 1) throw new SessionCorruptionError(`duplicate session_id ${sessionId}`);
    return matches[0]!;
  }

  async #scanSessions(): Promise<LocatedSession[]> {
    const sessions: LocatedSession[] = [];
    const projectEntries = await readdir(this.#root, { withFileTypes: true });
    for (const projectEntry of projectEntries) {
      const projectPath = join(this.#root, projectEntry.name);
      assertDirectChild(this.#root, projectPath);
      if (projectEntry.isSymbolicLink()) {
        throw new SessionPathSafetyError("session project directory must not be a symbolic link");
      }
      if (!projectEntry.isDirectory()) continue;
      await ensurePrivateDirectory(projectPath, false);
      const fileEntries = await readdir(projectPath, { withFileTypes: true });
      for (const fileEntry of fileEntries) {
        const filePath = join(projectPath, fileEntry.name);
        assertDirectChild(projectPath, filePath);
        if (fileEntry.isSymbolicLink()) {
          throw new SessionPathSafetyError("session directory contains a symbolic link");
        }
        if (!fileEntry.isFile() || !fileEntry.name.endsWith(".jsonl")) continue;
        sessions.push(await readSessionPath(filePath));
      }
    }
    return sessions;
  }

  #serialize<T>(operation: () => Promise<T>): Promise<T> {
    const result = this.#queue.then(operation, operation);
    this.#queue = result.then(() => undefined, () => undefined);
    return result;
  }
}

async function readSessionPath(path: string): Promise<LocatedSession> {
  const infoBefore = await checkedFileInfo(path, MAX_SESSION_FILE_BYTES);
  const handle = await open(path, fsConstants.O_RDONLY | fsConstants.O_NOFOLLOW);
  try {
    const openedInfo = await handle.stat();
    assertPrivateRegularFile(openedInfo, MAX_SESSION_FILE_BYTES, "session file");
    if (openedInfo.dev !== infoBefore.dev || openedInfo.ino !== infoBefore.ino) {
      throw new SessionPathSafetyError("session file changed while opening");
    }
    const bytes = await handle.readFile();
    const parsed = parseSessionBytes(bytes);
    return {
      path,
      result: SessionReadResultSchema.parse({
        header: parsed.header,
        entries: parsed.entries,
        truncated: parsed.truncateAt !== undefined,
      }),
      info: openedInfo,
      ...(parsed.truncateAt === undefined ? {} : { truncateAt: parsed.truncateAt }),
    };
  } finally {
    await handle.close();
  }
}

function parseSessionBytes(bytes: Buffer): {
  header: SessionHeader;
  entries: SessionEventReference[];
  truncateAt?: number;
} {
  if (bytes.length === 0) throw new SessionCorruptionError("session file is empty");
  const records: SessionRecord[] = [];
  let start = 0;
  let truncateAt: number | undefined;
  for (;;) {
    const newline = bytes.indexOf(0x0a, start);
    const isFinalWithoutNewline = newline === -1;
    const end = isFinalWithoutNewline ? bytes.length : newline;
    if (end === start) {
      if (isFinalWithoutNewline) break;
      throw new SessionCorruptionError("session file contains an empty JSONL record");
    }
    const line = decodeUtf8(bytes.subarray(start, end));
    try {
      const json: unknown = JSON.parse(line);
      records.push(migrateSessionEntry(json));
    } catch (error) {
      if (isFinalWithoutNewline && isIncompleteJsonLine(line, error)) {
        truncateAt = start;
        break;
      }
      if (error instanceof SessionStoreError) throw error;
      throw new SessionCorruptionError("session file contains invalid JSON", { cause: error });
    }
    if (isFinalWithoutNewline) break;
    start = newline + 1;
    if (start === bytes.length) break;
  }
  const [first, ...rest] = records;
  if (first?.kind !== "header") {
    throw new SessionCorruptionError("session file must begin with exactly one header");
  }
  const entries: SessionEventReference[] = [];
  const entryIds = new Set<string>();
  const eventIds = new Set<string>();
  for (const record of rest) {
    if (record.kind !== "event_ref") {
      throw new SessionCorruptionError("session file contains more than one header");
    }
    if (entryIds.has(record.entry_id)) {
      throw new SessionCorruptionError(`duplicate session entry_id ${record.entry_id}`);
    }
    if (record.parent_entry_id !== undefined && !entryIds.has(record.parent_entry_id)) {
      throw new SessionCorruptionError(`parent session entry ${record.parent_entry_id} does not precede its child`);
    }
    if (eventIds.has(record.event_ref.event_id)) {
      throw new SessionCorruptionError(`duplicate event reference ${record.event_ref.event_id}`);
    }
    entryIds.add(record.entry_id);
    eventIds.add(record.event_ref.event_id);
    entries.push(record);
  }
  return {
    header: first,
    entries,
    ...(truncateAt === undefined ? {} : { truncateAt }),
  };
}

function isIncompleteJsonLine(line: string, error: unknown): boolean {
  if (!(error instanceof SyntaxError)) return false;
  const message = error.message.toLocaleLowerCase();
  const positionMatch = /position\s+(\d+)/u.exec(message);
  const failedAtEnd = positionMatch !== null && Number(positionMatch[1]) >= line.length;
  if (!message.includes("end") && !message.includes("unterminated") && !failedAtEnd) return false;
  let inString = false;
  let escaped = false;
  const stack: string[] = [];
  for (let index = 0; index < line.length; index += 1) {
    const character = line[index]!;
    if (inString) {
      if (escaped) escaped = false;
      else if (character === "\\") escaped = true;
      else if (character === '"') inString = false;
      continue;
    }
    if (character === '"') inString = true;
    else if (character === "{" || character === "[") stack.push(character);
    else if (character === "}" || character === "]") {
      const expected = character === "}" ? "{" : "[";
      if (stack.pop() !== expected) return false;
    }
  }
  return inString || escaped || stack.length > 0;
}

async function writeSessionRecordsAtomic(path: string, records: readonly SessionRecord[]): Promise<void> {
  if (records[0]?.kind !== "header") throw new SessionCorruptionError("session rewrite requires a header");
  const parent = dirname(path);
  await ensurePrivateDirectory(parent, false);
  await checkedFileInfo(path, MAX_SESSION_FILE_BYTES);
  const temporaryPath = join(parent, `.${basename(path)}.${randomUUID()}.tmp`);
  assertDirectChild(parent, temporaryPath);
  const content = `${records.map((record) => JSON.stringify(SessionRecordSchema.parse(record))).join("\n")}\n`;
  if (Buffer.byteLength(content) > MAX_SESSION_FILE_BYTES) {
    throw new SessionCorruptionError("session file exceeds the maximum size");
  }
  try {
    await writeExclusiveFileDurably(temporaryPath, content);
    await rename(temporaryPath, path);
    await syncDirectory(parent);
  } catch (error) {
    await rm(temporaryPath, { force: true }).catch(() => undefined);
    throw error;
  }
}

async function writeExclusiveFileDurably(path: string, content: string): Promise<void> {
  const parent = dirname(path);
  await ensurePrivateDirectory(parent, false);
  let created = false;
  let handle: Awaited<ReturnType<typeof open>> | undefined;
  try {
    handle = await open(
      path,
      fsConstants.O_WRONLY
        | fsConstants.O_CREAT
        | fsConstants.O_EXCL
        | fsConstants.O_NOFOLLOW,
      0o600,
    );
    created = true;
    await handle.writeFile(content, { encoding: "utf8" });
    await handle.chmod(0o600);
    await handle.sync();
    await handle.close();
    handle = undefined;
    await syncDirectory(parent);
  } catch (error) {
    await handle?.close().catch(() => undefined);
    if (created) await rm(path, { force: true }).catch(() => undefined);
    throw error;
  }
}

async function truncateSessionPath(
  path: string,
  expected: Stats,
  truncateAt: number,
): Promise<void> {
  const handle = await open(path, fsConstants.O_RDWR | fsConstants.O_NOFOLLOW);
  try {
    const current = await handle.stat();
    assertPrivateRegularFile(current, MAX_SESSION_FILE_BYTES, "session file");
    if (current.dev !== expected.dev || current.ino !== expected.ino
      || current.size !== expected.size || current.mtimeMs !== expected.mtimeMs) {
      throw new SessionLeaseConflictError(basename(path), "session changed before tail repair");
    }
    await handle.truncate(truncateAt);
    await handle.sync();
  } finally {
    await handle.close();
  }
}

async function syncDirectory(path: string): Promise<void> {
  const handle = await open(path, fsConstants.O_RDONLY | fsConstants.O_NOFOLLOW);
  try {
    await handle.sync();
  } finally {
    await handle.close();
  }
}

async function ensurePrivateDirectory(path: string, create: boolean): Promise<void> {
  let created = false;
  let info: Stats;
  try {
    info = await lstat(path);
  } catch (error) {
    if (isNodeError(error) && error.code === "ENOENT") {
      if (!create) throw new SessionPathSafetyError("session directory does not exist");
      await mkdir(path, { recursive: true, mode: 0o700 });
      created = true;
      info = await lstat(path);
    } else {
      throw error;
    }
  }
  if (!info.isDirectory() || info.isSymbolicLink()) {
    throw new SessionPathSafetyError("session directory must be a real directory, not a symbolic link");
  }
  if (typeof process.getuid === "function" && info.uid !== process.getuid()) {
    throw new SessionPathSafetyError("session directory must be owned by the current user");
  }
  if ((info.mode & 0o077) !== 0) {
    if (!created) throw new SessionPathSafetyError("session directory must use private permissions");
    await chmod(path, 0o700);
  }
}

async function checkedFileInfo(path: string, maximumBytes: number): Promise<Stats> {
  let info: Stats;
  try {
    info = await lstat(path);
  } catch (error) {
    if (isNodeError(error) && error.code === "ENOENT") throw new SessionNotFoundError(basename(path));
    throw error;
  }
  assertPrivateRegularFile(info, maximumBytes, "session file");
  return info;
}

function assertPrivateRegularFile(info: Stats, maximumBytes: number, label: string): void {
  if (!info.isFile() || info.isSymbolicLink()) {
    throw new SessionPathSafetyError(`${label} must be a regular file and not a symbolic link`);
  }
  if (typeof process.getuid === "function" && info.uid !== process.getuid()) {
    throw new SessionPathSafetyError(`${label} must be owned by the current user`);
  }
  if ((info.mode & 0o077) !== 0) {
    throw new SessionPathSafetyError(`${label} must not be accessible by group or others`);
  }
  if (info.size > maximumBytes) throw new SessionCorruptionError(`${label} exceeds the maximum size`);
}

async function readLeaseFile(path: string, keepOpen = false): Promise<{
  value: SessionLeaseFile;
  info: Stats;
  handle?: Awaited<ReturnType<typeof open>>;
}> {
  let info: Stats;
  try {
    info = await lstat(path);
  } catch (error) {
    if (isNodeError(error) && error.code === "ENOENT") throw new SessionNotFoundError(basename(path));
    throw error;
  }
  assertPrivateRegularFile(info, MAX_LEASE_FILE_BYTES, "session lease file");
  const handle = await open(path, (keepOpen ? fsConstants.O_RDWR : fsConstants.O_RDONLY) | fsConstants.O_NOFOLLOW);
  try {
    const opened = await handle.stat();
    assertPrivateRegularFile(opened, MAX_LEASE_FILE_BYTES, "session lease file");
    if (opened.dev !== info.dev || opened.ino !== info.ino) {
      throw new SessionPathSafetyError("session lease file changed while opening");
    }
    const text = decodeUtf8(await handle.readFile());
    let value: SessionLeaseFile;
    try {
      value = SessionLeaseFileSchema.parse(JSON.parse(text));
    } catch (error) {
      throw new SessionCorruptionError("session lease file is invalid", { cause: error });
    }
    if (keepOpen) return { value, info: opened, handle };
    await handle.close();
    return { value, info: opened };
  } catch (error) {
    await handle.close().catch(() => undefined);
    throw error;
  }
}

async function removeStaleLease(
  path: string,
  expected: Awaited<ReturnType<typeof readLeaseFile>>,
): Promise<void> {
  const current = await lstat(path);
  if (current.dev !== expected.info.dev || current.ino !== expected.info.ino) return;
  const stalePath = `${path}.${randomUUID()}.stale`;
  await rename(path, stalePath);
  await syncDirectory(dirname(path));
  try {
    const quarantined = await readLeaseFile(stalePath);
    if (quarantined.value.owner_token !== expected.value.owner_token) {
      throw new SessionLeaseConflictError(expected.value.session_id, "lease changed during stale takeover");
    }
  } finally {
    await rm(stalePath, { force: true });
    await syncDirectory(dirname(path));
  }
}

async function replaceOpenFileContents(
  handle: Awaited<ReturnType<typeof open>>,
  content: string,
): Promise<void> {
  // Other processes read this file while the lease is heartbeating, so the
  // rewrite must not open a window in which the document is incomplete.
  // Truncating first guarantees one: every reader that lands in the event-loop
  // turn between truncate and write observes an empty file and reports a
  // corrupt lease, which is why a concurrent acquireLease could surface
  // session_corruption instead of session_lease_conflict. Overwrite from
  // offset 0 instead and only then drop bytes a shorter document left behind.
  const bytes = Buffer.from(content, "utf8");
  await handle.write(bytes, 0, bytes.byteLength, 0);
  await handle.truncate(bytes.byteLength);
  await handle.sync();
}

function clearLeaseTimer(registration: LeaseRegistration): void {
  if (registration.timer !== undefined) {
    clearInterval(registration.timer);
    delete registration.timer;
  }
}

function processIsAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return !(isNodeError(error) && error.code === "ESRCH");
  }
}

function toSummary(located: LocatedSession): SessionSummary {
  return SessionSummarySchema.parse(
    headerSummary(located.result.header, located.result.entries.length, located.info.mtime),
  );
}

function headerSummary(header: SessionHeader, entryCount: number, updatedAt: Date): SessionSummary {
  return {
    session_id: header.session_id,
    project_id: header.project_id,
    created_at: header.created_at,
    updated_at: updatedAt.toISOString(),
    ...(header.title === undefined ? {} : { title: header.title }),
    ...(header.parent_session_id === undefined ? {} : { parent_session_id: header.parent_session_id }),
    run_ids: header.run_ids,
    entry_count: entryCount,
  };
}

function compareSessionSummaries(left: SessionSummary, right: SessionSummary): number {
  const byUpdatedAt = right.updated_at.localeCompare(left.updated_at);
  return byUpdatedAt === 0 ? left.session_id.localeCompare(right.session_id) : byUpdatedAt;
}

function sessionSearchText(summary: SessionSummary): string {
  return [summary.session_id, summary.project_id, summary.title ?? "", ...summary.run_ids]
    .join("\n")
    .toLocaleLowerCase();
}

function encodeCursor(summary: SessionSummary): string {
  return Buffer.from(JSON.stringify([summary.updated_at, summary.session_id]), "utf8").toString("base64url");
}

function cursorStartIndex(summaries: readonly SessionSummary[], cursor: string): number {
  let decoded: unknown;
  try {
    decoded = JSON.parse(Buffer.from(cursor, "base64url").toString("utf8"));
  } catch (error) {
    throw new SessionCursorError("session cursor cannot be decoded", { cause: error });
  }
  const parsed = z.tuple([z.iso.datetime({ offset: true }), z.string().min(1).max(160)]).safeParse(decoded);
  if (!parsed.success) throw new SessionCursorError("session cursor is invalid");
  const index = summaries.findIndex(
    (summary) => summary.updated_at === parsed.data[0] && summary.session_id === parsed.data[1],
  );
  if (index < 0) throw new SessionCursorError("session cursor no longer identifies a result");
  return index + 1;
}

function projectDirectoryName(projectId: string): string {
  return `project-${digest(projectId).slice(0, 32)}`;
}

function sessionFileName(header: SessionHeader): string {
  const timestamp = header.created_at.replace(/[^0-9A-Za-z-]/gu, "-");
  const readableId = header.session_id.replace(/[^0-9A-Za-z_.-]/gu, "_").slice(0, 80);
  return `${timestamp}_${readableId}-${digest(header.session_id).slice(0, 16)}.jsonl`;
}

function digest(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}

function leaseSessionPath(lockPath: string): string {
  if (!lockPath.endsWith(".lock")) throw new SessionPathSafetyError("invalid session lease path");
  return lockPath.slice(0, -".lock".length);
}

function assertDirectChild(parent: string, candidate: string): void {
  if (dirname(resolve(candidate)) !== resolve(parent)) {
    throw new SessionPathSafetyError("session path escapes its managed directory");
  }
}

function pathsOverlap(left: string, right: string): boolean {
  return left === right || isInside(left, right) || isInside(right, left);
}

function isInside(parent: string, candidate: string): boolean {
  const fromParent = relative(parent, candidate);
  return fromParent !== ""
    && fromParent !== ".."
    && !fromParent.startsWith(`..${sep}`)
    && !isAbsolute(fromParent);
}

function decodeUtf8(bytes: Uint8Array): string {
  try {
    return utf8Decoder.decode(bytes);
  } catch (error) {
    throw new SessionCorruptionError("session file is not valid UTF-8", { cause: error });
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isNodeError(error: unknown): error is NodeJS.ErrnoException {
  return error instanceof Error && "code" in error;
}

export class SessionStoreError extends Error {
  constructor(readonly code: string, message: string, options?: ErrorOptions) {
    super(message, options);
    this.name = "SessionStoreError";
  }
}

export class SessionNotFoundError extends SessionStoreError {
  constructor(readonly sessionId: string) {
    super("session_not_found", `Session ${sessionId} was not found`);
    this.name = "SessionNotFoundError";
  }
}

export class SessionAlreadyExistsError extends SessionStoreError {
  constructor(readonly sessionId: string) {
    super("session_already_exists", `Session ${sessionId} already exists`);
    this.name = "SessionAlreadyExistsError";
  }
}

export class SessionLeaseConflictError extends SessionStoreError {
  constructor(readonly sessionId: string, detail = "held by another writer") {
    super("session_lease_conflict", `Session ${sessionId} lease conflict: ${detail}`);
    this.name = "SessionLeaseConflictError";
  }
}

export class SessionCorruptionError extends SessionStoreError {
  constructor(message: string, options?: ErrorOptions) {
    super("session_corrupt", message, options);
    this.name = "SessionCorruptionError";
  }
}

export class UnsupportedSessionVersionError extends SessionStoreError {
  constructor(readonly version: unknown) {
    super("session_version_unsupported", `Unsupported session format version: ${String(version)}`);
    this.name = "UnsupportedSessionVersionError";
  }
}

export class SessionPathSafetyError extends SessionStoreError {
  constructor(message: string) {
    super("session_path_unsafe", message);
    this.name = "SessionPathSafetyError";
  }
}

export class SessionCursorError extends SessionStoreError {
  constructor(message: string, options?: ErrorOptions) {
    super("session_cursor_invalid", message, options);
    this.name = "SessionCursorError";
  }
}
