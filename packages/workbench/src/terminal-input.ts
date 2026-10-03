/** Preserve keyboard order across asynchronous transports. A closed view never
 * dispatches buffered input, and a rejected write remains visible to its owner. */
export function orderedTerminalInput(send: (text: string) => Promise<void>, available: () => boolean, onError: (error: unknown) => void): (text: string) => void {
  let tail = Promise.resolve();
  return (text) => {
    tail = tail.then(async () => { if (available()) await send(text); }).catch(onError);
  };
}
