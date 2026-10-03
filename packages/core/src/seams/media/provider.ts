import {ImageProviderConfigUpdateSchema,SecretReferenceSchema,type GenerateImageInput,type ImageProviderConfigUpdate,type SecretReference} from "@tracegraph/contracts";
import {registerSecretForRedaction} from "../../kernel/crypto.js";
import {strictImageBase64,verifyRasterImage,type VerifiedImage} from "./image-bytes.js";
export class ImageProviderError extends Error {
  constructor(readonly code:string,readonly outcome:"failure"|"unknown",message:string){super(message);this.name="ImageProviderError";}
}
export interface ImageProvider {publicIdentity?():{protocol:string;model:string;image_model?:string}|undefined;forRun?():ImageProvider&{releaseRun():void};generate(input:GenerateImageInput,options?:{signal?:AbortSignal}):Promise<VerifiedImage>}
export type PrivateImageProviderConfig=Omit<ImageProviderConfigUpdate,"api_key">&{credentialRef:SecretReference};
export class ConfigurableImageProvider implements ImageProvider {
  #config:PrivateImageProviderConfig|undefined;
  readonly #leases=new Map<string,number>();
  readonly #retired=new Map<string,()=>Promise<void>>();
  retireCredential(reference:string,cleanup:()=>Promise<void>){if((this.#leases.get(reference)??0)>0)this.#retired.set(reference,cleanup);else void cleanup().catch(()=>undefined);}
  constructor(readonly options:{resolveCredential:(reference:SecretReference)=>Promise<string>;fetch?:typeof fetch;timeoutMs?:number}){}
  configure(input:PrivateImageProviderConfig){const {credentialRef,...publicConfig}=input;this.#config={...ImageProviderConfigUpdateSchema.parse(publicConfig),credentialRef:SecretReferenceSchema.parse(credentialRef)};}
  clear(){this.#config=undefined;}
  publicIdentity(){return identity(this.#config);}
  forRun():ImageProvider&{releaseRun():void}{const config=this.#config;if(!config)return {generate:async()=>{throw new ImageProviderError("image_provider_unconfigured","failure","Configure an image provider for the next Run");},releaseRun(){}};this.#leases.set(config.credentialRef,(this.#leases.get(config.credentialRef)??0)+1);let released=false;return {publicIdentity:()=>identity(config),generate:(input,options={})=>{if(released)return Promise.reject(new ImageProviderError("image_run_binding_closed","failure","The image Run binding is closed"));return this.#generate(config,input,options);},releaseRun:()=>{if(released)return;released=true;const count=(this.#leases.get(config.credentialRef)??1)-1;if(count)this.#leases.set(config.credentialRef,count);else{this.#leases.delete(config.credentialRef);const cleanup=this.#retired.get(config.credentialRef);this.#retired.delete(config.credentialRef);if(cleanup)void cleanup().catch(()=>undefined);}}};}
  publicConfig(){const {credentialRef:_ref,...publicConfig}=this.#config??{protocol:"openai-images" as const,base_url:"https://api.openai.com/v1",model:"gpt-image-1",credentialRef:"${secret:UNCONFIGURED}"};return {...publicConfig,configured:this.#config!==undefined,has_key:this.#config!==undefined};}
  async generate(input:GenerateImageInput,options:{signal?:AbortSignal}={}):Promise<VerifiedImage> {
    const config=this.#config;if(!config)throw new ImageProviderError("image_provider_unconfigured","failure","Configure an image provider first");
    this.#leases.set(config.credentialRef,(this.#leases.get(config.credentialRef)??0)+1);
    try{return await this.#generate(config,input,options);}finally{const count=(this.#leases.get(config.credentialRef)??1)-1;if(count)this.#leases.set(config.credentialRef,count);else{this.#leases.delete(config.credentialRef);const cleanup=this.#retired.get(config.credentialRef);this.#retired.delete(config.credentialRef);if(cleanup)await cleanup().catch(()=>undefined);}}
  }
  async #generate(config:PrivateImageProviderConfig,input:GenerateImageInput,options:{signal?:AbortSignal}):Promise<VerifiedImage>{
    let key:string;try{key=await this.options.resolveCredential(config.credentialRef);}catch{throw new ImageProviderError("image_credential_unavailable","failure","Image credential is unavailable");}
    registerSecretForRedaction(key);
    const protocol=config.protocol;
    const path=protocol==="openai-images"?"images/generations":protocol==="openai-responses"?"responses":"chat/completions";
    const imageOptions={output_format:input.format,size:input.size,quality:input.quality};
    const body=protocol==="openai-images"?{model:config.model,prompt:input.prompt,n:1,...imageOptions}:protocol==="openai-responses"?{model:config.model,input:input.prompt,tools:[{type:"image_generation",...imageOptions,...(config.image_model?{model:config.image_model}:{})}],tool_choice:{type:"image_generation"}}:{model:config.model,messages:[{role:"user",content:input.prompt}],modalities:["image","text"],stream:false};
    const timeout=AbortSignal.timeout(this.options.timeoutMs??180_000),signal=options.signal?AbortSignal.any([timeout,options.signal]):timeout;
    if(signal.aborted)throw new ImageProviderError("image_cancelled","failure","Image request was cancelled before dispatch");
    let response:Response;
    try{response=await (this.options.fetch??fetch)(config.base_url.replace(/\/+$/u,"")+"/"+path,{method:"POST",redirect:"error",headers:{authorization:"Bearer "+key,"content-type":"application/json"},body:JSON.stringify(body),signal});}
    catch{throw new ImageProviderError(signal.aborted?"image_outcome_unknown":"image_transport_unknown","unknown","Image request outcome is unknown; inspect the provider account before retrying");}
    if(!response.ok){await response.body?.cancel();const code=response.status===401||response.status===403?"image_authentication_failed":response.status===429?"image_rate_limited":"image_http_"+response.status;throw new ImageProviderError(code,response.status>=500?"unknown":"failure","Image endpoint rejected the request ("+response.status+")");}
    let payload:unknown;try{const reader=response.body?.getReader();if(!reader)throw new Error();let total=0;const chunks:Uint8Array[]=[];try{for(;;){const part=await reader.read();if(part.done)break;total+=part.value.byteLength;if(total>29*1024*1024){await reader.cancel();throw new Error();}chunks.push(part.value);}}finally{reader.releaseLock();}payload=JSON.parse(Buffer.concat(chunks).toString("utf8"));}catch{throw new ImageProviderError(signal.aborted?"image_outcome_unknown":"image_response_invalid",signal.aborted?"unknown":"failure","Image endpoint did not return a bounded valid response");}
    try{
      const root=record(payload);let base64:unknown,declared:string|undefined;
      if(protocol==="openai-images"){const data=array(root.data);if(data.length!==1)throw new Error();const image=record(data[0]);base64=image.b64_json;declared=typeof image.media_type==="string"?image.media_type:undefined;}
      else if(protocol==="openai-responses"){if(root.status!=="completed")throw new Error();const images=array(root.output).filter(item=>record(item).type==="image_generation_call");if(images.length!==1)throw new Error();const image=record(images[0]);if(image.status!=="completed")throw new Error();base64=image.result;}
      else{const choices=array(root.choices);if(choices.length!==1)throw new Error();const message=record(record(choices[0]).message);const images=array(message.images);if(images.length!==1)throw new Error();const image=record(images[0]);const url=record(image.image_url).url;if(typeof url!=="string")throw new Error();const match=/^data:(image\/(?:png|jpeg|webp));base64,([A-Za-z0-9+/=]+)$/u.exec(url);if(!match)throw new Error();declared=match[1];base64=match[2];if(declared!=="image/png")throw new ImageProviderError("image_format_unsupported","failure","This release validates PNG output only; configure the provider to return PNG");}
      const decoded=strictImageBase64(base64);if(Buffer.from(decoded).subarray(0,8).toString("hex")!=="89504e470d0a1a0a"&&((decoded[0]===0xff&&decoded[1]===0xd8)||Buffer.from(decoded).subarray(0,4).toString("ascii")==="RIFF"))throw new ImageProviderError("image_format_unsupported","failure","This release validates PNG output only; configure the provider to return PNG");const verified=verifyRasterImage(decoded,declared);if(verified.mimeType!=="image/png")throw new ImageProviderError("image_format_unsupported","failure","This release validates PNG output only; configure the provider to return PNG");return verified;
    }catch(error){if(error instanceof ImageProviderError)throw error;throw new ImageProviderError("image_output_invalid","failure","No verified image bytes were returned; text, code and remote URLs are not image success");}
  }
}
function record(input:unknown):Record<string,unknown>{if(!input||typeof input!=="object"||Array.isArray(input))throw new Error();return input as Record<string,unknown>;}
function array(input:unknown):unknown[]{if(!Array.isArray(input))throw new Error();return input;}

function identity(config:PrivateImageProviderConfig|undefined){return config?{protocol:config.protocol,model:config.model,...(config.image_model?{image_model:config.image_model}:{})}:undefined;}
