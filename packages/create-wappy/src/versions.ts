import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import type { PartVersions } from "./templates.js";

/**
 * Reads each `@wappy/*` part's ACTUAL installed version from its own `package.json` (via
 * `require.resolve`, so this works identically whether `create-wappy` is running from this
 * monorepo's `workspace:*` links or as a real installed npm package) rather than hardcoding
 * versions here, which would drift the moment any part ships a new release.
 *
 * `@wappy/tools-openapi` is deliberately NOT a dependency of `create-wappy` itself (npm-level
 * decoupling: installing `create-wappy` must only pull in the generic agent + WhatsApp channel —
 * @wappy/core/harness/whatsapp — never Shopify's own dependency tree, even for a user who never
 * picks it). So it can't always be `require.resolve`d from here; when it isn't installed
 * alongside create-wappy (the normal case), this falls back to a version pinned at release time.
 * The GENERATED PROJECT still correctly depends on the real `@wappy/tools-openapi` in its own
 * package.json once the user actually chooses Shopify (templates.ts/shopify.ts) — this fallback
 * only ever affects what version string gets written there.
 */
const TOOLS_OPENAPI_FALLBACK_VERSION = "0.0.0"; // bump alongside @wappy/tools-openapi's own releases

export function readPartVersions(fromUrl: string = import.meta.url): PartVersions {
  const require = createRequire(fromUrl);
  const read = (pkg: string): string => {
    const pkgJsonPath = require.resolve(`${pkg}/package.json`);
    const parsed = JSON.parse(readFileSync(pkgJsonPath, "utf8")) as { version: string };
    return parsed.version;
  };
  const readOptional = (pkg: string, fallback: string): string => {
    try {
      return read(pkg);
    } catch {
      return fallback;
    }
  };
  return {
    core: read("@wappy/core"),
    harness: read("@wappy/harness"),
    whatsapp: read("@wappy/whatsapp"),
    toolsOpenapi: readOptional("@wappy/tools-openapi", TOOLS_OPENAPI_FALLBACK_VERSION),
    createWappy: read("create-wappy"),
  };
}
