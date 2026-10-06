import { useCallback, useRef, useState } from "react";

/** An async callback keeps the scope that admitted it. A late failure from a
 * previous Run must not become a banner on the newly selected conversation. */
export function useRunMessage(scope: string): readonly [string | null, (message: string | null) => void] {
  const messages = useRef(new Map<string, string | null>());
  const [, render] = useState(0);
  const setMessage = useCallback((message: string | null) => {
    messages.current.set(scope, message);
    // Only retain recent client-local UI errors, never an unbounded second ledger.
    while (messages.current.size > 100) messages.current.delete(messages.current.keys().next().value!);
    render((version) => version + 1);
  }, [scope]);
  return [messages.current.get(scope) ?? null, setMessage];
}
