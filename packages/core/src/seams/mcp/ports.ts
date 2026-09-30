import type {
  McpManagerEvent,
  McpToolCatalogEntry,
  RawToolResult,
} from "@tracegraph/contracts";

export interface McpRuntimeSubscription {
  dispose(): void | Promise<void>;
}

/** Host-selected MCP provider port; Core does not depend on its implementation package. */
export interface McpRuntimePort {
  readonly toolTimeoutMs: number;
  onEvent(listener: (event: McpManagerEvent) => void | Promise<void>): McpRuntimeSubscription;
  history(): readonly McpManagerEvent[];
  listTools(): readonly McpToolCatalogEntry[];
  callTool(
    entry: McpToolCatalogEntry,
    argumentsValue: Record<string, unknown>,
    signal?: AbortSignal,
    eventSink?: (event: McpManagerEvent) => void | Promise<void>,
  ): Promise<RawToolResult>;
}
