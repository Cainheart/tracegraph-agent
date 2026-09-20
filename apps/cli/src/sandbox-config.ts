import { SandboxModeSchema, type SandboxMode } from "@tracegraph/contracts";

export const DEFAULT_SANDBOX_MODE: SandboxMode = "workspace-write";

/**
 * Resolves the Host-owned process boundary. Browser run payloads deliberately
 * cannot select this value, so an untrusted UI cannot widen its own access.
 */
export function resolveSandboxMode(
  flagValue: string | undefined,
  environment: NodeJS.ProcessEnv,
): SandboxMode {
  const candidate = flagValue ?? environment.TRACEGRAPH_SANDBOX_MODE ?? DEFAULT_SANDBOX_MODE;
  const parsed = SandboxModeSchema.safeParse(candidate);
  if (!parsed.success) {
    throw new TypeError(
      `Invalid sandbox mode ${JSON.stringify(candidate)}; expected read-only, workspace-write, or danger-full-access`,
    );
  }
  return parsed.data;
}
