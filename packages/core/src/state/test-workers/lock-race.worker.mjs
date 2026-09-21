// Worker for lock-process.m2.test.ts's cross-process race test. Deliberately reimplements the
// tryAcquireLock/releaseLock primitive in plain JS (not imported from lock.ts) so the test has no
// build-order dependency and exercises the real OS-level O_EXCL exclusivity guarantee directly.
import { closeSync, openSync, readFileSync, unlinkSync, writeFileSync } from "node:fs";

const [, , lockPath, counterPath, attemptsArg] = process.argv;
const attempts = Number(attemptsArg);

function tryAcquire() {
  try {
    closeSync(openSync(lockPath, "wx"));
    return true;
  } catch (e) {
    if (e.code === "EEXIST") return false;
    throw e;
  }
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

let ok = true;
for (let i = 0; i < attempts && ok; i++) {
  while (!tryAcquire()) await sleep(1);
  try {
    const before = readFileSync(counterPath, "utf8");
    if (before !== "0") {
      ok = false;
      break;
    }
    writeFileSync(counterPath, "1");
    await sleep(2);
    const after = readFileSync(counterPath, "utf8");
    if (after !== "1") {
      ok = false;
      break;
    }
    writeFileSync(counterPath, "0");
  } finally {
    unlinkSync(lockPath);
  }
}
process.exit(ok ? 0 : 1);
