import { EXTENSION_API_VERSION,ComputerObserveRequestSchema,ComputerActionRequestSchema,RawToolResultSchema } from "@tracegraph/contracts";
import type { TraceGraphExtension,AgentRuntime } from "@tracegraph/core";
import type { ComputerControl } from "./computer-control.js";
/** No model tool can grant, acquire, resume or focus an application. */
export function computerTools(control:ComputerControl,runtime:()=>AgentRuntime):TraceGraphExtension {
 const registrations:Array<{dispose():void|Promise<void>}>=[];
 const observe=ComputerObserveRequestSchema.omit({command_id:true});
 const input=ComputerActionRequestSchema.omit({command_id:true});
 return {name:"@tracegraph/computer-tools",api_version:EXTENSION_API_VERSION,
  activate(context){
   registrations.push(context.registerTool({
    name:"computer_observe",description:"Observe an exact user-authorized application window through native accessibility. A requested capture returns actual window PNG as a Run Artifact. Never changes grants or input control.",
    inputSchema:observe,outputSchema:RawToolResultSchema,capability:"read",sideEffect:"read",requiresApproval:false,concurrencySafe:false,timeoutMs:15_000,maxResultBytes:160*1024,
    presentation:{callLabel:"Observe authorized application",resultLabel:"Application observation"},
    async execute(value,ctx){
     if(!ctx.operationId||!ctx.publishArtifactBytes)throw new Error("Runtime operation and Artifact publication are required");
     const observation=await control.observe({...observe.parse(value),command_id:ctx.operationId});
     const screenshot=observation.capture_artifact?await ctx.publishArtifactBytes({mimeType:"image/png",bytes:await control.captureContent({grant_id:observe.parse(value).grant_id,target:observation.target,artifact:observation.capture_artifact})}):undefined;
     if(screenshot&&observation.capture_artifact)await control.registerRunEvidenceCopy(observation.capture_artifact,screenshot);
     const publicObservation={target:observation.target,source:observation.source,elements:observation.elements.slice(0,60),truncated:observation.truncated||observation.elements.length>60,captured_at:observation.captured_at,...(screenshot?{screenshot}:{})};
     return {status:"success",code:"computer_observed",summary:"Observed the authorized application window",content:JSON.stringify(publicObservation),facts:{target:observation.target,...(screenshot?{screenshot}:{})}};
    },render(_input,output){return output;},
   }));
   registrations.push(context.registerTool({
    name:"computer_input",description:"Post native input only through an active human-confirmed lease. Human input, locking or revocation pauses it. A posted receipt is not proof that the application completed the business action: observe and verify the external result.",
    inputSchema:input,
    modelInputSchema:{type:"object",properties:{lease_id:{type:"string",minLength:1,maxLength:160},expected_generation:{type:"integer",minimum:0},action:{type:"object",properties:{kind:{type:"string",enum:["click","type","key","scroll"]},x:{type:"number"},y:{type:"number"},button:{type:"string",enum:["left","right"]},text:{type:"string",minLength:1,maxLength:4000},key:{type:"string",enum:["Enter","Escape","Tab","Backspace","ArrowUp","ArrowDown","ArrowLeft","ArrowRight","Space"]},modifiers:{type:"array",items:{type:"string",enum:["shift","control","alt","meta"]},maxItems:4},delta_x:{type:"integer",minimum:-2000,maximum:2000},delta_y:{type:"integer",minimum:-2000,maximum:2000}},required:["kind"],additionalProperties:false}},required:["lease_id","expected_generation","action"],additionalProperties:false},
    outputSchema:RawToolResultSchema,capability:"read",sideEffect:"write",requiresApproval:false,concurrencySafe:false,timeoutMs:15_000,maxResultBytes:32*1024,
    presentation:{callLabel:"Operate authorized application",resultLabel:"Native input receipt"},
    async execute(value,ctx){
     if(!ctx.operationId)throw new Error("Runtime operation identity is required");
     const projection=await runtime().getProjection(ctx.runId);
     try{const result=await control.act({...input.parse(value),command_id:ctx.operationId},{mode:projection.mode,...(ctx.signal?{signal:ctx.signal}:{})});return {status:result.status==="unknown"?"unknown":"success",code:result.code,summary:result.message,content:JSON.stringify(result),facts:result};}
     catch(error){return {status:"failure",code:String((error as {code?:string}).code??"computer_input_failed"),summary:error instanceof Error?error.message:"Computer input failed"};}
    },render(_input,output){return output;},
   }));
  },async deactivate(){for(const registration of registrations)await registration.dispose();registrations.length=0;},
 };
}
