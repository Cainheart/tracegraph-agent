import { lstat, readdir, readFile } from "node:fs/promises";
import { dirname, isAbsolute, join, relative, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";

import { parseDocument } from "yaml";

const REPOSITORY_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const WORKSPACE_PATH = "pnpm-workspace.yaml";
const REQUIRED_README_SECTIONS = [
  { key: "purpose", label: "Purpose", aliases: ["purpose", "responsibility", "职责", "定位"] },
  { key: "public_api", label: "Public API", aliases: ["public api", "公开 api", "公开接口"] },
  { key: "dependencies", label: "Dependencies", aliases: ["dependencies", "依赖"] },
  { key: "state", label: "State ownership", aliases: ["state", "current state", "state ownership", "状态", "实现状态"] },
  { key: "extension_points", label: "Extension points", aliases: ["extension point", "extension points", "扩展点"] },
  { key: "model_effect", label: "Model effect", aliases: ["model effect", "model effects", "model experience", "模型影响", "模型体验"] },
  { key: "verification", label: "Verification", aliases: ["verification", "验证"] },
  { key: "limitations", label: "Known limitations", aliases: ["limitation", "limitations", "known limitations", "限制", "已知限制"] },
];

export async function verifyPackageReadmes(root = REPOSITORY_ROOT) {
  const repositoryRoot = resolve(root);
  const errors = [];
  const packages = await discoverPackages(repositoryRoot, errors);
  const seenNames = new Map();

  for (const item of packages) {
    const earlier = seenNames.get(item.name);
    if (earlier !== undefined) {
      addError(errors, "PACKAGE_README_PACKAGE_NAME_DUPLICATE", item.manifestPath, `Duplicate workspace package name ${item.name}; first declared at ${earlier}`);
    } else {
      seenNames.set(item.name, item.manifestPath);
    }
    await verifyReadme(repositoryRoot, item, errors);
  }

  return {
    ok: errors.length === 0,
    errors,
    packageCount: packages.length,
    readmeCount: packages.filter((item) => item.readmePresent).length,
  };
}

async function discoverPackages(root, errors) {
  const workspacePath = join(root, WORKSPACE_PATH);
  let source;
  try {
    source = await readFile(workspacePath, "utf8");
  } catch (error) {
    addError(errors, "PACKAGE_README_WORKSPACE_READ", WORKSPACE_PATH, `Cannot read ${WORKSPACE_PATH}: ${messageOf(error)}`);
    return [];
  }

  let workspace;
  try {
    const document = parseDocument(source, { uniqueKeys: true });
    if (document.errors.length > 0) {
      for (const error of document.errors) addError(errors, "PACKAGE_README_WORKSPACE_INVALID", WORKSPACE_PATH, error.message);
      return [];
    }
    workspace = document.toJS();
  } catch (error) {
    addError(errors, "PACKAGE_README_WORKSPACE_INVALID", WORKSPACE_PATH, messageOf(error));
    return [];
  }

  if (!isRecord(workspace) || !Array.isArray(workspace.packages)) {
    addError(errors, "PACKAGE_README_WORKSPACE_INVALID", WORKSPACE_PATH, "pnpm-workspace.yaml must define packages as a sequence");
    return [];
  }

  const roots = new Set();
  const packages = [];
  for (const pattern of workspace.packages) {
    const parent = workspacePackageParent(pattern);
    if (parent === undefined) {
      addError(errors, "PACKAGE_README_WORKSPACE_PATTERN_UNSUPPORTED", WORKSPACE_PATH, `Unsupported workspace package pattern ${String(pattern)}; expected a safe top-level <directory>/* pattern`);
      continue;
    }
    if (roots.has(parent)) continue;
    roots.add(parent);

    const parentPath = join(root, parent);
    let entries;
    try {
      const stat = await lstat(parentPath);
      if (!stat.isDirectory()) {
        addError(errors, "PACKAGE_README_WORKSPACE_DIRECTORY_INVALID", parent, `Workspace pattern parent ${parent} is not a directory`);
        continue;
      }
      entries = await readdir(parentPath, { withFileTypes: true });
    } catch (error) {
      addError(errors, "PACKAGE_README_WORKSPACE_DIRECTORY_READ", parent, `Cannot read workspace directory ${parent}: ${messageOf(error)}`);
      continue;
    }

    for (const entry of entries) {
      if (!entry.isDirectory()) continue;
      const packageRoot = join(parent, entry.name);
      const manifestPath = join(packageRoot, "package.json");
      let manifestSource;
      try {
        const stat = await lstat(join(root, manifestPath));
        if (!stat.isFile()) {
          addError(errors, "PACKAGE_README_PACKAGE_MANIFEST_INVALID", manifestPath, "package.json must be a regular file");
          continue;
        }
        manifestSource = await readFile(join(root, manifestPath), "utf8");
      } catch (error) {
        if (error?.code === "ENOENT") continue;
        addError(errors, "PACKAGE_README_PACKAGE_MANIFEST_READ", manifestPath, `Cannot read ${manifestPath}: ${messageOf(error)}`);
        continue;
      }

      let manifest;
      try {
        manifest = JSON.parse(manifestSource);
      } catch (error) {
        addError(errors, "PACKAGE_README_PACKAGE_MANIFEST_INVALID", manifestPath, `Invalid JSON: ${messageOf(error)}`);
        continue;
      }
      if (!isRecord(manifest) || !isNonEmptyString(manifest.name)) {
        addError(errors, "PACKAGE_README_PACKAGE_NAME_MISSING", manifestPath, "Workspace package manifest must declare a non-empty name");
        continue;
      }
      const normalizedRoot = relative(root, join(root, packageRoot)).split(sep).join("/");
      if (normalizedRoot === ".." || normalizedRoot.startsWith("../") || isAbsolute(normalizedRoot)) {
        addError(errors, "PACKAGE_README_PACKAGE_PATH_UNSAFE", manifestPath, "Workspace package path escapes the repository root");
        continue;
      }
      packages.push({ name: manifest.name.trim(), root: normalizedRoot, manifestPath, readmePresent: false });
    }
  }

  if (packages.length === 0 && errors.length === 0) {
    addError(errors, "PACKAGE_README_WORKSPACE_EMPTY", WORKSPACE_PATH, "No workspace package manifests were discovered");
  }
  return packages;
}

async function verifyReadme(root, item, errors) {
  const readmePath = join(item.root, "README.md");
  const absolutePath = join(root, readmePath);
  let source;
  try {
    const stat = await lstat(absolutePath);
    if (!stat.isFile()) {
      addError(errors, "PACKAGE_README_NOT_REGULAR_FILE", readmePath, `${item.name} README.md must be a regular file`);
      return;
    }
    source = await readFile(absolutePath, "utf8");
    item.readmePresent = true;
  } catch (error) {
    if (error?.code === "ENOENT") {
      addError(errors, "PACKAGE_README_MISSING", readmePath, `${item.name} must provide README.md`);
    } else {
      addError(errors, "PACKAGE_README_READ", readmePath, `Cannot read ${readmePath}: ${messageOf(error)}`);
    }
    return;
  }

  const headings = collectHeadings(source);
  for (const section of REQUIRED_README_SECTIONS) {
    const matches = headings.filter((heading) => heading.level === 2 && section.aliases.includes(normalizeHeading(heading.title)));
    if (matches.length === 0) {
      addError(errors, "PACKAGE_README_SECTION_MISSING", readmePath, `${item.name} README.md is missing the ${section.label} section`);
      continue;
    }
    if (matches.length > 1) {
      addError(errors, "PACKAGE_README_SECTION_DUPLICATE", readmePath, `${item.name} README.md has more than one ${section.label} section`);
    }
    if (sectionBody(source, matches[0], headings).trim().length === 0) {
      addError(errors, "PACKAGE_README_SECTION_EMPTY", readmePath, `${item.name} README.md has an empty ${section.label} section`);
    }
  }
}

function collectHeadings(source) {
  const headings = [];
  const pattern = /^(#{1,6})[ \t]+(.+?)[ \t]*#*[ \t]*$/gmu;
  for (const match of source.matchAll(pattern)) {
    headings.push({
      level: match[1].length,
      title: match[2],
      start: match.index,
      bodyStart: match.index + match[0].length,
    });
  }
  return headings;
}

function sectionBody(source, heading, headings) {
  const nextHeading = headings.find((candidate) => candidate.start > heading.start && candidate.level <= heading.level);
  const end = nextHeading?.start ?? source.length;
  return source.slice(heading.bodyStart, end)
    .replace(/<!--[\s\S]*?-->/gu, "")
    .replace(/^#{1,6}[ \t]+.*$/gmu, "")
    .trim();
}

function normalizeHeading(value) {
  return value
    .normalize("NFKC")
    .replace(/`/gu, "")
    .replace(/[^\p{L}\p{N}]+/gu, " ")
    .trim()
    .toLocaleLowerCase("en-US");
}

function workspacePackageParent(pattern) {
  if (typeof pattern !== "string") return undefined;
  const match = /^([A-Za-z0-9._-]+)\/\*$/u.exec(pattern);
  if (match === null || match[1] === "." || match[1] === "..") return undefined;
  return match[1];
}

function addError(errors, code, location, message) {
  errors.push({ code, location, message });
}

function isRecord(value) {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function isNonEmptyString(value) {
  return typeof value === "string" && value.trim().length > 0;
}

function messageOf(error) {
  return error instanceof Error ? error.message : String(error);
}

async function runCli(args) {
  const rootIndex = args.indexOf("--root");
  if (rootIndex !== -1 && (args.length !== rootIndex + 2 || args[rootIndex + 1].startsWith("--"))) {
    process.stderr.write("Usage: node scripts/verify-package-readmes.mjs [--root <repository>]\n");
    process.exitCode = 2;
    return;
  }
  if (args.some((argument, index) => argument.startsWith("--") && (index !== rootIndex || argument !== "--root"))) {
    process.stderr.write("Usage: node scripts/verify-package-readmes.mjs [--root <repository>]\n");
    process.exitCode = 2;
    return;
  }
  const root = rootIndex === -1 ? REPOSITORY_ROOT : resolve(args[rootIndex + 1]);
  const outcome = await verifyPackageReadmes(root);
  if (outcome.ok) {
    process.stdout.write(`Package README contracts verified: ${outcome.packageCount} workspace packages and ${outcome.readmeCount} README files.\n`);
    return;
  }
  for (const error of outcome.errors) process.stderr.write(`[${error.code}] ${error.location}: ${error.message}\n`);
  process.exitCode = 1;
}

if (process.argv[1] !== undefined && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  await runCli(process.argv.slice(2));
}
