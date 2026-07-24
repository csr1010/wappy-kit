import { systemClock, type Clock } from "./clock.js";

/** Systems a canonical trace (SPEC §9) can touch. */
export type TracedSystem = "whatsapp" | "memory" | "router" | "skill" | "rag" | "tools" | "llm";

export interface TraceEvent {
  system: TracedSystem;
  event: string;
  data?: unknown;
  at: number;
}

export interface Tracer {
  record(system: TracedSystem, event: string, data?: unknown): void;
  /** Set of systems touched so far — spine tests assert this exactly (B5). */
  touched(): Set<TracedSystem>;
  events(): TraceEvent[];
}

export function createInMemoryTracer(clock: Pick<Clock, "now"> = systemClock): Tracer {
  const events: TraceEvent[] = [];
  const touched = new Set<TracedSystem>();
  return {
    record(system, event, data) {
      touched.add(system);
      events.push({ system, event, data, at: clock.now() });
    },
    touched: () => new Set(touched),
    events: () => [...events],
  };
}
