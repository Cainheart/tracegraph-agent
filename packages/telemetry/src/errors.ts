export type TelemetryErrorCode =
  | "invalid_event"
  | "invalid_config"
  | "queue_full"
  | "export_failed";

/** Public errors deliberately carry no caller data, endpoint, headers, body,
 * response text, or nested cause. This keeps credentials out of logs even
 * when a Host chooses to surface an error message. */
export class TelemetryError extends Error {
  constructor(readonly code: TelemetryErrorCode, message: string) {
    super(message);
    this.name = "TelemetryError";
  }
}
