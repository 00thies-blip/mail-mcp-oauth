/** Adress-Maske und Absenderliste für ShopRPC (src/shop.ts), ohne Worker-Laufzeit testbar. */
export const SHOP_ABSENDER = ["digistore24", "etsy.com", "payhip.com", "gumroad.com", "lemonsqueezy", "stripe.com"];
const EIGEN = /(@(gmail\.com|setfairstudio\.com|expatandalucia\.com|automateandgo\.com|sendarodigital\.com|lukasthies\.com|crazycaracal\.com)$)/i;

/** Mailadressen ersetzen: eigene (Lukas, seine Marken) als „[eigen]“, alle anderen als „[kunde]“. */
export function maskiere(text: string, owner = ""): string {
  return text.replace(/[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}/g, (a) => {
    const l = a.toLowerCase();
    if (owner && l === owner.toLowerCase()) return "[eigen]";
    return EIGEN.test(l) && !l.endsWith("@gmail.com") ? "[eigen]" : "[kunde]";
  });
}

