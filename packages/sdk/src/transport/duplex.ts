/** A byte duplex over private stdio/pipe adapters; no Node process is owned here. */
export interface FramedRpcDuplex {
  readonly readable: ReadableStream<Uint8Array>;
  readonly writable: WritableStream<Uint8Array>;
}
