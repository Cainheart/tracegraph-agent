// Delivery assembly only: stage the browser pinned by the installed Host driver.
import { cp, mkdir, readFile, writeFile, realpath, lstat } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { createRequire } from 'node:module';
import { dirname, join, relative, sep } from 'node:path';
export const PLAYWRIGHT_VERSION = '1.63.0';
export async function stageBrowserRuntime(root, destination, platform = process.platform, arch = process.arch) {
  if (platform !== process.platform || arch !== process.arch) throw new Error('Bundled browser assembly requires the matching native platform and architecture. Build on that runner; cross-built installers are not native acceptance.');
  if (!['darwin', 'win32'].includes(platform)) throw new Error('No released browser runtime for this platform');
  const require = createRequire(join(root, 'packages/host/package.json'));
  const manifest = require('playwright-core/package.json');
  if (manifest.version !== PLAYWRIGHT_VERSION) throw new Error('Host browser driver version does not match the delivery pin');
  const { chromium } = require('playwright-core');
  const expected = chromium.executablePath();
  let executable;
  try { const info = await lstat(expected); if (!info.isFile() || info.isSymbolicLink()) throw new Error('identity'); executable = await realpath(expected); }
  catch { throw new Error(`The pinned build browser is missing. On the native build runner run: pnpm --filter @tracegraph/host exec playwright-core install chromium`); }
  // Chromium's macOS distribution contains the app, frameworks, helper processes
  // and notices. Windows' distribution contains chrome.exe plus its resources.
  const source = platform === 'darwin' ? dirname(dirname(dirname(dirname(executable)))) : dirname(executable);
  const inside = relative(source, executable).split(sep).join('/');
  if (inside.startsWith('../') || !inside || (platform === 'darwin' && !inside.includes('.app/Contents/MacOS/'))) throw new Error('Unexpected pinned Chromium layout');
  const browser = join(destination, 'browser'); await mkdir(browser, { recursive: false });
  await cp(source, join(browser, 'chromium'), { recursive: true, dereference: true });
  const stagedExecutable = `chromium/${inside}`;
  const binary=await readFile(join(browser,stagedExecutable));
  if(platform==='darwin' && (binary.readUInt32LE(0)!==0xfeedfacf || binary.readUInt32LE(4)!==(arch==='arm64'?0x100000c:0x1000007)))throw new Error('Bundled browser executable architecture mismatch');
  if(platform==='win32'){const pe=binary.readUInt32LE(0x3c);if(binary.toString('ascii',0,2)!=='MZ'||pe+6>binary.length||binary.toString('ascii',pe,pe+4)!=='PE\0\0'||binary.readUInt16LE(pe+4)!==(arch==='arm64'?0xaa64:0x8664))throw new Error('Bundled browser executable architecture mismatch; use a supported native browser distribution');}
  const hash = createHash('sha256').update(binary).digest('hex');
  const receipt = { schema_version: 'outlive.browser-runtime.v1', platform, arch, playwright_version: PLAYWRIGHT_VERSION, executable: stagedExecutable, sha256: hash };
  await writeFile(join(browser, 'browser-manifest.json'), JSON.stringify(receipt, null, 2) + '\n');
  return receipt;
}
