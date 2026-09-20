import { mkdir, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  removeControlledTemporaryDirectory,
  type CredentialStore,
} from "@tracegraph/core";
import type { TelemetryFetch } from "@tracegraph/telemetry";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createConfiguredTelemetry } from "./telemetry-config.js";

const temporaryRoots: string[] = [];

afterEach(async () => {
  await Promise.all(temporaryRoots.splice(0).map(removeControlledTemporaryDirectory));
});

describe("CLI telemetry composition", () => {
  it("defaults to noop without making a request even when an OTLP endpoint exists", async () => {
    const root = await temporaryRoot();
    const fetch = vi.fn<TelemetryFetch>(async () => new Response(null, { status: 200 }));
    const sink = await createConfiguredTelemetry({
      dataDir: root,
      credentialStore: emptyCredentialStore(),
      environment: { OTEL_EXPORTER_OTLP_ENDPOINT: "https://collector.example.test" },
      fetch,
    });

    sink.emit({
      kind: "log",
      name: "run.lifecycle",
      at: "2026-09-19T00:00:00.000Z",
      run_id: "run:test",
      attributes: { phase: "completed" },
      severity: "info",
    });
    await sink.flush();

    expect(sink.kind).toBe("noop");
    expect(fetch).not.toHaveBeenCalled();
  });

  it("resolves OTLP authorization through the G-19 credential store", async () => {
    const root = await temporaryRoot();
    await writeFile(join(root, "telemetry.json"), JSON.stringify({
      sink: "otlp_http",
      endpoint_env: "TRACEGRAPH_TEST_OTLP_ENDPOINT",
      authorization_ref: "${secret:TRACEGRAPH_OTLP_AUTH}",
    }));
    const fetch = vi.fn<TelemetryFetch>(async () => new Response(null, { status: 200 }));
    const credentialStore = memoryCredentialStore(
      "TRACEGRAPH_OTLP_AUTH",
      "Bearer collector-secret",
    );
    const sink = await createConfiguredTelemetry({
      dataDir: root,
      credentialStore,
      environment: { TRACEGRAPH_TEST_OTLP_ENDPOINT: "https://collector.example.test/otel" },
      fetch,
    });

    sink.emit({
      kind: "metric",
      name: "model.tokens",
      at: "2026-09-19T00:00:00.000Z",
      run_id: "run:test",
      attributes: { direction: "input" },
      value: 12,
      unit: "tokens",
    });
    await sink.flush();

    expect(fetch).toHaveBeenCalledTimes(1);
    const [url, init] = fetch.mock.calls[0]!;
    expect(String(url)).toBe("https://collector.example.test/otel/v1/metrics");
    expect(new Headers(init?.headers).get("authorization")).toBe("Bearer collector-secret");
  });

  it("fails with a generic error when asynchronous G-19 resolution fails", async () => {
    const root = await temporaryRoot();
    await writeFile(join(root, "telemetry.json"), JSON.stringify({
      sink: "otlp_http",
      authorization_ref: "${secret:TRACEGRAPH_OTLP_AUTH}",
    }));
    const privateMarker = "Bearer must-not-leak-from-credential-backend";
    const credentialStore: CredentialStore = {
      async get() {
        await Promise.resolve();
        throw new Error(privateMarker);
      },
      async set() {},
      async delete() {},
      async list() { return []; },
    };

    let failure: unknown;
    try {
      await createConfiguredTelemetry({
        dataDir: root,
        credentialStore,
        environment: { OTEL_EXPORTER_OTLP_ENDPOINT: "https://collector.example.test" },
      });
    } catch (error) {
      failure = error;
    }

    expect(failure).toMatchObject({ code: "invalid_config" });
    expect(String(failure)).not.toContain(privateMarker);
  });
});

async function temporaryRoot(): Promise<string> {
  const root = join(tmpdir(), `tracegraph-cli-telemetry-${crypto.randomUUID()}`);
  await mkdir(root, { recursive: false });
  temporaryRoots.push(root);
  return root;
}

function emptyCredentialStore(): CredentialStore {
  return memoryCredentialStore("UNUSED", null);
}

function memoryCredentialStore(name: string, initialValue: string | null): CredentialStore {
  let value = initialValue;
  return {
    async get(candidate) {
      return candidate === name ? value : null;
    },
    async set(candidate, nextValue) {
      if (candidate === name) value = nextValue;
    },
    async delete(candidate) {
      if (candidate === name) value = null;
    },
    async list() {
      return value === null
        ? []
        : [{ name, backend: "environment", writable: false }];
    },
  };
}
