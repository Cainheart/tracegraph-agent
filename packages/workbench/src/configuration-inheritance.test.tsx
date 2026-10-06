// @vitest-environment jsdom
import {act} from "react";
import {createRoot} from "react-dom/client";
import {afterEach,expect,it,vi} from "vitest";
import {HostCapabilitiesSchema,SessionRunOptionsSchema,type ProjectRunDefaultsSnapshot} from "@tracegraph/contracts";
import {DemoTraceGraphClient,type WorkbenchClient} from "./client";
import {useConversationOptions} from "./conversation-options";

afterEach(()=>vi.restoreAllMocks());
it("displays live inherited defaults but submits only explicit choices across refresh",async()=>{
 Object.assign(globalThis,{IS_REACT_ACT_ENVIRONMENT:true});
 const node=document.createElement("div");document.body.append(node);const root=createRoot(node);
 const client:WorkbenchClient=new DemoTraceGraphClient();
 let project:ProjectRunDefaultsSnapshot={project_id:"project:one",revision:0,overrides:{},options:{mode:"execute",reasoning_effort:"high",permission_preset:"read-only"},fields:[]};
 client.getProjectRunDefaults=vi.fn(async()=>project);
 const capabilities=HostCapabilitiesSchema.parse({profile_id:"profile:one",protocol_version:"test",capabilities:[{operation:"project.defaults.read",scope:"project",state:"available"}]});
 function Harness({refresh}:{refresh:number}){const state=useConversationOptions({client,scope:"new-project:project:one",sessionId:null,online:true,capabilities,refreshKey:refresh});return <><output>{JSON.stringify({options:state.options,overrides:state.overrides,ready:state.ready})}</output><button onClick={()=>void state.update({mode:"plan"})}>Plan</button></>;}
 try{
  await act(async()=>root.render(<Harness refresh={0}/>));let value=JSON.parse(node.querySelector("output")!.textContent!);expect(value).toMatchObject({ready:true,options:{reasoning_effort:"high",permission_preset:"read-only"},overrides:{}});
  await act(async()=>node.querySelector("button")!.click());value=JSON.parse(node.querySelector("output")!.textContent!);expect(value.overrides).toEqual({mode:"plan"});
  project={...project,revision:1,options:SessionRunOptionsSchema.parse({...project.options,reasoning_effort:"low",permission_preset:"workspace-write"})};
  await act(async()=>root.render(<Harness refresh={1}/>));value=JSON.parse(node.querySelector("output")!.textContent!);expect(value.options).toMatchObject({reasoning_effort:"low",permission_preset:"workspace-write",mode:"plan"});expect(value.overrides).toEqual({mode:"plan"});
 }finally{await act(async()=>root.unmount());node.remove();}
});

it("saves one session field without turning other inherited values into explicit overrides",async()=>{
 Object.assign(globalThis,{IS_REACT_ACT_ENVIRONMENT:true});const node=document.createElement("div");document.body.append(node);const root=createRoot(node);
 const client:WorkbenchClient=new DemoTraceGraphClient();
 client.getSessionRunOptions=vi.fn<NonNullable<WorkbenchClient["getSessionRunOptions"]>>(async()=>({session_id:"session:one",revision:4,overrides:{},options:{mode:"execute",reasoning_effort:"high",permission_preset:"read-only"}}));
 client.updateSessionRunOptions=vi.fn(async(_id,input)=>({session_id:"session:one",revision:5,overrides:input.overrides,options:SessionRunOptionsSchema.parse({reasoning_effort:"high",permission_preset:"read-only",...input.overrides})}));
 const capabilities=HostCapabilitiesSchema.parse({profile_id:"profile:one",protocol_version:"test",capabilities:["session.options.read","session.options.write"].map(operation=>({operation,scope:"profile",state:"available"}))});
 function Harness(){const state=useConversationOptions({client,scope:"session:one",sessionId:"session:one",online:true,capabilities,refreshKey:0});return <button onClick={()=>void state.update({mode:"plan"})}>{state.options.mode}</button>;}
 try{await act(async()=>root.render(<Harness/>));await act(async()=>node.querySelector("button")!.click());expect(client.updateSessionRunOptions).toHaveBeenCalledWith("session:one",{command_id:expect.any(String),expected_revision:4,overrides:{mode:"plan"}});expect(node.textContent).toBe("plan");}finally{await act(async()=>root.unmount());node.remove();}
});

it("resets one explicit session field with CAS and displays the fresh inherited receipt without changing other choices",async()=>{
 Object.assign(globalThis,{IS_REACT_ACT_ENVIRONMENT:true});const node=document.createElement("div");document.body.append(node);const root=createRoot(node);
 const client:WorkbenchClient=new DemoTraceGraphClient();
 client.getSessionRunOptions=vi.fn(async()=>({session_id:"session:one",revision:6,overrides:{mode:"plan" as const,reasoning_effort:"high" as const},options:SessionRunOptionsSchema.parse({mode:"plan",reasoning_effort:"high"}),fields:[{path:"mode" as const,source:"session" as const,effective:"new-run" as const}]}));
 client.resetSessionRunOptions=vi.fn(async()=>({session_id:"session:one",revision:7,overrides:{reasoning_effort:"high" as const},options:SessionRunOptionsSchema.parse({mode:"execute",reasoning_effort:"high"}),fields:[{path:"mode" as const,source:"project" as const,effective:"new-run" as const}]}));
 const capabilities=HostCapabilitiesSchema.parse({profile_id:"profile:one",protocol_version:"test",capabilities:["session.options.read","session.options.reset"].map(operation=>({operation,scope:"profile",state:"available"}))});
 function Harness(){const state=useConversationOptions({client,scope:"session:one",sessionId:"session:one",online:true,capabilities,refreshKey:0});return <><button onClick={()=>void state.reset("mode")}>Reset mode</button><output>{JSON.stringify({options:state.options,overrides:state.explicitOverrides,fields:state.fields})}</output></>;}
 try{await act(async()=>root.render(<Harness/>));await act(async()=>node.querySelector("button")!.click());expect(client.resetSessionRunOptions).toHaveBeenCalledExactlyOnceWith("session:one",{command_id:expect.any(String),expected_revision:6,fields:["mode"]});expect(JSON.parse(node.querySelector("output")!.textContent!)).toMatchObject({options:{mode:"execute",reasoning_effort:"high"},overrides:{reasoning_effort:"high"},fields:[{path:"mode",source:"project"}]});}finally{await act(async()=>root.unmount());node.remove();}
});
