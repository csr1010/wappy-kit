import { satisfiesRange } from "./semver.js";
import type { SetupManifest } from "./setup-manifest.js";

export type PluginKind = "channel" | "memory" | "router" | "toolProvider" | "skill" | "model";

export interface Plugin<T = unknown> {
  name: string;
  kind: PluginKind;
  /** semver range of @wappy/core this plugin was built against. */
  coreVersionRange: string;
  instance: T;
  setup?: SetupManifest;
}

/** Parts self-register here; core loads the enabled subset from config (§3). Deterministic (registration) order. */
export class PluginRegistry {
  private readonly plugins: Plugin[] = [];
  private readonly names = new Set<string>();

  constructor(private readonly coreVersion: string) {}

  register(plugin: Plugin): void {
    if (this.names.has(plugin.name)) {
      throw new Error(`PluginRegistry: duplicate plugin name "${plugin.name}"`);
    }
    if (!satisfiesRange(this.coreVersion, plugin.coreVersionRange)) {
      throw new Error(
        `PluginRegistry: plugin "${plugin.name}" requires core ${plugin.coreVersionRange}, running ${this.coreVersion}`,
      );
    }
    this.names.add(plugin.name);
    this.plugins.push(plugin);
  }

  /** First-registered plugin of `kind` (optionally by `name`); undefined if none match — never throws on an unknown kind. */
  get<T>(kind: PluginKind, name?: string): T | undefined {
    const found = name
      ? this.plugins.find((p) => p.kind === kind && p.name === name)
      : this.plugins.find((p) => p.kind === kind);
    return found?.instance as T | undefined;
  }

  list(kind?: PluginKind): Plugin[] {
    return kind ? this.plugins.filter((p) => p.kind === kind) : [...this.plugins];
  }
}

export interface RegistryConfig {
  enabled: string[];
}

/** Resolves the configured enabled-plugin list in config order; throws on an unregistered name. */
export function resolveEnabledPlugins(registry: PluginRegistry, config: RegistryConfig): Plugin[] {
  const byName = new Map(registry.list().map((p) => [p.name, p]));
  return config.enabled.map((name) => {
    const plugin = byName.get(name);
    if (!plugin) throw new Error(`resolveEnabledPlugins: unknown plugin "${name}"`);
    return plugin;
  });
}
