import {
  JsonlSessionStore as PackageJsonlSessionStore,
  migrateSessionEntry as migratePackageSessionEntry,
  type JsonlSessionStoreOptions,
} from "@tracegraph/session";
import type { SessionRecord } from "@tracegraph/contracts";
import { redactSensitiveText } from "../../kernel/crypto.js";

export {
  SessionAlreadyExistsError,
  SessionCorruptionError,
  SessionCursorError,
  SessionLeaseConflictError,
  SessionNotFoundError,
  SessionPathSafetyError,
  SessionStoreError,
  UnsupportedSessionVersionError,
} from "@tracegraph/session";
export type { SessionLease, SessionStore } from "@tracegraph/session";

type CoreSessionStoreOptions = Omit<JsonlSessionStoreOptions, "redactSensitiveText">;

/**
 * Preserve the historical Core constructor while delegating all persistence
 * behavior to the Session package and its injected canonical redactor.
 */
export class JsonlSessionStore extends PackageJsonlSessionStore {
  constructor(root: string, options: CoreSessionStoreOptions = {}) {
    super(root, { ...options, redactSensitiveText });
  }
}

/** Keep the Core public helper source-compatible while the package requires its redaction port. */
export function migrateSessionEntry(input: unknown): SessionRecord {
  return migratePackageSessionEntry(input, redactSensitiveText);
}
