import {startLocalHost,stopLocalHost,LocalHostOwnedError} from "./local-host.js";
const args=process.argv.slice(2);
function flag(name:string):string|undefined {const index=args.indexOf(name);return index<0?undefined:args[index+1];}
try {
  const root=flag("--profile-root");if(!root)throw new Error("Explicit profile root is required by owner worker");
  const dataRoot=flag("--data-root"),sessionRoot=flag("--session-root"),port=flag("--http-port"),backend=flag("--credential-backend"),webAssetRoot=flag("--web-asset-root"),productBuildId=flag("--product-build-id");
  if(productBuildId!==undefined&&!/^[a-f0-9]{64}$/u.test(productBuildId))throw new Error("Invalid product build identity");
  if(port!==undefined && (!Number.isInteger(Number(port)) || Number(port)<0 || Number(port)>65535))throw new Error("Invalid loopback port");
  if(backend!==undefined && !["platform","private-file"].includes(backend))throw new Error("Unsupported credential backend");
  const owner=await startLocalHost({profileRoot:root,recoveryMode:args.includes("--recover"),...(dataRoot?{dataRoot}:{}),...(sessionRoot?{sessionRoot}:{}),...(port?{httpPort:Number(port)}:{}),...(webAssetRoot?{webAssetRoot}:{}),...(productBuildId?{productBuildId}:{}),...(backend?{credentialBackend:backend as "platform"|"private-file"}:{})});
  // OS termination is not a durable user stop. Only the authenticated stop route records that intent.
  process.once("SIGINT",()=>void owner.close().finally(()=>process.exit(0)));
  process.once("SIGTERM",()=>void owner.close().finally(()=>process.exit(0)));
} catch(error) {
  if(!(error instanceof LocalHostOwnedError))process.stderr.write(`${error instanceof Error?error.message:"Local Host startup failed"}\n`);
  process.exitCode=error instanceof LocalHostOwnedError?0:1;
}
