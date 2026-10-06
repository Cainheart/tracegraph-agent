import { lstat, readdir, open, realpath } from "node:fs/promises";
import { constants } from "node:fs";
import { homedir } from "node:os";
import { basename, join, relative, resolve } from "node:path";
import {
  SkillCatalogEntrySchema,
  SkillConflictSchema,
  SkillDiagnosticSchema,
  SkillNameSchema,
  SkillRegistrySnapshotSchema,
  type SkillCatalogEntry,
  type SkillConflict,
  type SkillDiagnostic,
  type SkillRegistrySnapshot,
  type SkillSource,
} from "@tracegraph/contracts";
import { sha256, stableStringify } from "../../kernel/crypto.js";

const MAX_SKILLS = 256;
const MAX_SKILL_FILE_BYTES = 256 * 1024;
const MAX_FRONTMATTER_BYTES = 32 * 1024;

export interface SkillDefinition extends SkillCatalogEntry {
  readonly filePath: string;
  readonly body: string;
  readonly bodyHash: `sha256:${string}`;
}

export interface SkillRegistryOptions {
  /** Defaults to ~/.tracegraph/skills; tests and embedded Hosts may inject it. */
  readonly userSkillsRoot?: string;
  readonly projectSkillsRelativePath?: string;
}

export class SkillRegistry {
  readonly #userSkillsRoot: string;
  readonly #projectSkillsRelativePath: string;

  constructor(options: SkillRegistryOptions = {}) {
    this.#userSkillsRoot = resolve(options.userSkillsRoot ?? join(homedir(), ".tracegraph", "skills"));
    this.#projectSkillsRelativePath = options.projectSkillsRelativePath ?? join(".tracegraph", "skills");
  }

  get userSkillsRoot(): string {
    return this.#userSkillsRoot;
  }

  async scan(projectRoot: string, includeSkill: (skill: SkillDefinition) => boolean = () => true): Promise<SkillRegistrySnapshotInternal> {
    return this.#scanSources(projectRoot, includeSkill);
  }

  async scanGlobal(): Promise<SkillRegistrySnapshotInternal> {
    return this.#scanSources(undefined, () => true);
  }

  async #scanSources(projectRoot: string | undefined, includeSkill: (skill: SkillDefinition) => boolean): Promise<SkillRegistrySnapshotInternal> {
    const projectSkillsRoot = projectRoot === undefined ? undefined : resolve(projectRoot, this.#projectSkillsRelativePath);
    const [userResult, projectResult] = await Promise.all([
      this.#scanScope(this.#userSkillsRoot, "user"),
      projectSkillsRoot === undefined ? Promise.resolve({ skills: [], diagnostics: [] }) : this.#scanScope(projectSkillsRoot, "project"),
    ]);
    const diagnostics = [...userResult.diagnostics, ...projectResult.diagnostics];
    const conflicts: SkillConflict[] = [];
    const selected = new Map<string, SkillDefinition>();

    for (const candidate of [...userResult.skills, ...projectResult.skills]) {
      if (!includeSkill(candidate)) continue;
      const previous = selected.get(candidate.name);
      if (previous === undefined) {
        selected.set(candidate.name, candidate);
        continue;
      }
      const projectWins = candidate.source === "project" && previous.source === "user";
      const winner = projectWins ? candidate : previous;
      const loser = projectWins ? previous : candidate;
      conflicts.push(SkillConflictSchema.parse({
        name: candidate.name,
        winner: winner.source,
        loser: loser.source,
        winner_path: winner.filePath,
        loser_path: loser.filePath,
        reason: winner.source === loser.source
          ? "duplicate skill name in the same scope; deterministic first entry wins"
          : "project skill takes precedence over user skill",
      }));
      if (projectWins) selected.set(candidate.name, candidate);
    }

    const skills = [...selected.values()].sort((left, right) => left.name.localeCompare(right.name));
    const registryDigest = sha256(stableStringify({
      skills: skills.map((skill) => ({
        name: skill.name,
        description: skill.description,
        version: skill.version,
        allowed_tools: skill.allowed_tools,
        source: skill.source,
        path: skill.filePath,
        body_hash: skill.bodyHash,
      })),
      conflicts,
      diagnostics,
    }));
    return {
      registry_digest: registryDigest,
      skills,
      conflicts,
      diagnostics,
    };
  }

  publicSnapshot(snapshot: SkillRegistrySnapshotInternal): SkillRegistrySnapshot {
    return SkillRegistrySnapshotSchema.parse({
      registry_digest: snapshot.registry_digest,
      skills: snapshot.skills.map(({ name, description, version, allowed_tools, source }) => ({
        name,
        description,
        version,
        allowed_tools,
        source,
      })),
      conflicts: snapshot.conflicts,
      diagnostics: snapshot.diagnostics,
    });
  }

  find(snapshot: SkillRegistrySnapshotInternal, name: string): SkillDefinition | undefined {
    const parsed = SkillNameSchema.safeParse(name);
    if (!parsed.success) return undefined;
    return snapshot.skills.find((skill) => skill.name === parsed.data);
  }

  async #scanScope(root: string, source: SkillSource): Promise<{
    skills: SkillDefinition[];
    diagnostics: SkillDiagnostic[];
  }> {
    const diagnostics: SkillDiagnostic[] = [];
    const skills: SkillDefinition[] = [];
    const rootStat = await safeLstat(root);
    if (rootStat === undefined) return { skills, diagnostics };
    if (!rootStat.isDirectory() || rootStat.isSymbolicLink()) {
      diagnostics.push(this.#diagnostic(source, root, "unsafe_path", "Skill root must be a real directory"));
      return { skills, diagnostics };
    }
    let entries;
    try {
      entries = (await readdir(root, { withFileTypes: true }))
        .sort((left, right) => left.name.localeCompare(right.name));
    } catch (error) {
      diagnostics.push(this.#diagnostic(source, root, "read_failed", publicFsError(error)));
      return { skills, diagnostics };
    }
    for (const entry of entries.slice(0, MAX_SKILLS)) {
      if (!entry.isDirectory() || entry.isSymbolicLink()) continue;
      const directory = join(root, entry.name);
      const skillPath = join(directory, "SKILL.md");
      const directoryStat = await safeLstat(directory);
      const fileStat = await safeLstat(skillPath);
      if (directoryStat === undefined || fileStat === undefined || !directoryStat.isDirectory() || directoryStat.isSymbolicLink() || !fileStat.isFile() || fileStat.isSymbolicLink() || fileStat.nlink !== 1) {
        diagnostics.push(this.#diagnostic(source, skillPath, "unsafe_path", "Skill directory and SKILL.md must be real files"));
        continue;
      }
      try {
        const canonicalDirectory = await realpath(directory);
        const canonicalRoot = await realpath(root);
        const escaped = relative(canonicalRoot, canonicalDirectory).startsWith("..")
          || resolve(canonicalRoot, relative(canonicalRoot, canonicalDirectory)) !== canonicalDirectory;
        if (escaped) {
          diagnostics.push(this.#diagnostic(source, skillPath, "unsafe_path", "Skill path escapes its configured root"));
          continue;
        }
      } catch (error) {
        diagnostics.push(this.#diagnostic(source, skillPath, "unsafe_path", publicFsError(error)));
        continue;
      }
      let raw: string;
      try {
        // Bind the existing loader's read to the inspected directory and
        // single-link file. Never allocate from an untrusted file size.
        const noFollow=process.platform==="darwin"?0x20000000:process.platform==="win32"?0:constants.O_NOFOLLOW;
        const parent=process.platform==="win32"?undefined:await open(await realpath(directory),constants.O_RDONLY|constants.O_DIRECTORY|noFollow);
        try {
          const parentInfo=parent?await parent.stat():await lstat(directory);
          if(parentInfo.ino!==directoryStat.ino||parentInfo.dev!==directoryStat.dev)throw new Error("Skill directory identity changed");
          const path=process.platform==="linux"?`/proc/self/fd/${parent!.fd}/SKILL.md`:await realpath(skillPath);
          const handle=await open(path,constants.O_RDONLY|noFollow);
          try {
            const info=await handle.stat(),current=await lstat(skillPath);
            if(!info.isFile()||info.nlink!==1||info.ino!==fileStat.ino||info.dev!==fileStat.dev||current.isSymbolicLink()||current.ino!==info.ino||current.dev!==info.dev)throw new Error("Skill file identity changed");
            const bytes=Buffer.alloc(MAX_SKILL_FILE_BYTES+1);let length=0;
            while(length<bytes.length){const read=await handle.read(bytes,length,bytes.length-length,length);if(!read.bytesRead)break;length+=read.bytesRead;}
            if(length>MAX_SKILL_FILE_BYTES){diagnostics.push(this.#diagnostic(source,skillPath,"invalid_body","SKILL.md exceeds the 256 KiB limit"));continue;}
            const after=await handle.stat(),parentAfter=await lstat(directory);
            if(after.nlink!==1||after.size!==info.size||after.mtimeMs!==info.mtimeMs||parentAfter.isSymbolicLink()||parentAfter.ino!==parentInfo.ino||parentAfter.dev!==parentInfo.dev)throw new Error("Skill changed during reading");
            raw=new TextDecoder("utf8",{fatal:true,ignoreBOM:true}).decode(bytes.subarray(0,length));
          } finally {await handle.close();}
        } finally {await parent?.close();}
      } catch (error) {
        diagnostics.push(this.#diagnostic(source, skillPath, "read_failed", publicFsError(error)));
        continue;
      }
      if (Buffer.byteLength(raw, "utf8") > MAX_SKILL_FILE_BYTES) {
        diagnostics.push(this.#diagnostic(source, skillPath, "invalid_body", "SKILL.md exceeds the 256 KiB limit"));
        continue;
      }
      try {
        const parsed = parseSkillMarkdown(raw, entry.name);
        const catalog = SkillCatalogEntrySchema.parse({
          name: parsed.name,
          description: parsed.description,
          version: parsed.version,
          allowed_tools: parsed.allowed_tools ?? [],
          source,
        });
        skills.push({
          ...catalog,
          filePath: skillPath,
          body: parsed.body,
          bodyHash: sha256(parsed.body),
        });
      } catch (error) {
        const code = error instanceof SkillParseError && error.code === "missing_frontmatter"
          ? "missing_frontmatter"
          : error instanceof SkillParseError && error.code === "invalid_body"
            ? "invalid_body"
            : "invalid_frontmatter";
        diagnostics.push(this.#diagnostic(
          source,
          skillPath,
          code,
          error instanceof Error ? error.message : "Invalid SKILL.md",
        ));
      }
    }
    return { skills, diagnostics };
  }

  #diagnostic(
    source: SkillSource,
    path: string,
    code: SkillDiagnostic["code"],
    message: string,
  ): SkillDiagnostic {
    return SkillDiagnosticSchema.parse({
      source,
      path,
      code,
      message: message.slice(0, 500) || "Skill diagnostic",
    });
  }
}

/** The management surface reuses exactly the runtime's constrained parser. */
export function validateSkillMarkdown(raw: string, name: string, source: SkillSource = "user"): SkillCatalogEntry {
  if (Buffer.byteLength(raw, "utf8") > MAX_SKILL_FILE_BYTES || raw.includes("\0")) throw new SkillParseError("invalid_body", "SKILL.md exceeds its text bound");
  const parsed = parseSkillMarkdown(raw, name);
  return SkillCatalogEntrySchema.parse({name:parsed.name,description:parsed.description,version:parsed.version,allowed_tools:parsed.allowed_tools??[],source});
}

export interface SkillRegistrySnapshotInternal {
  readonly registry_digest: `sha256:${string}`;
  readonly skills: readonly SkillDefinition[];
  readonly conflicts: readonly SkillConflict[];
  readonly diagnostics: readonly SkillDiagnostic[];
}

class SkillParseError extends Error {
  constructor(readonly code: "missing_frontmatter" | "invalid_frontmatter" | "invalid_body", message: string) {
    super(message);
  }
}

function parseSkillMarkdown(raw: string, directoryName: string): {
  name: string;
  description: string;
  version: string;
  allowed_tools?: string[];
  body: string;
} {
  const normalized = raw.replace(/^\uFEFF/u, "");
  if (!normalized.startsWith("---\n") && !normalized.startsWith("---\r\n")) {
    throw new SkillParseError("missing_frontmatter", "SKILL.md must start with YAML frontmatter");
  }
  const match = normalized.match(/^---\r?\n([\s\S]*?)\r?\n---\r?\n([\s\S]*)$/u);
  if (match === null) throw new SkillParseError("missing_frontmatter", "YAML frontmatter closing marker is missing");
  const header = match[1] ?? "";
  if (Buffer.byteLength(header, "utf8") > MAX_FRONTMATTER_BYTES) {
    throw new SkillParseError("invalid_frontmatter", "YAML frontmatter exceeds the 32 KiB limit");
  }
  const values = parseSimpleYaml(header);
  const name = parseScalar(values.name);
  const description = parseScalar(values.description);
  const version = parseScalar(values.version);
  if (name === undefined || description === undefined || version === undefined) {
    throw new SkillParseError("invalid_frontmatter", "name, description, and version are required");
  }
  if (name !== directoryName) {
    throw new SkillParseError("invalid_frontmatter", "frontmatter name must match its skill directory");
  }
  const allowed = values.allowed_tools;
  const allowedTools = allowed === undefined
    ? undefined
    : parseList(allowed).map((item) => parseScalar(item) ?? "");
  if (allowedTools?.some((item) => item.length === 0)) {
    throw new SkillParseError("invalid_frontmatter", "allowed_tools must contain non-empty tool names");
  }
  const body = match[2] ?? "";
  if (body.trim().length === 0) throw new SkillParseError("invalid_body", "SKILL.md body must not be empty");
  return { name, description, version, ...(allowedTools === undefined ? {} : { allowed_tools: allowedTools }), body };
}

function parseSimpleYaml(input: string): Record<string, string | string[]> {
  const values: Record<string, string | string[]> = {};
  let listKey: string | undefined;
  for (const rawLine of input.split(/\r?\n/u)) {
    const line = rawLine.trim();
    if (line.length === 0 || line.startsWith("#")) continue;
    if (line.startsWith("- ")) {
      if (listKey === undefined) throw new SkillParseError("invalid_frontmatter", "list item has no field");
      const current = values[listKey];
      if (!Array.isArray(current)) throw new SkillParseError("invalid_frontmatter", "invalid list field");
      current.push(line.slice(2).trim());
      continue;
    }
    const separator = line.indexOf(":");
    if (separator <= 0) throw new SkillParseError("invalid_frontmatter", `invalid YAML line: ${line}`);
    const key = line.slice(0, separator).trim();
    if (!["name", "description", "allowed_tools", "version"].includes(key)) {
      throw new SkillParseError("invalid_frontmatter", `unsupported frontmatter field: ${key}`);
    }
    const value = line.slice(separator + 1).trim();
    if (key === "allowed_tools" && value.length === 0) {
      values[key] = [];
      listKey = key;
    } else {
      values[key] = value;
      listKey = undefined;
    }
  }
  return values;
}

function parseList(value: string | string[]): string[] {
  if (Array.isArray(value)) return value;
  const trimmed = value.trim();
  if (trimmed === "[]") return [];
  if (!trimmed.startsWith("[") || !trimmed.endsWith("]")) {
    throw new SkillParseError("invalid_frontmatter", "allowed_tools must be a YAML list");
  }
  return trimmed.slice(1, -1).split(",").map((item) => item.trim()).filter((item) => item.length > 0);
}

function parseScalar(value: string | string[] | undefined): string | undefined {
  if (typeof value !== "string") return undefined;
  const trimmed = value.trim();
  if (trimmed.length === 0) return undefined;
  if ((trimmed.startsWith('"') && trimmed.endsWith('"')) || (trimmed.startsWith("'") && trimmed.endsWith("'"))) {
    return trimmed.slice(1, -1);
  }
  return trimmed;
}

async function safeLstat(path: string) {
  try {
    return await lstat(path);
  } catch {
    return undefined;
  }
}

function publicFsError(error: unknown): string {
  return error instanceof Error ? error.message.slice(0, 500) : "Unable to read skill files";
}
