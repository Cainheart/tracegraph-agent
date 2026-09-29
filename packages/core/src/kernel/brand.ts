declare const brandMarker: unique symbol;

/** Add an internal nominal marker without changing the runtime representation. */
export type Brand<Value, Name extends string> = Value & {
  readonly [brandMarker]: Name;
};
