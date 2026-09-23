import { describe, expect, test } from "vitest";
import { FORMAT_REASONING, GROUNDING_HONESTY } from "./agent.js";

/**
 * M12 decision 4: the generic prompting layer that replaced the three reference skills uses ZERO
 * domain language — it reasons from content shape (item count, one clear action, would media help),
 * never from business type, so it applies identically to a store, a clinic, a helpdesk, or anything
 * else built on Wappy Kit. Permanent regression protection: if either constant picks up a domain
 * word, that's the milestone's central claim quietly regressing.
 */
const BANNED_WORDS = ["store", "product", "order", "shop", "customer", "inventory"];

describe("FORMAT_REASONING / GROUNDING_HONESTY stay domain-neutral (M12 decision 4)", () => {
  test.each(BANNED_WORDS)('neither constant contains the domain word "%s"', (word) => {
    const re = new RegExp(word, "i");
    expect(FORMAT_REASONING).not.toMatch(re);
    expect(GROUNDING_HONESTY).not.toMatch(re);
  });
});
