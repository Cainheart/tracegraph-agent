import {createRequire} from 'node:module';
import {chmod,stat} from 'node:fs/promises';
import {dirname,join} from 'node:path';
const require=createRequire(new URL('../packages/host/package.json',import.meta.url));
if(process.platform==='darwin'){
  const root=dirname(require.resolve('node-pty/package.json'));
  for(const folder of [`prebuilds/darwin-${process.arch}`,'build/Release']){
    const helper=join(root,folder,'spawn-helper');
    try{const metadata=await stat(helper);if(metadata.isFile()&&(metadata.mode&0o111)===0){await chmod(helper,0o755);process.stdout.write('Prepared node-pty macOS spawn helper\n');}}catch(error){if(error.code!=='ENOENT')throw error;}
  }
}
