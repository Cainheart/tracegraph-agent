import {request as httpRequest, type IncomingMessage} from "node:http";
import {Readable} from "node:stream";

/** Node/Main-only HTTP over the private local channel; callers cannot choose a network host. */
export function createLocalFetch(socketPath:string,token:string) {
  const responses=new Set<IncomingMessage>();
  const fetch:typeof globalThis.fetch=async (input,init={}) => {
    const url=new URL(typeof input === "string" || input instanceof URL ? input : input.url);
    if(url.hostname!=="outlive.local" || url.protocol!=="http:" || url.username!=="" || url.password!=="" || url.port!=="") throw new Error("Private Host transport accepts only its fixed local origin");
    const headers=new Headers(init.headers ?? (input instanceof Request ? input.headers : undefined));
    headers.set("x-outlive-local-token",token);
    const signal=init.signal;
    const body=init.body;
    let bytes:Uint8Array|undefined;
    if(typeof body === "string") bytes=Buffer.from(body);
    else if(body instanceof Uint8Array) bytes=body;
    else if(body instanceof ArrayBuffer) bytes=new Uint8Array(body);
    else if(body instanceof Blob) bytes=new Uint8Array(await body.arrayBuffer());
    else if(body!==null && body!==undefined) throw new TypeError("Unsupported private request body");
    if(bytes) headers.set("content-length",String(bytes.byteLength));
    return new Promise<Response>((resolve,reject)=>{
      const request=httpRequest({socketPath,path:url.pathname+url.search,method:init.method ?? "GET",headers:Object.fromEntries(headers),agent:false},response=>{
        responses.add(response);
        const responseHeaders=new Headers();
        for(const [name,value] of Object.entries(response.headers)) {if(Array.isArray(value)) for(const entry of value) responseHeaders.append(name,entry);else if(value!==undefined) responseHeaders.set(name,value);}
        const status=response.statusCode ?? 500;
        response.once("close",()=>{responses.delete(response);signal?.removeEventListener("abort",abort);});
        resolve(new Response(status===204 || status===304 ? null : Readable.toWeb(response) as ReadableStream<Uint8Array>,{status,headers:responseHeaders}));
      });
      const abort=()=>request.destroy(new DOMException("Local request aborted","AbortError"));
      request.once("error",reject);
      if(signal?.aborted){abort();return;}
      signal?.addEventListener("abort",abort,{once:true});
      request.end(bytes);
    });
  };
  return {fetch,close(){for(const response of responses) response.destroy();responses.clear();}};
}
