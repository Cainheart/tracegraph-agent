export * from "./desktop-host.js";
export * from "./host-process.js";
export * from "./identity.js";
export * from "./lifecycle-protocol.js";
export * from "./model-configuration.js";
export * from "./native-control.js";
export * from "./project-registry.js";

// Desktop is a client of the shared local Runtime owner.
export { connectLocalHost, ensureLocalHost, resolveBundledRuntime, LocalHostConnectionSupervisor, type ConnectedLocalHost } from "@tracegraph/host";
export type { LegacyMigrationOptions, LegacyMigrationPreview, LegacyMigrationSource } from "@tracegraph/host";
