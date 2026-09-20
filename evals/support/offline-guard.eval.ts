import { describe, expect, it } from "vitest";
import { createRequire } from "node:module";

const require = createRequire(import.meta.url);
const net = require("node:net") as typeof import("node:net");
const tls = require("node:tls") as typeof import("node:tls");

describe("G16 offline execution guard", () => {
  it("removes provider credentials and rejects external fetch, TCP, and TLS", async () => {
    expect(process.env.OPENAI_API_KEY).toBeUndefined();
    await expect(fetch("https://example.invalid/g16-must-not-connect"))
      .rejects.toThrow(/blocked non-loopback/u);
    expect(() => net.connect({ host: "example.invalid", port: 443 }))
      .toThrow(/blocked non-loopback/u);
    expect(() => tls.connect({ host: "example.invalid", port: 443 }))
      .toThrow(/blocked non-loopback/u);
  });
});
