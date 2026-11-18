import { describe, expect, it } from "vitest";
import { maskiere } from "../src/maske.js";

describe("maskiere", () => {
  it("eigene Adressen und Kunden getrennt, keine Adresse bleibt stehen", () => {
    const t = maskiere("Buyer: info@setfairstudio.com an kunde@example.org von 00thies@gmail.com, fremd x@gmail.com", "00thies@gmail.com");
    expect(t).toBe("Buyer: [eigen] an [kunde] von [eigen], fremd [kunde]");
    expect(t).not.toMatch(/@/);
  });
});
