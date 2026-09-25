/**
 * /setup -- Lukas pastes the accounts JSON once (from the old Render service's
 * ACCOUNTS_JSON), every mailbox is test-logged-in, and the JSON is stored
 * encrypted in KV. Behind Cloudflare Access (same application as /authorize);
 * the Worker checks the Access JWT itself as well.
 */
import { parseAccounts, publicSummaries, type Account } from "./accounts.js";
import { accessUser } from "./oauth.js";
import { googleAccessToken } from "./google.js";
import { withImap } from "./imap.js";
import { smtpVerify } from "./smtp.js";
import { loadAccountsJson, saveAccountsJson } from "./store.js";
import type { Env } from "./env.js";

interface Check {
  id: string;
  label: string;
  imap: string;
  send: string;
  ok: boolean;
}

const esc = (s: string) => s.replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" })[c]!);

async function check(acc: Account): Promise<Check> {
  const google = acc.google;
  let imap = "";
  let send = "";
  let ok = true;
  try {
    const n = await withImap(
      {
        host: acc.imap.host,
        port: acc.imap.port,
        user: acc.imap.user,
        pass: acc.imap.pass,
        tls: acc.imap.tls,
        accessTokenProvider: google && acc.imap.pass === "" ? () => googleAccessToken(google) : undefined,
      },
      async (c) => (await c.listMailboxes()).length
    );
    imap = `✓ angemeldet, ${n} Ordner`;
  } catch (e) {
    ok = false;
    imap = `✗ ${e instanceof Error ? e.message : String(e)}`;
  }
  try {
    if (google) {
      await googleAccessToken(google);
      send = "✓ über Gmail-API (Google-Zugang gültig)";
    } else if (acc.smtp) {
      await smtpVerify(acc.smtp);
      send = `✓ SMTP-Anmeldung bei ${acc.smtp.host} ok`;
    } else {
      send = "– kein SMTP eingetragen (nur lesen)";
    }
  } catch (e) {
    ok = false;
    send = `✗ ${e instanceof Error ? e.message : String(e)}`;
  }
  return { id: acc.id, label: acc.label, imap, send, ok };
}

/** One after the other: Workers allow only six open connections per request. */
async function checkAll(accounts: Account[]): Promise<Check[]> {
  const out: Check[] = [];
  for (const a of accounts) out.push(await check(a));
  return out;
}

function page(opts: { status: string; checks?: Check[]; error?: string; saved?: boolean }): string {
  const rows = (opts.checks ?? [])
    .map((c) => `<tr class="${c.ok ? "ok" : "bad"}"><td><b>${esc(c.label)}</b><br><small>${esc(c.id)}</small></td><td>${esc(c.imap)}</td><td>${esc(c.send)}</td></tr>`)
    .join("");
  return `<!doctype html><html lang="de"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>Mail-Connector einrichten</title><meta name="robots" content="noindex">
<style>body{margin:0;background:#070F12;color:#EAF4F2;font:16px/1.55 "IBM Plex Sans",system-ui,sans-serif}main{max-width:760px;margin:0 auto;padding:28px 18px}
h1{font-size:24px;margin:0 0 6px}p,li{color:#9DB8BC}b{color:#EAF4F2}ol{padding-left:20px}a{color:#3FD9BC}
textarea{width:100%;min-height:200px;box-sizing:border-box;font:13px ui-monospace,monospace;padding:12px;border-radius:12px;border:1px solid #27505A;background:#10262C;color:#EAF4F2}
button{font:inherit;font-weight:600;padding:14px 18px;border-radius:12px;border:0;background:#3FD9BC;color:#070F12;margin-top:12px;cursor:pointer}
table{width:100%;border-collapse:collapse;margin:16px 0;font-size:14px}td{padding:10px 8px;border-bottom:1px solid #27505A;vertical-align:top}tr.ok td:first-child{border-left:3px solid #3FD9BC}tr.bad td:first-child{border-left:3px solid #F09044}
.m{color:#F09044}.s{color:#3FD9BC}code{background:#10262C;padding:1px 5px;border-radius:6px}</style></head><body><main>
<h1>Mail-Connector einrichten</h1><p>${esc(opts.status)}</p>
${opts.saved ? `<p class="s"><b>Gespeichert.</b> Claude nutzt ab sofort diese Postfächer.</p>` : ""}
${opts.error ? `<p class="m">${esc(opts.error)}</p>` : ""}
${rows ? `<table><tr><td>Postfach</td><td>Lesen (IMAP)</td><td>Senden</td></tr>${rows}</table>` : ""}
<h2 style="font-size:18px">Postfächer übernehmen</h2>
<ol><li>Öffne <a href="https://dashboard.render.com" target="_blank" rel="noopener">dashboard.render.com</a> → Dienst <b>mail-mcp-oauth</b> → links <b>Environment</b>.</li>
<li>Bei <code>ACCOUNTS_JSON</code> auf das Auge tippen, den ganzen Wert markieren und kopieren.</li>
<li>Hier einfügen und auf <b>Prüfen und speichern</b> tippen. Jedes Postfach wird sofort testweise angemeldet (es wird nichts verschickt).</li></ol>
<form method="post" action="/setup"><textarea name="accounts" placeholder='{"version":1,"accounts":[...]}' required></textarea><button>Prüfen und speichern</button></form>
<p><small>Gespeichert wird verschlüsselt. Diese Seite sieht nur, wer sich mit 00thies@gmail.com bei Cloudflare angemeldet hat.</small></p>
</main></body></html>`;
}

function html(body: string, status = 200): Response {
  return new Response(body, { status, headers: { "Content-Type": "text/html; charset=utf-8", "Cache-Control": "no-store" } });
}

export async function routeSetup(request: Request, env: Env): Promise<Response | null> {
  const url = new URL(request.url);
  if (url.pathname !== "/setup") return null;
  if (!(await accessUser(request, env))) return html("<p>Nur über die Cloudflare-Anmeldung erreichbar.</p>", 403);

  if (request.method === "GET") {
    const cur = await loadAccountsJson(env);
    let status: string;
    let checks: Check[] | undefined;
    try {
      const accounts = parseAccounts(cur.json);
      status =
        cur.source === "setup"
          ? `${accounts.length} Postfächer gespeichert (${cur.savedAt?.slice(0, 16).replace("T", " ")} UTC).`
          : cur.source === "secret"
            ? `Noch nichts gespeichert. Aktuell ist nur ein Test-Eintrag hinterlegt: ${publicSummaries(accounts).map((a) => a.id).join(", ")}.`
            : "Noch keine Postfächer hinterlegt.";
      if (url.searchParams.has("check")) checks = await checkAll(accounts);
    } catch (e) {
      status = `Gespeicherte Postfächer sind fehlerhaft: ${e instanceof Error ? e.message : e}`;
    }
    return html(page({ status, checks }));
  }

  if (request.method === "POST") {
    // Same-origin form post only (Access cookie + CSRF).
    const origin = request.headers.get("Origin");
    if (origin && origin !== new URL(env.PUBLIC_URL).origin) return html("<p>Ungültige Herkunft.</p>", 403);
    const form = await request.formData();
    const raw = String(form.get("accounts") ?? "").trim();
    let accounts: Account[];
    try {
      accounts = parseAccounts(raw);
      if (accounts.length === 0) throw new Error("Die Liste enthält kein Postfach.");
    } catch (e) {
      return html(page({ status: "Nicht gespeichert.", error: e instanceof Error ? e.message : String(e) }), 400);
    }
    const checks = await checkAll(accounts);
    // Saved even if a single mailbox fails its test: the others work, and the table says what to fix.
    await saveAccountsJson(env, JSON.stringify({ version: 1, accounts: JSON.parse(raw).accounts }));
    return html(page({ status: `${accounts.length} Postfächer geprüft.`, checks, saved: true }));
  }
  return html("<p>Methode nicht erlaubt.</p>", 405);
}
