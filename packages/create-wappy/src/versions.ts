import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import type { PartVersions } from "./templates.js";

/**
 * Reads each `@wappy/*` part's ACTUAL installed version from its own `package.json` (via
 * `require.resolve`, so this works identically whether `create-wappy` is running from this
 * monorepo's `workspace:*` links or as a real installed npm package) rather than hardcoding
 * versions here, which would drift the moment any part ships a new release.
 */
export function readPartVersions(fromUrl: string = import.meta.url): PartVersions {
  const require = createRequire(fromUrl);
  const read = (pkg: string): string => {
    const pkgJsonPath = require.resolve(`${pkg}/package.json`);
    const parsed = JSON.parse(readFileSync(pkgJsonPath, "utf8")) as { version: string };
    return parsed.version;
  };
  return {
    core: read("@wappy/core"),
    harness: read("@wappy/harness"),
    whatsapp: read("@wappy/whatsapp"),
    createWappy: read("create-wappy"),
  };
}
