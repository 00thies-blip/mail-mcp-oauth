import { describe, expect, it } from "vitest";
import { maskiere } from "../src/maske.js";

describe("maskiere", () => {
  it("eigene Adressen und Kunden getrennt, keine Adresse bleibt stehen", () => {
    const t = maskiere("Buyer: info@setfairstudio.com an kunde@example.org von 00thies@gmail.com, fremd x@gmail.com", "00thies@gmail.com");
    expect(t).toBe("Buyer: [eigen] an [kunde] von [eigen], fremd [kunde]");
    expect(t).not.toMatch(/@/);
  });
});

import { ohnePerson } from "../src/maske.js";
describe("ohnePerson", () => {
  it("Namen, Lizenz und IBAN entfernt, Bestelldaten bleiben", () => {
    const t = ohnePerson("Bestell-ID: 232ZACWE\nBetrag: Einmalig 19 €\nVorname: Anna\nNachname: Muster\n1. Lizenzschlüssel: X\nLand: Deutschland\nKonto ES26 1583 0001 1990 2860 9404 ok");
    expect(t).toContain("Bestell-ID: 232ZACWE");
    expect(t).toContain("Einmalig 19 €");
    expect(t).not.toMatch(/Anna|Muster|Lizenz|1583/);
  });
});
