/** Internal compatibility path; implementation is owned by @tracegraph/evidence. */
export {
  computeReplaySnapshotHash,
  replayDiffFromEvents,
  replaySnapshotFromEvents,
  ReplayError,
} from "./runtime-service.js";
export type { ReplayErrorCode } from "@tracegraph/evidence";
