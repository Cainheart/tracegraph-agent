import { describe, expect, it } from "vitest";
import { orderedTerminalInput } from "./terminal-input";

describe("PTY keyboard transport", () => {
  it("does not send the next character until the prior write settles", async () => {
    const writes: string[] = [];
    let settle!: () => void;
    const first = new Promise<void>((resolve) => { settle = resolve; });
    const write = orderedTerminalInput(async (text) => { writes.push(text); if (text === "p") await first; }, () => true, () => {});
    for (const text of ["p", "r", "i", "n", "t", "f", "\r"]) write(text);
    await Promise.resolve(); await Promise.resolve();
    expect(writes).toEqual(["p"]);
    settle();
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(writes).toEqual(["p", "r", "i", "n", "t", "f", "\r"]);
  });

  it("reports a failed write and drops buffered input after the view closes", async () => {
    let open = true;
    let reject!: (error: Error) => void;
    const first = new Promise<void>((_, rejectWrite) => { reject = rejectWrite; });
    const writes: string[] = [], errors: unknown[] = [];
    const write = orderedTerminalInput(async (text) => { writes.push(text); await first; }, () => open, (error) => { errors.push(error); });
    write("first"); write("buffered"); await Promise.resolve();
    open = false; const failure = new Error("terminal_closed"); reject(failure);
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(writes).toEqual(["first"]); expect(errors).toEqual([failure]);
  });
});
