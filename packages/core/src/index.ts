export const packageName = "@wappy/core";
/** Kept in sync with package.json "version" by hand; PluginRegistry checks against this. */
export const CORE_VERSION = "0.1.0";

export * from "./schemas.js";
export * from "./clock.js";
export * from "./logger.js";
export * from "./tracer.js";
export * from "./interfaces.js";
export * from "./semver.js";
export * from "./setup-manifest.js";
export * from "./registry.js";
export * from "./state/index.js";
