/** Adress-Maske und Absenderliste für ShopRPC (src/shop.ts), ohne Worker-Laufzeit testbar. */
export const SHOP_ABSENDER = ["digistore24", "etsy.com", "payhip.com", "gumroad.com"];
const EIGEN = /(@(gmail\.com|setfairstudio\.com|expatandalucia\.com|automateandgo\.com|sendarodigital\.com|lukasthies\.com|crazycaracal\.com)$)/i;

/** Mailadressen ersetzen: eigene (Lukas, seine Marken) als „[eigen]“, alle anderen als „[kunde]“. */
export function maskiere(text: string, owner = ""): string {
  return text.replace(/[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}/g, (a) => {
    const l = a.toLowerCase();
    if (owner && l === owner.toLowerCase()) return "[eigen]";
    return EIGEN.test(l) && !l.endsWith("@gmail.com") ? "[eigen]" : "[kunde]";
  });
}


/** Personenangaben aus Shop-Mails entfernen: Namens-, Adress-, Telefon- und Lizenzzeilen, IBANs. Adressen maskiert maskiere(). */
export function ohnePerson(text: string): string {
  return text
    .split("\n")
    .filter((z) => !/^\s*(Vorname|Nachname|Name|Firma|Company|Adresse|Address|Anschrift|Stra(ß|ss)e|PLZ|Ort|Telefon|Phone|Lizenzschl|\d+\. Lizenzschl)/i.test(z))
    .join("\n")
    .replace(/\b[A-Z]{2}\d{2}(?: ?[A-Z0-9]{4}){3,7}(?: ?[A-Z0-9]{1,4})?\b/g, "[iban]");
}
