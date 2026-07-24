/** One idempotent install step contributed by a part (ledger persistence is M2). */
export interface SetupStep {
  id: string;
  description: string;
  envKeys?: string[];
}

/** Declared by each part/plugin; core aggregates these into the state ledger (§5). */
export interface SetupManifest {
  part: string;
  steps: SetupStep[];
}

export interface AggregatedStep extends SetupStep {
  part: string;
}

export interface AggregatedSetup {
  steps: AggregatedStep[];
  envKeys: string[];
}

/** Flattens manifests into one step list (attributed to their part) + the deduped env key set. */
export function aggregateSetupManifests(manifests: SetupManifest[]): AggregatedSetup {
  const steps: AggregatedStep[] = [];
  const envKeys = new Set<string>();
  const seen = new Set<string>();
  for (const manifest of manifests) {
    for (const step of manifest.steps) {
      const key = `${manifest.part}:${step.id}`;
      if (seen.has(key)) {
        throw new Error(`aggregateSetupManifests: duplicate step "${step.id}" in part "${manifest.part}"`);
      }
      seen.add(key);
      steps.push({ ...step, part: manifest.part });
      for (const envKey of step.envKeys ?? []) envKeys.add(envKey);
    }
  }
  return { steps, envKeys: [...envKeys] };
}
