/** Injectable time + scheduling port. Never call Date.now()/setTimeout directly outside an impl of this. */
export interface Clock {
  now(): number;
  setTimeout(fn: () => void, ms: number): number;
  clearTimeout(handle: number): void;
  sleep(ms: number): Promise<void>;
}

const timers = new Map<number, ReturnType<typeof setTimeout>>();
let nextHandle = 1;

export const systemClock: Clock = {
  now: () => Date.now(),
  setTimeout(fn, ms) {
    const handle = nextHandle++;
    timers.set(handle, setTimeout(fn, ms));
    return handle;
  },
  clearTimeout(handle) {
    const native = timers.get(handle);
    if (native !== undefined) clearTimeout(native);
    timers.delete(handle);
  },
  sleep: (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
};
