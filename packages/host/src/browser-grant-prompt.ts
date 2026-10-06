import { execFile } from "node:child_process";
import { promisify } from "node:util";
import type { BrowserGrantRequest } from "@tracegraph/contracts";
import { workbenchError } from "./workbench-journal.js";

/** Native user confirmation; never accepts a renderer/model 'confirmed' flag. */
export async function confirmBrowserGrant(input: BrowserGrantRequest, signal?: AbortSignal): Promise<boolean> {
  const message = `Allow Outlive Agent to observe and operate these websites for “${input.label}”?\n\n${input.origins.join("\n")}\n\n${input.duration === "always" ? "This permission remains on this computer until you revoke it." : "Allow one isolated browser tab."}\nYou can take over or revoke access at any time. Credentials and system permission dialogs remain under your control.`;
  return confirmNativePermission(message,"Outlive Agent — 浏览器授权",signal);
}

/** Trusted fixed native dialog; paths and script bodies are never client input. */
export async function confirmNativePermission(message:string,title:string,signal?:AbortSignal):Promise<boolean> {
  const execute = promisify(execFile);
  try {
    if (process.platform === "darwin") {
      const script = 'on run argv\nset answer to display dialog (item 1 of argv) with title (item 2 of argv) buttons {"Decline", "Allow"} default button "Decline" cancel button "Decline"\nreturn button returned of answer\nend run';
      const result = await execute("/usr/bin/osascript", ["-e", script, message, title], { timeout: 30_000, maxBuffer: 4096, ...(signal?{signal}:{}) });
      return result.stdout.trim() === "Allow";
    }
    if (process.platform === "win32") {
      const script = 'Add-Type -AssemblyName System.Windows.Forms; $r=[System.Windows.Forms.MessageBox]::Show($env:OUTLIVE_BROWSER_PROMPT,($env:OUTLIVE_PERMISSION_TITLE),[System.Windows.Forms.MessageBoxButtons]::YesNo,[System.Windows.Forms.MessageBoxIcon]::Question,[System.Windows.Forms.MessageBoxDefaultButton]::Button2); if($r -eq "Yes"){Write-Output "Allow"}';
      const result = await execute("powershell.exe", ["-NoLogo", "-NoProfile", "-NonInteractive", "-EncodedCommand", Buffer.from(script, "utf16le").toString("base64")], { env: { ...process.env, OUTLIVE_BROWSER_PROMPT: message,OUTLIVE_PERMISSION_TITLE:title }, timeout: 30_000, maxBuffer: 4096, ...(signal?{signal}:{}), windowsHide: true });
      return result.stdout.trim() === "Allow";
    }
  } catch (error) { if (process.platform === "darwin" && /-128/u.test(String((error as { stderr?: string }).stderr))) return false; }
  throw workbenchError("browser_grant_ui_unavailable", "Browser permission could not be confirmed; use the installed application and try again", 503);
}
