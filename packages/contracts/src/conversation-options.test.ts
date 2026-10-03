import {describe,it,expect} from "vitest";
import {ModelConnectionsSnapshotSchema,PermissionGrantUpdateRequestSchema,SessionRunOptionsSchema} from "./conversation-options.js";
import {StartChatRequestSchema,StartRunRequestSchema} from "./commands.js";
describe("safe conversation choices",()=>{
 it("accepts old callers and real plan chat while never accepting paths or policy documents",()=>{
  expect(StartChatRequestSchema.parse({command_id:"a",task:"hello"}).mode).toBeUndefined();
  expect(StartChatRequestSchema.parse({command_id:"a",task:"plan",mode:"plan"}).mode).toBe("plan");
  const options=SessionRunOptionsSchema.parse({connection_id:"saved-a"});expect(options.permission_preset).toBe("workspace-write");
  expect(()=>StartRunRequestSchema.parse({command_id:"b",project_id:"p",task:"hello",mode:"execute",run_options:{...options,permission_policy:{allowed_tools:["run_command"]}}})).toThrow();
  expect(()=>StartChatRequestSchema.parse({command_id:"a",task:"hello",project_id:"external"})).toThrow();
 });
 it("requires explicit confirmed grants and rejects leaked key material from connection responses",()=>{
  expect(()=>PermissionGrantUpdateRequestSchema.parse({command_id:"grant",enabled:true})).toThrow();
  const safe={default_connection_id:"model-a",connections:[{connection_id:"model-a",label:"A",revision:0,provider:"custom",protocol:"openai-chat-completions",base_url:"http://127.0.0.1:1234/v1",model:"a",models:["a"],has_key:false,source:"profile",writable:true}]};
  expect(ModelConnectionsSnapshotSchema.parse(safe)).toEqual(safe);
  expect(()=>ModelConnectionsSnapshotSchema.parse({...safe,connections:[{...safe.connections[0],api_key:"should-never-return"}]})).toThrow();
 });
});
