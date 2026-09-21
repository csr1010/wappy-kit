import { expectTypeOf, test } from "vitest";
import type {
  Agent,
  Clock,
  DeliveryResult,
  InboundMessage,
  Logger,
  Memory,
  Model,
  ModelRequest,
  ModelResult,
  Router,
  RouterDecision,
  RouterInput,
  SmartMessage,
  Skill,
  Tool,
  ToolProvider,
  ToolResult,
  Turn,
} from "./index.js";
import { CORE_VERSION, PluginRegistry } from "./index.js";

test("Agent.handle: InboundMessage -> Promise<DeliveryResult>", () => {
  expectTypeOf<Agent["handle"]>().toEqualTypeOf<(message: InboundMessage) => Promise<DeliveryResult>>();
});

test("Router.route: RouterInput -> Promise<RouterDecision>", () => {
  expectTypeOf<Router["route"]>().parameter(0).toEqualTypeOf<RouterInput>();
  expectTypeOf<Router["route"]>().returns.toEqualTypeOf<Promise<RouterDecision>>();
});

test("Tool has readOnly/confirmBefore/execute -> Promise<ToolResult>", () => {
  expectTypeOf<Tool>().toHaveProperty("readOnly").toEqualTypeOf<boolean>();
  expectTypeOf<Tool>().toHaveProperty("confirmBefore").toEqualTypeOf<boolean>();
  expectTypeOf<Tool["execute"]>().returns.toEqualTypeOf<Promise<ToolResult>>();
});

test("ToolProvider.listTools returns Tool[] (sync or async)", () => {
  expectTypeOf<ToolProvider["listTools"]>().returns.toMatchTypeOf<Tool[] | Promise<Tool[]>>();
});

test("Memory: load/append/recall", () => {
  expectTypeOf<Memory["load"]>().toEqualTypeOf<(contactId: string) => Promise<Turn[]>>();
  expectTypeOf<Memory["append"]>().toEqualTypeOf<(turn: Turn) => Promise<void>>();
  expectTypeOf<Memory["recall"]>().toEqualTypeOf<(contactId: string, query: string) => Promise<string[]>>();
});

test("Skill shape", () => {
  expectTypeOf<Skill>().toHaveProperty("promptFragment").toEqualTypeOf<string>();
  expectTypeOf<Skill>().toHaveProperty("tools").toEqualTypeOf<string[] | undefined>();
});

test("Model port", () => {
  expectTypeOf<Model["generate"]>().toEqualTypeOf<(req: ModelRequest) => Promise<ModelResult>>();
});

test("Clock and Logger are structurally what testkit fakes must satisfy", () => {
  expectTypeOf<Clock>().toHaveProperty("now").toEqualTypeOf<() => number>();
  expectTypeOf<Logger>().toHaveProperty("info").toEqualTypeOf<(msg: string, meta?: Record<string, unknown>) => void>();
});

test("SmartMessage reserves an unvalidated flow slot", () => {
  expectTypeOf<SmartMessage>().toHaveProperty("flow");
});

test("CORE_VERSION is a string and PluginRegistry is constructible from it", () => {
  expectTypeOf(CORE_VERSION).toBeString();
  expectTypeOf(PluginRegistry).instance.toHaveProperty("register");
});
