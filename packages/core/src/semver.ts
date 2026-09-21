/**
 * Minimal semver-range check: supports "*", exact "x.y.z", "~x.y.z", "^x.y.z".
 * Core stays dependency-light (zod + nothing else, CLAUDE.md) — swap for the
 * `semver` package if a plugin ever needs a richer range grammar.
 */
function parse(version: string): [number, number, number] {
  const m = /^(\d+)\.(\d+)\.(\d+)/.exec(version.trim());
  if (!m) throw new Error(`semver: invalid version "${version}"`);
  return [Number(m[1]), Number(m[2]), Number(m[3])];
}

export function satisfiesRange(version: string, range: string): boolean {
  const r = range.trim();
  if (r === "*" || r === "") return true;
  const [vMaj, vMin, vPat] = parse(version);

  if (r.startsWith("^")) {
    const [rMaj, rMin, rPat] = parse(r.slice(1));
    if (vMaj !== rMaj) return false;
    if (rMaj > 0) return vMin > rMin || (vMin === rMin && vPat >= rPat);
    // 0.x.y: caret only allows patch bumps within the same minor (npm semantics).
    if (rMin > 0) return vMin === rMin && vPat >= rPat;
    return vMin === 0 && vPat === rPat;
  }
  if (r.startsWith("~")) {
    const [rMaj, rMin, rPat] = parse(r.slice(1));
    return vMaj === rMaj && vMin === rMin && vPat >= rPat;
  }
  const [rMaj, rMin, rPat] = parse(r);
  return vMaj === rMaj && vMin === rMin && vPat === rPat;
}
