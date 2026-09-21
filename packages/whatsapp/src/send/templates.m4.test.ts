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

  test("a button with `variable` set pulls its dynamic value from the per-send variables, not a fixed literal", () => {
    const registry = createTemplateRegistry();
    registry.register({
      name: "shipped",
      language: "en_US",
      category: "utility",
      variables: ["orderId"],
      buttons: [
        { type: "url", text: "unused-fallback", variable: "trackingSuffix" },
        { type: "quick_reply", text: "unused-fallback", variable: "orderId" },
      ],
    });
    // orderId=8842 is used both by the body {{1}} and by the second button (a variable can be reused).
    const result = renderTemplate(registry, "15550002222", "shipped", { orderId: "8842", trackingSuffix: "trk-8842" });
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
            { type: "button", sub_type: "url", index: "0", parameters: [{ type: "text", text: "trk-8842" }] },
            { type: "button", sub_type: "quick_reply", index: "1", parameters: [{ type: "payload", payload: "8842" }] },
          ],
        },
      },
    });
  });

  test("a button with no `variable` set uses its static `text` as a fixed fallback, unchanged across sends", () => {
    const registry = createTemplateRegistry();
    registry.register({ name: "confirm", language: "en_US", category: "utility", variables: [], buttons: [{ type: "quick_reply", text: "confirm_delivery" }] });
    const result = renderTemplate(registry, "15550002222", "confirm", {});
    expect(result).toEqual({
      ok: true,
      payload: {
        messaging_product: "whatsapp",
        to: "15550002222",
        type: "template",
        template: {
          name: "confirm",
          language: { code: "en_US" },
          components: [
            { type: "body", parameters: [] },
            { type: "button", sub_type: "quick_reply", index: "0", parameters: [{ type: "payload", payload: "confirm_delivery" }] },
          ],
        },
      },
    });
  });

  test("a button's missing `variable` fails clearly, the same as a missing body variable", () => {
    const registry = createTemplateRegistry();
    registry.register({ name: "shipped2", language: "en_US", category: "utility", variables: [], buttons: [{ type: "url", text: "fallback", variable: "trackingSuffix" }] });
    const result = renderTemplate(registry, "15550002222", "shipped2", {});
    expect(result).toEqual({ ok: false, error: 'template "shipped2" is missing variables: trackingSuffix' });
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
