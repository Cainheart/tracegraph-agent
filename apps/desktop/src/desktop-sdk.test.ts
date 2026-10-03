import type { RunProjection, WireSessionEvent } from "@tracegraph/contracts";
import { describe, expect, it, vi } from "vitest";
import type { DesktopBridgeApi } from "./bridge-contract.js";
import { createDesktopSdkPort } from "./desktop-sdk.js";
import { CLIENT_PROTOCOL_VERSION, CLIENT_PROTOCOL_CONFORMANCE_FIXTURES } from "@tracegraph/sdk/protocol";

const recovery = {
  interrupted_run_ids: [],
  resumed_session_ids: [],
  incomplete_action_ids: [],
  errors: [],
};

describe("Desktop shared Workbench adapter", () => {
  it("keeps the live project list empty until trusted native registration exists", async () => {
    const bridge = {
      listProjects: vi.fn(async () => []),
      getHostStatus: vi.fn(async () => ({
        state: "ready" as const,
        identity: {
          package_name: "@tracegraph/desktop-host" as const,
          package_version: "0.1.0-alpha.0",
          protocol_version: CLIENT_PROTOCOL_VERSION,
        },
        recovery,
      })),
      listSessions: vi.fn(async () => ({ sessions: [] })),
    } as unknown as DesktopBridgeApi;
    const port = createDesktopSdkPort(bridge);

    await expect(port.listProjects()).resolves.toEqual([]);
    await expect(port.bootstrap()).resolves.toMatchObject({ recovery });
    await expect(port.listSessions?.({ view: "roots", limit: 10 })).resolves.toEqual({ sessions: [] });
    expect(bridge.listSessions).toHaveBeenCalledWith({ view: "roots", limit: 10 });
  });

  it("fails bootstrap when the private Host did not start", async () => {
    const bridge = {
      getHostStatus: vi.fn(async () => ({ state: "offline" as const, message: "version mismatch" })),
    } as unknown as DesktopBridgeApi;
    const port = createDesktopSdkPort(bridge);

    await expect(port.bootstrap()).rejects.toThrow("version mismatch");
  });
  it("keeps transport failure separate from advertised backend capabilities",async()=>{
    const snapshot={profile_id:"profile:synthetic",protocol_version:CLIENT_PROTOCOL_VERSION,capabilities:[{operation:"settings.write",state:"available",scope:"profile",requires_restart:false}]};
    const startHost=vi.fn(async()=>undefined),failure=Object.assign(new Error("Owner connection was lost"),{name:"HostConnectionError",code:"host_offline"});
    const bridge={getCapabilities:vi.fn().mockResolvedValueOnce(snapshot).mockRejectedValueOnce(failure),startHost,getConnectionStatus:vi.fn(async()=>({state:"offline",generation:1,code:"host_offline",message:"Owner connection was lost"}))} as unknown as DesktopBridgeApi;
    const port=createDesktopSdkPort(bridge);expect((await port.getCapabilities!()).capabilities.find(x=>x.operation==="settings.write")?.state).toBe("available");
    await expect(port.getCapabilities!()).rejects.toMatchObject({code:"host_offline"});expect(await port.getConnectionStatus()).toMatchObject({state:"offline",generation:1});expect(startHost).not.toHaveBeenCalled();await port.startHost();expect(startHost).toHaveBeenCalledOnce();
  });

  it("subscribes to the canonical ledger with its independent cursor and closes the stream", async () => {
    const message = CLIENT_PROTOCOL_CONFORMANCE_FIXTURES.find((fixture) => fixture.name === "event.ledger")?.message;
    if (message?.kind !== "event" || message.event.stream !== "ledger") throw new Error("Missing ledger fixture");
    const event = message.event.event;
    const bridge = {
      openStream: vi.fn(async () => "stream:one"),
      readStream: vi.fn().mockResolvedValueOnce({ state: "event", kind: "ledger", value: event }).mockResolvedValueOnce({ state: "end" }),
      closeStream: vi.fn(async () => undefined),
      getRun: vi.fn(),
    } as unknown as DesktopBridgeApi;
    const port = createDesktopSdkPort(bridge);
    const observed: WireSessionEvent[] = [];
    for await (const next of port.streamEvents("run-fixture", { afterSequence: 4, reconnect: false })) observed.push(next);
    expect(observed).toEqual([event]);
    expect(bridge.openStream).toHaveBeenCalledWith({ kind: "ledger", run_id: "run-fixture", after: 4, reconnect: false });
    expect(bridge.closeStream).toHaveBeenCalledWith("stream:one");
    expect(bridge.getRun).not.toHaveBeenCalled();
  });

  it("routes native project, file, and write-only model settings through fixed bridge methods", async () => {
    const project = {
      project_id: "project:desktop:0123456789abcdef01234567",
      label: "source-tree",
      workspace_kind: "managed_local" as const,
      capabilities: { index: true, read: true, search: true, run_command: true, preview_patch: true, commit_patch: true, test: true },
      location: { kind: "linked_directory" as const, display_path: "source-tree", can_reveal: true, access: "read_write" as const },
    };
    const modelConfig = {
      provider: "openai" as const,
      protocol: "openai-chat-completions" as const,
      configured: true,
      base_url: "https://api.openai.com/v1",
      model: "gpt-4.1-mini",
      has_key: false,
    };
    const bridge = {
      listProjects: vi.fn(async () => [project]),
      openLocalProject: vi.fn(async () => project),
      revealProject: vi.fn(async () => undefined),
      removeProject: vi.fn(async () => undefined),
      openProjectFile: vi.fn(async () => undefined),
      getModelConfig: vi.fn(async () => modelConfig),
      configureModel: vi.fn(async () => ({ ...modelConfig, has_key: true, credential: { name: "TRACEGRAPH_OPENAI_KEY", backend: "private_file", writable: true } })),
    } as unknown as DesktopBridgeApi;
    const port = createDesktopSdkPort(bridge);

    await expect(port.listProjects()).resolves.toEqual([project]);
    await expect(port.openLocalProject?.({ access: "read_write" })).resolves.toEqual(project);
    await port.openProjectFile?.(project.project_id);
    await port.revealProject?.(project.project_id);
    await port.removeProject?.(project.project_id);
    await expect(port.getModelConfig?.()).resolves.toEqual(modelConfig);
    await expect(port.configureModel?.({
      provider: "openai",
      protocol: "openai-chat-completions",
      base_url: "https://api.openai.com/v1",
      model: "gpt-4.1-mini",
      api_key: "test-desktop-secret-value",
    })).resolves.toMatchObject({ has_key: true });

    expect(bridge.openLocalProject).toHaveBeenCalledWith({ access: "read_write" });
    expect(bridge.openProjectFile).toHaveBeenCalledWith(project.project_id);
    expect(bridge.configureModel).toHaveBeenCalledWith(expect.objectContaining({ api_key: "test-desktop-secret-value" }));
  });

  it("forwards the Workbench Experience review command id and CAS sequence through a fixed bridge method", async () => {
    const result = { case: { caseId: "experience:one", status: "validated" }, lifecycleSequence: 1, replayed: false };
    const bridge = {
      listExperienceCases: vi.fn(async () => ({ items: [] })),
      reviewExperienceCase: vi.fn(async () => result),
    } as unknown as DesktopBridgeApi;
    const port = createDesktopSdkPort(bridge);

    await expect(port.listExperienceCases?.()).resolves.toEqual({ items: [] });
    await expect(port.reviewExperienceCase?.("experience:one", {
      command_id: "command:desktop-experience-review",
      expected_sequence: 4,
      action: "validate",
    })).resolves.toEqual(result);
    expect(bridge.reviewExperienceCase).toHaveBeenCalledWith("experience:one", {
      command_id: "command:desktop-experience-review",
      expected_sequence: 4,
      action: "validate",
    });
  });

  it("routes live Session, approval, plan, steering, Todo and Artifact operations through fixed methods", async () => {
    const bridge = Object.fromEntries(["startChat", "resumeSession", "renameSession", "deleteSession", "approve", "reject", "stop", "approvePlan", "getTodos", "writeTodo", "submitUserInput", "getArtifact"]
      .map((name) => [name, vi.fn(async () => ({ routed: name }))])) as unknown as DesktopBridgeApi;
    const port = createDesktopSdkPort(bridge);
    await port.startChat?.({ command_id: "command:chat", task: "Hello" });
    await port.resumeSession?.("session:one", { command_id: "command:resume" });
    await port.renameSession?.("session:one", { title: "Updated" });
    await port.deleteSession?.("session:one");
    const approval = { type: "approve" as const, command_id: "command:approve", project_id: "project:one", run_id: "run:one", approval_id: "approval:one", action_id: "action:one" };
    await port.approve("run:one", approval);
    await port.reject("run:one", { ...approval, type: "reject" });
    await port.stop("run:one", { type: "stop", command_id: "command:stop", project_id: "project:one", run_id: "run:one" });
    await port.approvePlan("run:one", { command_id: "command:plan", plan_event_id: "event:plan" });
    await port.getTodos("run:one");
    await port.writeTodo("run:one", { command_id: "command:todo", input: { operation: "create", todo_id: "todo:one", title: "Check tests" } });
    await port.submitUserInput("run:one", { command_id: "command:input", input_id: "input:one", kind: "message", body: "Inspect test evidence" });
    await port.getArtifact("run:one", "artifact:one");
    expect(bridge.resumeSession).toHaveBeenCalledWith({ session_id: "session:one", input: { command_id: "command:resume" } });
    expect(bridge.approve).toHaveBeenCalledWith(approval);
    expect(bridge.submitUserInput).toHaveBeenCalledWith({ run_id: "run:one", input: { command_id: "command:input", input_id: "input:one", kind: "message", body: "Inspect test evidence" } });
    expect(bridge.getArtifact).toHaveBeenCalledWith({ run_id: "run:one", artifact_id: "artifact:one" });
    expect(() => port.approve("run:other", approval)).toThrow("identity");
    expect(bridge.approve).toHaveBeenCalledTimes(1);
  });
});
