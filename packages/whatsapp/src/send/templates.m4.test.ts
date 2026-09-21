import { describe, expect, test } from "vitest";
import { createTemplateRegistry, renderTemplate } from "./templates.js";

const def = { name: "order_update", language: "en_US", category: "utility" as const, variables: ["customerName", "orderId"] };

describe("createTemplateRegistry", () => {
  test("register + get round-trips", () => {
    const registry = createTemplateRegistry();
    registry.register(def);
    expect(registry.get("order_update")).toEqual(def);
  });

  test("get() on an unregistered name returns undefined", () => {
    expect(createTemplateRegistry().get("nope")).toBeUndefined();
  });

  test("registering the same name twice throws", () => {
    const registry = createTemplateRegistry();
    registry.register(def);
    expect(() => registry.register(def)).toThrow(/already registered/i);
  });
});

describe("renderTemplate", () => {
  test("renders a valid Cloud API template payload with variables in order", () => {
    const registry = createTemplateRegistry();
    registry.register(def);
    const result = renderTemplate(registry, "15550002222", "order_update", { customerName: "Ada", orderId: "8842" });
    expect(result).toEqual({
      ok: true,
      payload: {
        messaging_product: "whatsapp",
        to: "15550002222",
        type: "template",
        template: { name: "order_update", language: { code: "en_US" }, components: [{ type: "body", parameters: [{ type: "text", text: "Ada" }, { type: "text", text: "8842" }] }] },
      },
    });
  });

  test("an unregistered template name fails clearly", () => {
    const result = renderTemplate(createTemplateRegistry(), "15550002222", "nope", {});
    expect(result).toEqual({ ok: false, error: 'template "nope" is not registered' });
  });

  test("missing variables fail clearly, listing what's missing", () => {
    const registry = createTemplateRegistry();
    registry.register(def);
    const result = renderTemplate(registry, "15550002222", "order_update", { customerName: "Ada" });
    expect(result).toEqual({ ok: false, error: 'template "order_update" is missing variables: orderId' });
  });

  test("a template with buttons emits one button component per button, in order, with the right sub_type/index/parameter shape", () => {
    const registry = createTemplateRegistry();
    registry.register({
      name: "shipped",
      language: "en_US",
      category: "utility",
      variables: ["orderId"],
      buttons: [
        { type: "url", text: "track/{{orderId}}" },
        { type: "quick_reply", text: "confirm_delivery" },
      ],
    });
    const result = renderTemplate(registry, "15550002222", "shipped", { orderId: "8842" });
    expect(result).toEqual({
      ok: true,
      payload: {
        messaging_product: "whatsapp",
        to: "15550002222",
        type: "template",
        template: {
          name: "shipped",
          language: { code: "en_US" },
          components: [
            { type: "body", parameters: [{ type: "text", text: "8842" }] },
            { type: "button", sub_type: "url", index: "0", parameters: [{ type: "text", text: "track/{{orderId}}" }] },
            { type: "button", sub_type: "quick_reply", index: "1", parameters: [{ type: "payload", payload: "confirm_delivery" }] },
          ],
        },
      },
    });
  });

  test("a template with no buttons omits button components entirely (unchanged from before buttons existed)", () => {
    const registry = createTemplateRegistry();
    registry.register(def);
    const result = renderTemplate(registry, "15550002222", "order_update", { customerName: "Ada", orderId: "8842" });
    expect(result).toEqual({
      ok: true,
      payload: {
        messaging_product: "whatsapp",
        to: "15550002222",
        type: "template",
        template: { name: "order_update", language: { code: "en_US" }, components: [{ type: "body", parameters: [{ type: "text", text: "Ada" }, { type: "text", text: "8842" }] }] },
      },
    });
  });
});
