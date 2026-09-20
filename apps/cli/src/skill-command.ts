import { homedir } from "node:os";
import { resolve } from "node:path";
import { SkillRegistry } from "@tracegraph/core";

export interface SkillCommandDependencies {
  readonly environment?: NodeJS.ProcessEnv;
  readonly cwd?: string;
  readonly write?: (value: string) => void;
}

/** Filesystem-only Skill inspection; it never imports or executes Skill code. */
export async function runSkillsCommand(
  args: readonly string[],
  dependencies: SkillCommandDependencies = {},
): Promise<void> {
  const subcommand = args[0];
  if (subcommand !== "list" && subcommand !== "validate") {
    throw new Error("Usage: tracegraph skills list|validate [--project-root <path>] [--user-root <path>]");
  }
  const environment = dependencies.environment ?? process.env;
  const projectRoot = resolve(readFlag(args, "--project-root") ?? environment.TRACEGRAPH_PROJECT_ROOT ?? dependencies.cwd ?? process.cwd());
  const userRoot = resolve(readFlag(args, "--user-root") ?? environment.TRACEGRAPH_SKILLS_ROOT ?? `${homedir()}/.tracegraph/skills`);
  const registry = new SkillRegistry({ userSkillsRoot: userRoot });
  const snapshot = await registry.scan(projectRoot);
  const write = dependencies.write ?? ((value: string) => process.stdout.write(value));
  const output = {
    registry_digest: snapshot.registry_digest,
    project_root: projectRoot,
    user_skills_root: userRoot,
    skills: snapshot.skills.map(({ name, description, version, allowed_tools, source }) => ({
      name,
      description,
      version,
      allowed_tools,
      source,
    })),
    conflicts: snapshot.conflicts,
    diagnostics: snapshot.diagnostics,
  };
  write(`${JSON.stringify(output, null, 2)}\n`);
  if (subcommand === "validate" && snapshot.diagnostics.length > 0) process.exitCode = 1;
}

function readFlag(args: readonly string[], name: string): string | undefined {
  const index = args.indexOf(name);
  if (index < 0) return undefined;
  const value = args[index + 1];
  if (value === undefined || value.startsWith("--")) throw new Error(`${name} requires a value`);
  return value;
}
