import type { SessionEvent, TeamProjection, TodoList } from "@tracegraph/contracts";

/** Host-owned canonicalization, identity, and redaction implementations. */
export interface EvidencePrimitives {
  readonly defaultIdFactory: (prefix: string) => string;
  readonly redactSensitiveText: (value: string) => string;
  readonly redactStructuredArtifactValue: (value: unknown, depth?: number) => unknown;
  readonly redactStructuredValue: (value: unknown, depth?: number) => unknown;
  readonly sha256: (value: string | Uint8Array) => `sha256:${string}`;
  readonly stableStringify: (value: unknown) => string;
}

/** Pure domain projections contributed by the owning Runtime composition. */
export interface ProjectionContributors {
  readonly projectTeam: (events: readonly SessionEvent[]) => TeamProjection | undefined;
  readonly projectTodos: (events: readonly SessionEvent[]) => TodoList;
}

export type ProjectionPorts = Pick<
  EvidencePrimitives,
  "redactSensitiveText" | "redactStructuredValue"
> & ProjectionContributors;

export type ReplayPorts = ProjectionPorts & Pick<
  EvidencePrimitives,
  "sha256" | "stableStringify"
>;
