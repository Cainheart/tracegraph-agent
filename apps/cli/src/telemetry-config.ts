import { resolve } from "node:path";
import {
  createSecretReference,
  resolveSecretReference,
  type CredentialStore,
} from "@tracegraph/core";
import {
  createTelemetrySink,
  loadTelemetryConfig,
  type TelemetryFetch,
  type TelemetrySink,
} from "@tracegraph/telemetry";

export interface CreateConfiguredTelemetryOptions {
  readonly dataDir: string;
  readonly credentialStore: CredentialStore;
  readonly environment?: Readonly<Record<string, string | undefined>>;
  /** Test seam only. Production uses the platform fetch implementation. */
  readonly fetch?: TelemetryFetch;
}

/**
 * Load the Host-owned telemetry configuration and resolve authorization only
 * through the existing G-19 credential boundary. A missing file deliberately
 * produces a noop sink even when OTLP environment variables happen to exist.
 */
export async function createConfiguredTelemetry(
  options: CreateConfiguredTelemetryOptions,
): Promise<TelemetrySink> {
  const config = await loadTelemetryConfig(resolve(options.dataDir, "telemetry.json"));
  return createTelemetrySink(config, {
    ...(options.environment === undefined ? {} : { env: options.environment }),
    ...(options.fetch === undefined ? {} : { fetch: options.fetch }),
    resolveSecret: async (name) => (
      await resolveSecretReference(createSecretReference(name), options.credentialStore)
    ).value,
  });
}
