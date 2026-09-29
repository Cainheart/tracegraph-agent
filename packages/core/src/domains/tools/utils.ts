export function truncateUtf8(value: string, maxBytes: number): string {
  const bytes = Buffer.from(value, "utf8");
  if (bytes.byteLength <= maxBytes) return value;
  const marker = Buffer.from("\n...[truncated]", "utf8");
  if (maxBytes <= marker.byteLength) return marker.subarray(0, maxBytes).toString("utf8");
  let end = maxBytes - marker.byteLength;
  while (end > 0 && ((bytes[end] ?? 0) & 0xc0) === 0x80) end -= 1;
  return `${bytes.subarray(0, end).toString("utf8")}${marker.toString("utf8")}`;
}

export function jsonBytes(value: unknown): number {
  return Buffer.byteLength(JSON.stringify(value), "utf8");
}

export function isPlainObject(value: unknown): value is Record<string, unknown> {
  if (value === null || typeof value !== "object") return false;
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}
