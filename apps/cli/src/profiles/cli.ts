/** Current CLI-only entry profile. This is not the proposed cross-app Profile format. */
export const CLI_PROFILE_DEFINITION = Object.freeze({
  profile_id: "tracegraph.cli",
  revision: 1,
  surface: "cli",
  components: Object.freeze({
    runtime: "@tracegraph/core:createAgentRuntime",
    host: "@tracegraph/host:createTraceGraphHost",
    session_store: "@tracegraph/session:JsonlSessionStore",
    code_graph: "@tracegraph/codegraph:analyzeCodeGraph",
  }),
} as const);
