/**
 * ShopRPC – nur per Service Binding erreichbar (nicht per HTTP). Nutzer: Worker „cockpit“ (Repo
 * expatandalucia-automation tools/cockpit, src/verkaeufe.js). Nur lesen: Verkaufsmeldungen der Shops
 * (Digistore24, Etsy, Payhip, Gumroad) aus dem Konto SHOP_KONTO (Standard „gmail“).
 * Fremde Mailadressen verlassen den Worker nie: im Text steht statt der Adresse „[eigen]“ oder „[kunde]“;
 * Namens-, Adress- und Lizenzzeilen sowie IBANs werden entfernt (ohnePerson).
 * Eine Mail je Aufruf (getMessage parst die ganze Mail; Gratistarif mit 10 ms CPU je Aufruf).
 */
import { WorkerEntrypoint } from "cloudflare:workers";
import { resolveAccount } from "./accounts.js";
import { loadAccounts } from "./store.js";
import { withImap } from "./imap.js";
import { imapAuth } from "./tools.js";
import type { Env } from "./env.js";

import { maskiere, ohnePerson, SHOP_ABSENDER } from "./maske.js";
const DATUM = /^\d{4}-\d{2}-\d{2}$/;

export class ShopRPC extends WorkerEntrypoint<Env & { SHOP_KONTO?: string }> {
  private async konto() {
    return resolveAccount(await loadAccounts(this.env), this.env.SHOP_KONTO || "gmail");
  }
  /** Umschläge der Shop-Mails seit `seit` (YYYY-MM-DD), neueste zuerst: uid, Datum, Absender-Domain, Betreff. */
  async suche(seit: string, max = 200): Promise<{ ordner: string; mails: { uid: number; datum: string | null; von: string; betreff: string }[] }> {
    if (!DATUM.test(seit)) throw new Error("Datum ungültig");
    return withImap(imapAuth(await this.konto()), async (c) => {
      const ordner = await c.allMailPath();
      const l = await c.searchFromAny(ordner, SHOP_ABSENDER, seit, Math.min(Math.max(1, max | 0), 300));
      return { ordner, mails: l.map((m) => ({ uid: m.uid, datum: m.date, von: String(m.from || "").replace(/^.*@/, "").replace(/>.*$/, "").toLowerCase(), betreff: maskiere(String(m.subject || ""), this.env.OWNER_EMAIL).slice(0, 200) })) };
    });
  }
  /** Text einer Mail (höchstens 5000 Zeichen), Adressen maskiert. */
  async text(ordner: string, uid: number): Promise<{ uid: number; datum: string | null; von: string; betreff: string; text: string }> {
    if (!Number.isInteger(uid) || uid <= 0) throw new Error("uid ungültig");
    return withImap(imapAuth(await this.konto()), async (c) => {
      const m = await c.getMessage(String(ordner || "INBOX"), uid);
      const roh = (m.bodyText || "").replace(/[ \t]+/g, " ").replace(/\s*\n\s*/g, "\n").slice(0, 5000);
      return { uid: m.uid, datum: m.date, von: String(m.from || "").replace(/^.*@/, "").replace(/>.*$/, "").toLowerCase(), betreff: maskiere(String(m.subject || ""), this.env.OWNER_EMAIL).slice(0, 200), text: maskiere(ohnePerson(roh), this.env.OWNER_EMAIL) };
    });
  }
}
