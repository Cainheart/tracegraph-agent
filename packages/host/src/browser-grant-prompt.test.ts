import { describe, expect, it, vi } from "vitest";

const execute = vi.hoisted(() => vi.fn());
vi.mock("node:child_process", () => {
  const execFile = vi.fn();
  Object.defineProperty(execFile, Symbol.for("nodejs.util.promisify.custom"), { value: execute });
  return { execFile };
});
import { confirmBrowserGrant } from "./browser-grant-prompt.js";

describe("trusted Browser prompt process boundary", () => {
  it.skipIf(!["darwin", "win32"].includes(process.platform))("forwards the lifetime signal to the fixed native prompt without launching a process", async () => {
    execute.mockResolvedValueOnce({ stdout: "Decline", stderr: "" });
    const lifetime = new AbortController();
    expect(await confirmBrowserGrant({ command_id: "prompt-1", project_id: "project", label: "fixture", origins: ["https://example.test"], duration: "once" }, lifetime.signal)).toBe(false);
    expect(execute).toHaveBeenCalledTimes(1);
    expect(execute.mock.calls[0]![0]).toBe(process.platform === "darwin" ? "/usr/bin/osascript" : "powershell.exe");
    expect(execute.mock.calls[0]![2]).toMatchObject({ signal: lifetime.signal, timeout: 30_000, maxBuffer: 4096 });
  });
});
