import { satisfiesRange } from "../semver.js";

export interface VersionSkewWarning {
  part: string;
  message: string;
}

/** Core/part version skew check (SPEC §10) — pure, returns warnings; the CLI decides how to surface them. */
export function checkVersionSkew(coreVersion: string, parts: { name: string; coreVersionRange: string }[]): VersionSkewWarning[] {
  return parts
    .filter((p) => !satisfiesRange(coreVersion, p.coreVersionRange))
    .map((p) => ({ part: p.name, message: `${p.name} requires core ${p.coreVersionRange}, running ${coreVersion}` }));
}
