// Worker for lock-process.m2.test.ts's crash-recovery test: acquires the lock file (same wire
// format as lock.ts) then SIGKILLs itself, leaving the lock behind exactly as a real crash would.
import { closeSync, openSync, writeFileSync } from "node:fs";

const [, , lockPath] = process.argv;
const fd = openSync(lockPath, "wx");
writeFileSync(fd, JSON.stringify({ pid: process.pid, acquiredAt: Date.now() }));
closeSync(fd);
process.kill(process.pid, "SIGKILL");
