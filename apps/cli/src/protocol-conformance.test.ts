import { describe, expect, it } from "vitest";
import {
  CLIENT_PROTOCOL_CONFORMANCE_FIXTURES,
  ClientProtocolMessageSchema,
} from "@tracegraph/sdk/protocol";

describe("CLI shared internal protocol fixtures", () => {
  it("accepts the canonical fixture set exported by the private SDK protocol", () => {
    expect(CLIENT_PROTOCOL_CONFORMANCE_FIXTURES.map(({ name, message }) => ({
      name,
      valid: ClientProtocolMessageSchema.safeParse(message).success,
    }))).toEqual(CLIENT_PROTOCOL_CONFORMANCE_FIXTURES.map(({ name }) => ({ name, valid: true })));
  });
});
