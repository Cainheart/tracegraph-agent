import type { SandboxMode } from "@tracegraph/contracts";

export const SEATBELT_EXECUTABLE = "/usr/bin/sandbox-exec";
export const SEATBELT_WORKSPACE_PARAMETER = "TRACEGRAPH_WORKSPACE";

/**
 * Generate a static profile.  No caller-controlled path is interpolated into
 * SBPL; the canonical workspace arrives through sandbox-exec's `-D` argument.
 * This keeps quotes, parentheses, and other legal filename characters from
 * becoming profile syntax.
 */
export function generateSeatbeltProfile(mode: SandboxMode): string {
  if (mode === "danger-full-access") {
    return [
      "(version 1)",
      "(allow default)",
      "",
    ].join("\n");
  }

  const rules = [
    "(version 1)",
    '(import "system.sb")',
    "(deny default)",
    "(deny network*)",
    "(allow process*)",
    "(allow file-read-metadata file-test-existence)",
    "(allow file-read* file-test-existence file-map-executable",
    `  (literal (param "${SEATBELT_WORKSPACE_PARAMETER}"))`,
    `  (subpath (param "${SEATBELT_WORKSPACE_PARAMETER}"))`,
    '  (subpath "/System")',
    '  (subpath "/usr")',
    '  (subpath "/bin")',
    '  (subpath "/sbin")',
    '  (subpath "/Library/Apple")',
    '  (subpath "/opt/homebrew")',
    '  (subpath "/usr/local")',
    '  (subpath "/Applications/Xcode.app"))',
  ];

  if (mode === "read-only") {
    rules.push("(deny file-write*)");
  } else {
    rules.push(
      "(allow file-write*",
      `  (literal (param "${SEATBELT_WORKSPACE_PARAMETER}"))`,
      `  (subpath (param "${SEATBELT_WORKSPACE_PARAMETER}")))`,
    );
  }
  rules.push("");
  return rules.join("\n");
}

export function seatbeltArguments(input: {
  profile: string;
  workspaceRoot: string;
  executable: string;
  args: readonly string[];
}): string[] {
  assertSafeSeatbeltParameter(input.workspaceRoot);
  return [
    "-D",
    `${SEATBELT_WORKSPACE_PARAMETER}=${input.workspaceRoot}`,
    "-p",
    input.profile,
    input.executable,
    ...input.args,
  ];
}

function assertSafeSeatbeltParameter(value: string): void {
  // sandbox-exec receives the value as one argv item, but control characters
  // have varied across private SBPL parser versions. Refuse them rather than
  // risk parser ambiguity. Quotes and parentheses remain safe via `-D`.
  if (/[\0\r\n]/u.test(value)) {
    throw new SeatbeltParameterError("workspace path contains an unsupported control character");
  }
}

export class SeatbeltParameterError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "SeatbeltParameterError";
  }
}
