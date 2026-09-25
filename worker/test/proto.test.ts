import { describe, expect, it } from "vitest";
import {
  completeResponseLength,
  decodeMailboxName,
  decodePartPreview,
  decodeWords,
  encodeMailboxName,
  fetchMap,
  findTextPart,
  parseEnvelope,
  parseInternalDate,
  parseResponse,
  type ImapValue,
} from "../src/imap-proto.js";
import { buildMessage, parseAddresses } from "../src/mime.js";
import { dotStuff } from "../src/smtp.js";

const b = (s: string) => new TextEncoder().encode(s);

describe("response framing", () => {
  it("waits for a complete line", () => {
    expect(completeResponseLength(b("* OK hello"))).toBe(-1);
    expect(completeResponseLength(b("* OK hello\r\n* 3 EXISTS\r\n"))).toBe(12);
  });
  it("includes announced literals", () => {
    const msg = "* 1 FETCH (UID 7 BODY[] {5}\r\nHello)\r\n";
    expect(completeResponseLength(b(msg.slice(0, 30)))).toBe(-1);
    expect(completeResponseLength(b(msg))).toBe(msg.length);
  });
  it("handles literals that contain CRLF and several literals", () => {
    const msg = "* 2 FETCH (BODY[HEADER] {8}\r\nA: 1\r\n\r\n BODY[1] {3}\r\nabc)\r\n";
    expect(completeResponseLength(b(msg + "* OK"))).toBe(msg.length);
  });
});

describe("parser", () => {
  it("status with response code", () => {
    const r = parseResponse(b("* OK [CAPABILITY IMAP4rev1 SASL-IR AUTH=PLAIN] Dovecot ready.\r\n"));
    expect(r).toMatchObject({ kind: "status", tag: "*", status: "OK", code: "CAPABILITY IMAP4rev1 SASL-IR AUTH=PLAIN", text: "Dovecot ready." });
  });
  it("tagged NO", () => {
    expect(parseResponse(b("A3 NO [AUTHENTICATIONFAILED] Invalid credentials (Failure)\r\n"))).toMatchObject({ tag: "A3", status: "NO", code: "AUTHENTICATIONFAILED" });
  });
  it("LIST with quoted, NIL and flags", () => {
    const r = parseResponse(b('* LIST (\\HasNoChildren \\Sent) "/" "[Gmail]/Gesendet"\r\n'));
    expect(r).toEqual({ kind: "data", tokens: ["LIST", ["\\HasNoChildren", "\\Sent"], "/", "[Gmail]/Gesendet"] });
    const n = parseResponse(b("* LIST (\\Noselect) NIL \"\"\r\n"));
    expect(n).toEqual({ kind: "data", tokens: ["LIST", ["\\Noselect"], null, ""] });
  });
  it("FETCH with bracketed keys and literal", () => {
    const r = parseResponse(b('* 12 FETCH (UID 345 FLAGS (\\Seen) BODY[HEADER.FIELDS (DATE FROM)]<0> {8}\r\nDate: x\n)\r\n'));
    expect(r.kind).toBe("data");
    const tokens = (r as { tokens: ImapValue[] }).tokens;
    const m = fetchMap(tokens[2] as ImapValue[]);
    expect(m.get("UID")).toBe("345");
    expect(m.get("FLAGS")).toEqual(["\\Seen"]);
    expect(new TextDecoder().decode(m.get("BODY[HEADER.FIELDS (DATE FROM)]<0>") as Uint8Array)).toBe("Date: x\n");
  });
  it("quoted strings with escapes", () => {
    const r = parseResponse(b('* LIST () "." "a \\"b\\" \\\\c"\r\n')) as { tokens: ImapValue[] };
    expect(r.tokens[3]).toBe('a "b" \\c');
  });
  it("continuation", () => {
    expect(parseResponse(b("+ Ready for literal\r\n"))).toEqual({ kind: "continuation", text: "Ready for literal" });
  });
});

describe("envelope and bodystructure", () => {
  it("parses an ENVELOPE with encoded words", () => {
    const r = parseResponse(
      b(
        '* 1 FETCH (ENVELOPE ("Thu, 25 Sep 2026 10:35:58 +0200 (CEST)" "=?UTF-8?B?R3LDvMOfZQ==?= aus Jerez" (("Lukas Thies" NIL "info" "automateandgo.com")) NIL NIL ((NIL NIL "00thies" "gmail.com")("=?ISO-8859-1?Q?J=FCrgen?=" NIL "j" "x.de")) NIL NIL NIL "<abc@x>"))\r\n'
      )
    ) as { tokens: ImapValue[] };
    const env = parseEnvelope(fetchMap(r.tokens[2] as ImapValue[]).get("ENVELOPE"));
    expect(env).toEqual({
      date: "2026-09-25T08:35:58.000Z",
      subject: "Grüße aus Jerez",
      from: "Lukas Thies <info@automateandgo.com>",
      to: "00thies@gmail.com, Jürgen <j@x.de>",
      cc: null,
      inReplyTo: null,
      messageId: "<abc@x>",
    });
  });
  it("finds text/plain inside multipart/mixed > multipart/alternative", () => {
    const r = parseResponse(
      b(
        '* 1 FETCH (BODYSTRUCTURE ((("TEXT" "PLAIN" ("CHARSET" "ISO-8859-1") NIL NIL "QUOTED-PRINTABLE" 20 1 NIL NIL NIL)("TEXT" "HTML" ("CHARSET" "UTF-8") NIL NIL "BASE64" 40 1 NIL NIL NIL) "ALTERNATIVE" ("BOUNDARY" "x") NIL NIL)("APPLICATION" "PDF" ("NAME" "a.pdf") NIL NIL "BASE64" 100 NIL NIL NIL) "MIXED" ("BOUNDARY" "y") NIL NIL))\r\n'
      )
    ) as { tokens: ImapValue[] };
    const part = findTextPart(fetchMap(r.tokens[2] as ImapValue[]).get("BODYSTRUCTURE"));
    expect(part).toEqual({ path: "1.1", subtype: "plain", encoding: "quoted-printable", charset: "iso-8859-1" });
    expect(decodePartPreview(b("Gr=FC=DFe =\r\naus Jerez"), part!)).toBe("Grüße aus Jerez");
  });
  it("single-part html, truncated base64", () => {
    const r = parseResponse(b('* 1 FETCH (BODYSTRUCTURE ("TEXT" "HTML" ("CHARSET" "utf-8") NIL NIL "BASE64" 99 2 NIL NIL NIL NIL))\r\n')) as { tokens: ImapValue[] };
    const part = findTextPart(fetchMap(r.tokens[2] as ImapValue[]).get("BODYSTRUCTURE"))!;
    expect(part.path).toBe("1");
    const html = btoa("<p>Hallo <b>Welt</b> &amp; mehr</p>");
    expect(decodePartPreview(b(html.slice(0, 30)), part)).toMatch(/^Hallo W/);
    expect(decodePartPreview(b(html), part)).toBe("Hallo Welt & mehr");
  });
  it("internal date", () => {
    expect(parseInternalDate(" 5-Sep-2026 10:35:58 +0000")).toBe("2026-09-05T10:35:58.000Z");
  });
  it("decodes adjacent encoded words without the space between", () => {
    expect(decodeWords("=?UTF-8?Q?Gr=C3=BC?= =?UTF-8?Q?=C3=9Fe?=")).toBe("Grüße");
  });
});

describe("mailbox names (modified UTF-7)", () => {
  it("round-trips umlauts and &", () => {
    for (const name of ["INBOX", "Entwürfe", "Gesendete Objekte", "A&B", "日本語", "INBOX/Rechnungen 2026"]) {
      expect(decodeMailboxName(encodeMailboxName(name))).toBe(name);
    }
    expect(encodeMailboxName("Entwürfe")).toBe("Entw&APw-rfe");
  });
});

describe("mime builder", () => {
  it("parses address forms", () => {
    expect(parseAddresses(['Lukas Thies <a@b.de>, "Doe, John" <j@d.com>', "x@y.z"])).toEqual([
      { name: "Lukas Thies", email: "a@b.de" },
      { name: "Doe, John", email: "j@d.com" },
      { email: "x@y.z" },
    ]);
    expect(() => parseAddresses("kein-mail")).toThrow();
  });
  it("builds 7-bit mail with alternative + attachment and bcc only in the envelope", async () => {
    const m = buildMessage(
      {
        to: "Jürgen <j@x.de>",
        bcc: "geheim@x.de",
        subject: "Grüße – Angebot",
        text: "Hallo Jürgen,\nanbei das Angebot.",
        html: "<p>Hallo Jürgen</p>",
        inReplyTo: "<a@b>",
        references: ["<a@b>"],
        attachments: [{ filename: "Angebot März.pdf", contentBase64: btoa("%PDF-1.4"), contentType: "application/pdf" }],
      },
      { email: "info@automateandgo.com", name: "AutomateAndGo" },
      new Date("2026-09-25T10:00:00Z")
    );
    const raw = new TextDecoder().decode(m.raw);
    expect(/^[\x00-\x7f]*$/.test(raw)).toBe(true);
    expect(raw).toContain("From: AutomateAndGo <info@automateandgo.com>");
    expect(raw).toContain("To: =?UTF-8?B?");
    expect(raw).not.toMatch(/^Bcc:/m);
    expect(raw).toContain("In-Reply-To: <a@b>");
    expect(raw).toContain("multipart/mixed");
    expect(raw).toContain("multipart/alternative");
    expect(raw).toContain("filename*=UTF-8''Angebot%20M%C3%A4rz.pdf");
    expect(raw).toContain("Date: Fri, 25 Sep 2026 10:00:00 +0000");
    expect(m.recipients).toEqual(["j@x.de", "geheim@x.de"]);
    // Round-trip through the parser that get_message uses.
    const PostalMime = (await import("postal-mime")).default;
    const p = await PostalMime.parse(m.raw);
    expect(p.subject).toBe("Grüße – Angebot");
    expect(p.text?.replace(/\r\n/g, "\n").trim()).toBe("Hallo Jürgen,\nanbei das Angebot.");
    expect(p.to?.[0]).toMatchObject({ name: "Jürgen", address: "j@x.de" });
    expect(p.attachments[0]?.filename).toBe("Angebot März.pdf");
  });
  it("dot-stuffs lines starting with a dot and terminates DATA", () => {
    expect(new TextDecoder().decode(dotStuff(b("a\n.b\n..c")))).toBe("a\r\n..b\r\n...c\r\n.\r\n");
  });
});
