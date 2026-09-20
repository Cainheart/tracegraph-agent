import { mkdtemp, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import {
  EXTENSION_CONFIG_VERSION,
} from "@tracegraph/contracts";
import {
  BUILTIN_ARTIFACT_TOOLS_EXTENSION,
  BUILTIN_RUN_STATE_TOOLS_EXTENSION,
} from "@tracegraph/core";
import { describe, expect, it } from "vitest";
import { HostExtensionController, MAX_EXTENSION_CONFIG_BYTES } from "./extension-config.js";

async function temporaryDirectory(): Promise<string> {
  return mkdtemp(resolve(tmpdir(), "tracegraph-extensions-"));
}

describe("HostExtensionController", () => {
  it("uses only the two trusted built-ins when the Host config is absent", async () => {
    const directory = await temporaryDirectory();
    const controller = await HostExtensionController.open(resolve(directory, "extensions.json"));

    expect(controller.list()).toEqual([
      expect.objectContaining({ name: BUILTIN_ARTIFACT_TOOLS_EXTENSION, state: "active" }),
      expect.objectContaining({ name: BUILTIN_RUN_STATE_TOOLS_EXTENSION, state: "active" }),
    ]);
    expect(controller.manager.toolRegistry.descriptors().map(({ name }) => name)).toEqual(
      expect.arrayContaining(["read_artifact", "todo_read"]),
    );
  });

  it("honors data-only enablement without loading a module path", async () => {
    const directory = await temporaryDirectory();
    const file = resolve(directory, "extensions.json");
    await writeFile(file, JSON.stringify({
      config_version: EXTENSION_CONFIG_VERSION,
      extensions: [{
        name: BUILTIN_RUN_STATE_TOOLS_EXTENSION,
        module: BUILTIN_RUN_STATE_TOOLS_EXTENSION,
        enabled: true,
        required: true,
      }],
    }));

    const controller = await HostExtensionController.open(file);
    expect(controller.list()).toEqual([
      expect.objectContaining({ name: BUILTIN_ARTIFACT_TOOLS_EXTENSION, state: "inactive" }),
      expect.objectContaining({ name: BUILTIN_RUN_STATE_TOOLS_EXTENSION, state: "active" }),
    ]);
    expect(controller.manager.toolRegistry.get("read_artifact")).toBeUndefined();
    expect(controller.manager.toolRegistry.get("todo_read")).toBeDefined();
  });

  it("reconciles enablement only while no Run holds an extension lease", async () => {
    const directory = await temporaryDirectory();
    const file = resolve(directory, "extensions.json");
    const config = (artifactEnabled: boolean) => ({
      config_version: EXTENSION_CONFIG_VERSION,
      extensions: [{
        name: BUILTIN_ARTIFACT_TOOLS_EXTENSION,
        module: BUILTIN_ARTIFACT_TOOLS_EXTENSION,
        enabled: artifactEnabled,
        required: true,
      }, {
        name: BUILTIN_RUN_STATE_TOOLS_EXTENSION,
        module: BUILTIN_RUN_STATE_TOOLS_EXTENSION,
        enabled: true,
        required: true,
      }],
    });
    await writeFile(file, JSON.stringify(config(true)));
    const controller = await HostExtensionController.open(file);

    await writeFile(file, JSON.stringify(config(false)));
    await expect(controller.reload({
      command_id: "command:disable-artifacts",
      extension_name: BUILTIN_ARTIFACT_TOOLS_EXTENSION,
    })).resolves.toMatchObject({ state: "inactive", registration_count: 0 });
    expect(controller.manager.toolRegistry.get("read_artifact")).toBeUndefined();

    await writeFile(file, JSON.stringify(config(true)));
    const lease = controller.manager.acquireRunLease();
    await expect(controller.reload({
      command_id: "command:enable-artifacts",
      extension_name: BUILTIN_ARTIFACT_TOOLS_EXTENSION,
    })).rejects.toMatchObject({ code: "extension_busy", statusCode: 409 });
    lease.release();
    await expect(controller.reload({
      command_id: "command:enable-artifacts:retry",
      extension_name: BUILTIN_ARTIFACT_TOOLS_EXTENSION,
    })).resolves.toMatchObject({ state: "active" });
  });

  it("rejects oversized content before JSON parsing, unknown ids, duplicates, symlinks, and TypeScript", async () => {
    const directory = await temporaryDirectory();
    const file = resolve(directory, "extensions.json");
    await writeFile(file, Buffer.alloc(MAX_EXTENSION_CONFIG_BYTES + 1, 0x7b));
    await expect(HostExtensionController.open(file)).rejects.toThrow(/exceeds 262144 bytes/u);

    await writeFile(file, JSON.stringify({
      config_version: EXTENSION_CONFIG_VERSION,
      extensions: [{ name: "untrusted", module: "/tmp/untrusted.mjs", enabled: true }],
    }));
    await expect(HostExtensionController.open(file)).rejects.toThrow(/trusted Host catalog/u);

    await writeFile(file, JSON.stringify({
      config_version: EXTENSION_CONFIG_VERSION,
      extensions: [
        { name: BUILTIN_ARTIFACT_TOOLS_EXTENSION, module: BUILTIN_ARTIFACT_TOOLS_EXTENSION },
        { name: BUILTIN_ARTIFACT_TOOLS_EXTENSION, module: BUILTIN_ARTIFACT_TOOLS_EXTENSION },
      ],
    }));
    await expect(HostExtensionController.open(file)).rejects.toThrow(/extension names must be unique/u);

    const target = resolve(directory, "target.json");
    const link = resolve(directory, "link.json");
    await writeFile(target, JSON.stringify({ config_version: EXTENSION_CONFIG_VERSION, extensions: [] }));
    await symlink(target, link);
    await expect(HostExtensionController.open(link)).rejects.toThrow(/non-symlink/u);

    const typescript = resolve(directory, "tracegraph.config.ts");
    await writeFile(typescript, "export default { extensions: [] };\n");
    await expect(HostExtensionController.open(typescript)).rejects.toThrow(/not valid JSON/u);
  });
});
