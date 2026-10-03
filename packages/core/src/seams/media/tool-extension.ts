import {EXTENSION_API_VERSION,GenerateImageInputSchema,RenderDiagramInputSchema,RenderChartInputSchema,RawToolResultSchema,MediaOperationSchema,type MediaOperation,type RawToolResult} from "@tracegraph/contracts";
import type {ToolExtension} from "../../kernel/registration.js";
import type {ToolDefinition} from "../../kernel/tool/definition.js";
import type {ModelAdapter} from "../../kernel/types.js";
import {ImageProviderError,type ImageProvider} from "./provider.js";
import {renderChart,renderDiagram} from "./render.js";
import {sha256,stableStringify} from "../../kernel/crypto.js";

export function createMediaToolsExtension(provider:ImageProvider):ToolExtension {
  const imageDefinition=()=>mediaTool("generate_image",GenerateImageInputSchema,"Generate an image through the explicitly configured image provider; only actual verified image bytes are success.","execute",(input,signal)=>provider.generate(GenerateImageInputSchema.parse(input),{...(signal?{signal}:{})}),()=>provider.publicIdentity?.());
  const generated=imageDefinition();
  if(provider.forRun)generated.forRun=()=>{const binding=provider.forRun!();const definition=mediaTool("generate_image",GenerateImageInputSchema,generated.description,"execute",(input,signal)=>binding.generate(GenerateImageInputSchema.parse(input),{...(signal?{signal}:{})}),()=>binding.publicIdentity?.());return{definition,release:()=>binding.releaseRun()};};
  const definitions=[generated,mediaTool("render_diagram",RenderDiagramInputSchema,"Render a constrained diagram as a self-contained SVG Artifact. No scripts or external resources.","none",input=>Promise.resolve(renderDiagram(RenderDiagramInputSchema.parse(input)))),mediaTool("render_chart",RenderChartInputSchema,"Render bounded bar or line chart data as a self-contained SVG Artifact.","none",input=>Promise.resolve(renderChart(RenderChartInputSchema.parse(input))))];
  return {name:"@tracegraph/media-tools",api_version:EXTENSION_API_VERSION,activate(context){for(const definition of definitions)context.registerTool(definition);}};
}
function mediaTool(name:string,inputSchema:ToolDefinition["inputSchema"],description:string,sideEffect:"none"|"execute",generate:(input:unknown,signal?:AbortSignal)=>Promise<import("./image-bytes.js").VerifiedImage>,identity?:()=>{protocol:string;model:string;image_model?:string}|undefined):ToolDefinition {
  return {name,inputSchema,description,outputSchema:RawToolResultSchema,capability:"read",workspaceIndependent:true,requiresApproval:false,timeoutMs:240_000,concurrencySafe:false,sideEffect,maxResultBytes:8192,presentation:{callLabel:name.replaceAll("_"," "),resultLabel:"Verified media output"},async execute(input,context):Promise<RawToolResult>{
    if(!context.publishArtifactBytes)return {status:"failure",code:"media_publication_unavailable",summary:"This Runtime cannot publish media Artifacts"};
    try{const image=await generate(input,context.signal);if(context.signal?.aborted)return {status:"unknown",code:"media_cancelled_after_dispatch",summary:"Media operation was cancelled; no output success is recorded"};const artifact=await context.publishArtifactBytes({mimeType:image.mimeType,bytes:image.bytes});return {status:"success",code:"media_artifact_created",summary:"Verified media Artifact created",facts:{kind:"generated_media",source:name==="generate_image"?"image_provider":"constrained_renderer",...(identity?.()?{provider:identity!()} : {}),artifact_id:artifact.artifact_id,locator:"artifact:"+artifact.artifact_id,mime_type:image.mimeType,bytes:artifact.byte_length,sha256:artifact.content_hash,width:image.width,height:image.height}};}
    catch(error){if(error instanceof ImageProviderError)return {status:error.outcome,code:error.code,summary:error.message};return {status:"failure",code:"media_output_invalid",summary:"Media output could not be verified or published"};}
  },render(_input,output){return output;}};
}

/** A Host-only bounded instruction adapter; normal Runtime policy and receipts still apply. */
export function createMediaInstructionAdapter(value:MediaOperation):ModelAdapter {
  const operation=MediaOperationSchema.parse(value);const {kind,...argumentsValue}=operation;
  const tool=kind==="generate"?"generate_image":kind==="diagram"?"render_diagram":"render_chart";
  return {name:"trusted-media-instruction-v1-"+sha256(stableStringify(operation)).slice(7),async decide(input){return input.turn===1?{decision_id:"decision:media-"+input.runId,kind:"tool_call",public_reason:"Execute the explicitly requested media operation through the registered tool.",evidence_refs:[],risk:kind==="generate"?"medium":"low",tool_call:{action_id:"action:media-"+input.runId,tool_name:tool,arguments:argumentsValue}}:{decision_id:"decision:media-finish-"+input.runId,kind:"finish",public_reason:"Report the recorded media receipt.",evidence_refs:[],risk:"none",final_answer:input.observations.at(-1)?.status==="success"?"The media operation produced a verified Artifact. Open or export that Artifact.":"The media operation has no verified successful output. Inspect its recorded tool receipt before retrying."};}};
}

/** Human-readable task metadata; typed tool arguments remain the operation truth. */
export function createMediaTaskTitle(value:MediaOperation):string {
  const operation=MediaOperationSchema.parse(value);
  const label=operation.kind==="generate"?"Create image: ":operation.kind==="diagram"?"Create diagram: ":"Create chart: ";
  const text=(operation.kind==="generate"?operation.prompt:operation.title).replace(/\s+/gu," ").trim();
  return label+(text.length>120?text.slice(0,117)+"…":text);
}
