import { readFileSync } from "node:fs";
import { z } from "zod";

const PackageMetadataSchema = z.object({
  name: z.literal("@tracegraph/desktop-host"),
  version: z.string().min(1).max(128),
}).passthrough();

const packageMetadata = PackageMetadataSchema.parse(
  JSON.parse(readFileSync(new URL("../package.json", import.meta.url), "utf8")) as unknown,
);

export const DESKTOP_HOST_PACKAGE_NAME = packageMetadata.name;
export const DESKTOP_HOST_PACKAGE_VERSION = packageMetadata.version;
