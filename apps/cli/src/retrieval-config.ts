import { resolve } from "node:path";

import type { MemoryRetriever } from "@tracegraph/core";
import { createLocalRetrieval } from "@tracegraph/retrieval";
import {
  createRetrievalServiceClient,
  isRetrievalServiceUnavailable,
} from "@tracegraph/retrieval-service";

const DEFAULT_RETRIEVAL_TIMEOUT_MS = 10_000;
const MAX_RETRIEVAL_TIMEOUT_MS = 60_000;

export interface ConfiguredRetrieval {
  readonly retriever: MemoryRetriever;
  readonly mode: "local" | "remote_with_local_fallback";
  readonly remoteUrl?: string;
}

export interface ConfigureRetrievalOptions {
  readonly dataDir: string;
  readonly environment?: NodeJS.ProcessEnv;
  readonly fetch?: typeof globalThis.fetch;
}

/**
 * Compose the durable local index with an optional retrieval service. Remote
 * writes are mirrored locally so a later availability failure has useful data.
 * Contract/auth/scope errors never downgrade to a silent local success.
 */
export function createConfiguredRetrieval(
  options: ConfigureRetrievalOptions,
): ConfiguredRetrieval {
  const environment = options.environment ?? process.env;
  const local = createLocalRetrieval({
    dataDir: resolve(options.dataDir, "retrieval-index"),
  });
  const remoteUrl = nonEmpty(environment.TRACEGRAPH_RETRIEVAL_URL);
  if (remoteUrl === undefined) {
    return {
      mode: "local",
      retriever: {
        ingest: (input) => local.ingest(input),
        search: (input, requestOptions) => local.search({
          ...input,
          ...(requestOptions?.signal === undefined ? {} : { signal: requestOptions.signal }),
        }),
      },
    };
  }

  const timeoutMs = parseTimeout(environment.TRACEGRAPH_RETRIEVAL_TIMEOUT_MS);
  const token = nonEmpty(environment.TRACEGRAPH_RETRIEVAL_TOKEN);
  const remote = createRetrievalServiceClient({
    baseUrl: remoteUrl,
    timeoutMs,
    ...(token === undefined ? {} : { token }),
    ...(options.fetch === undefined ? {} : { fetch: options.fetch }),
  });
  const retriever: MemoryRetriever = {
    async ingest(input) {
      try {
        const result = await remote.ingest(input);
        // Write-through is part of the fallback contract. If the local durable
        // mirror fails, expose that failure so the caller does not believe it
        // has a usable fallback after only the remote side effect committed.
        await local.ingest(input);
        return result;
      } catch (error) {
        if (!isRetrievalServiceUnavailable(error)) throw error;
        return local.ingest(input);
      }
    },
    async search(input, requestOptions) {
      try {
        return await remote.search(input, requestOptions);
      } catch (error) {
        if (!isRetrievalServiceUnavailable(error)) throw error;
        return local.search({
          ...input,
          ...(requestOptions?.signal === undefined ? {} : { signal: requestOptions.signal }),
        });
      }
    },
  };
  return { mode: "remote_with_local_fallback", remoteUrl, retriever };
}

function parseTimeout(value: string | undefined): number {
  if (value === undefined || value.trim() === "") return DEFAULT_RETRIEVAL_TIMEOUT_MS;
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed) || parsed < 1 || parsed > MAX_RETRIEVAL_TIMEOUT_MS) {
    throw new TypeError(
      `TRACEGRAPH_RETRIEVAL_TIMEOUT_MS must be an integer between 1 and ${MAX_RETRIEVAL_TIMEOUT_MS}`,
    );
  }
  return parsed;
}

function nonEmpty(value: string | undefined): string | undefined {
  const normalized = value?.trim();
  return normalized === undefined || normalized.length === 0 ? undefined : normalized;
}
