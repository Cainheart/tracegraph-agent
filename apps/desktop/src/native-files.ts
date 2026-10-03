import { access, realpath, stat } from "node:fs/promises";
import { constants } from "node:fs";
import { spawn } from "node:child_process";
import { delimiter, isAbsolute, join, relative, sep } from "node:path";

/** Canonicalizes a native file selection and confines it to the granted project root. */
export async function resolveProjectFileSelection(rootInput: string, fileInput: string): Promise<string> {
  if (!isAbsolute(rootInput) || !isAbsolute(fileInput) || rootInput.includes("\u0000") || fileInput.includes("\u0000")) {
    throw new TypeError("A native absolute path is required");
  }
  const root = await realpath(rootInput);
  if (!(await stat(root)).isDirectory()) throw new TypeError("Registered project root is unavailable");
  const file = await realpath(fileInput);
  const fileInfo = await stat(file);
  if (!fileInfo.isFile()) throw new TypeError("Selected project item is not a regular file");

  const within = relative(root, file);
  if (within === "" || within === ".." || within.startsWith(`..${sep}`) || isAbsolute(within)) {
    throw new TypeError("Selected file is outside the registered project");
  }
  return file;
}

/** The Host-configured editor receives only a native selected, project-confined file argument. */
export async function openInConfiguredEditor(editor: string, file: string, environment: NodeJS.ProcessEnv = process.env): Promise<void> {
  if (!editor || editor.includes("\0")) throw new TypeError("Configured editor is unavailable");
  const candidates = isAbsolute(editor) ? [editor] : /^[A-Za-z0-9_.-]+$/u.test(editor)
    ? (environment.PATH ?? "").split(delimiter).filter(isAbsolute).map((path) => join(path, editor)) : [];
  let executable: string | undefined;
  for (const candidate of candidates) {
    try { const canonical = await realpath(candidate); if (!(await stat(canonical)).isFile()) continue; await access(canonical, constants.X_OK); executable = canonical; break; }
    catch (error) { if (!["ENOENT", "ENOTDIR", "EACCES"].includes((error as NodeJS.ErrnoException).code ?? "")) throw error; }
  }
  if (!executable) throw new TypeError("Configure an editor executable path or command name without arguments");
  const env = Object.fromEntries(["PATH", "HOME", "USERPROFILE", "TMPDIR", "TEMP", "SystemRoot", "LANG", "LC_ALL"].flatMap((key) => environment[key] === undefined ? [] : [[key, environment[key]]]));
  const child = spawn(executable, [file], { detached: true, stdio: "ignore", env, shell: false, windowsHide: false });
  await new Promise<void>((resolve, reject) => { child.once("spawn", resolve); child.once("error", reject); });
  child.unref();
}
