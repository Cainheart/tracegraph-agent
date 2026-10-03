import { z } from "zod";

/** Connection availability is separate from backend capability and policy. */
export const HostConnectionStateSchema = z.enum(["starting", "connected", "reconnecting", "recovering", "offline", "stopped", "upgrade-required"]);
export const HostConnectionCodeSchema = z.enum([
  "host_offline", "host_stopped", "host_reconnecting", "host_recovering",
  "host_upgrade_required", "host_profile_invalid", "host_startup_failed",
  "host_read_stale", "host_replay_stale", "host_recovery_exhausted", "host_write_outcome_unknown",
]);
export const HostConnectionSnapshotSchema = z.object({
  state: HostConnectionStateSchema,
  generation: z.number().int().nonnegative(),
  profile_id: z.string().uuid().optional(),
  owner_nonce: z.string().uuid().optional(),
  code: HostConnectionCodeSchema.optional(),
  message: z.string().min(1).max(500).optional(),
}).strict();
export type HostConnectionSnapshot = z.infer<typeof HostConnectionSnapshotSchema>;
export type HostConnectionCode = z.infer<typeof HostConnectionCodeSchema>;
export class HostConnectionError extends Error {
  readonly code: HostConnectionCode;
  constructor(readonly connection: HostConnectionSnapshot, code?: HostConnectionCode) {
    super(connection.message ?? "The local Host connection is unavailable");
    this.name = "HostConnectionError";
    this.code = code ?? connection.code ?? "host_offline";
  }
}
