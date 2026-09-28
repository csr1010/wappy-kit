import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import type { PartVersions } from "./templates.js";

/**
 * Reads each `@wappy_ai/*` part's ACTUAL installed version from its own `package.json` (via
 * `require.resolve`, so this works identically whether `@wappy_ai/create-agent` is running from this
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
    core: read("@wappy_ai/core"),
    harness: read("@wappy_ai/harness"),
    whatsapp: read("@wappy_ai/whatsapp"),
    productivity: read("@wappy_ai/productivity"),
    connectorGoogle: read("@wappy_ai/connector-google"),
    createWappy: read("@wappy_ai/create-agent"),
  };
}
