/**
 * The ten mail tools -- same names, parameters and descriptions as the Render
 * version (src/tools-mail.ts at the repo root), so Claude.ai sees no change
 * beyond the connector URL.
 */
import { z } from "zod";
import { publicSummaries, resolveAccount, type Account } from "./accounts.js";
import { loadAccounts } from "./store.js";
import { googleAccessToken, gmailSend } from "./google.js";
import { withImap, type ImapAuth } from "./imap.js";
import { buildMessage, type OutgoingMessage } from "./mime.js";
import { smtpSend } from "./smtp.js";
import type { Env } from "./env.js";

export interface ToolResult {
  content: Array<{ type: "text"; text: string }>;
  isError?: boolean;
}

export interface ToolDef {
  name: string;
  description: string;
  inputSchema: z.ZodObject<z.ZodRawShape>;
  annotations?: { readOnlyHint?: boolean; destructiveHint?: boolean; idempotentHint?: boolean; openWorldHint?: boolean };
  handler: (args: Record<string, unknown>, env: Env) => Promise<ToolResult>;
}

function asJson(value: unknown): ToolResult {
  return { content: [{ type: "text", text: JSON.stringify(value, null, 2) }] };
}

function imapAuth(acc: Account): ImapAuth {
  const google = acc.google;
  return {
    host: acc.imap.host,
    port: acc.imap.port,
    user: acc.imap.user,
    pass: acc.imap.pass,
    tls: acc.imap.tls,
    accessTokenProvider: google && acc.imap.pass === "" ? () => googleAccessToken(google) : undefined,
  };
}

async function account(env: Env, id: unknown): Promise<Account> {
  return resolveAccount(await loadAccounts(env), typeof id === "string" && id ? id : undefined);
}

const recipientSchema = z.union([z.string(), z.array(z.string()).min(1)]);
const accountSchema = z.string().optional().describe("Account ID (from list_accounts) to act on. Omit to use the default account.");

type Args = Record<string, unknown>;

function outgoing(a: Args): OutgoingMessage {
  return {
    to: a.to as string | string[],
    cc: a.cc as string | string[] | undefined,
    bcc: a.bcc as string | string[] | undefined,
    subject: a.subject as string,
    text: a.text as string | undefined,
    html: a.html as string | undefined,
    replyTo: a.reply_to as string | undefined,
    inReplyTo: a.in_reply_to as string | undefined,
    references: a.references as string[] | undefined,
    attachments: (a.attachments as Array<{ filename: string; content_base64: string; content_type?: string }> | undefined)?.map((x) => ({
      filename: x.filename,
      contentBase64: x.content_base64,
      contentType: x.content_type,
    })),
  };
}

export const TOOLS: ToolDef[] = [
  {
    name: "list_accounts",
    description:
      "List all configured mailbox accounts on this connector. Returns id, label, default flag and From-address — never credentials. Use the `id` value as the `account` parameter on other tools.",
    inputSchema: z.object({}),
    annotations: { readOnlyHint: true },
    handler: async (_a, env) => {
      const summaries = publicSummaries(await loadAccounts(env));
      return asJson({ count: summaries.length, accounts: summaries });
    },
  },
  {
    name: "list_folders",
    description:
      "List all IMAP mailboxes (folders) on the configured account. Returns path, name, flags and special-use attribute (e.g. \\Sent, \\Drafts, \\Trash) — useful for picking the right `mailbox` parameter for other tools.",
    inputSchema: z.object({ account: accountSchema }),
    annotations: { readOnlyHint: true },
    handler: async (a, env) => asJson(await withImap(imapAuth(await account(env, a.account)), (c) => c.listMailboxes())),
  },
  {
    name: "list_messages",
    description: "List the newest messages in a mailbox (newest first). Returns headers + a short preview, NOT the full body — use get_message for the body.",
    inputSchema: z.object({
      mailbox: z.string().describe("IMAP folder path (e.g. 'INBOX', 'Sent', 'Archive/2026')"),
      limit: z.number().int().min(1).max(200).optional().describe("Max messages to return (default 25)"),
      unread_only: z.boolean().optional().describe("Return only unread messages"),
      account: accountSchema,
    }),
    annotations: { readOnlyHint: true },
    handler: async (a, env) => {
      const mailbox = a.mailbox as string;
      const list = await withImap(imapAuth(await account(env, a.account)), (c) =>
        c.listMessages(mailbox, { limit: a.limit as number | undefined, unreadOnly: a.unread_only as boolean | undefined })
      );
      return asJson({ mailbox, account: (a.account as string) ?? "(default)", count: list.length, messages: list });
    },
  },
  {
    name: "search_messages",
    description:
      "Server-side IMAP SEARCH across one mailbox. Combine any criteria (AND-style). Dates must be ISO YYYY-MM-DD. Returns headers + short preview — use get_message for the body.",
    inputSchema: z.object({
      mailbox: z.string().describe("IMAP folder path to search in"),
      from: z.string().optional().describe("Substring match in From: header"),
      to: z.string().optional().describe("Substring match in To: header"),
      subject: z.string().optional().describe("Substring match in Subject:"),
      body: z.string().optional().describe("Substring match in the message body"),
      since: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional().describe("Match messages on/after this date (YYYY-MM-DD)"),
      before: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional().describe("Match messages strictly before this date (YYYY-MM-DD)"),
      unread: z.boolean().optional().describe("true = unread only, false = read only"),
      flagged: z.boolean().optional().describe("true = flagged only, false = unflagged only"),
      limit: z.number().int().min(1).max(200).optional(),
      account: accountSchema,
    }),
    annotations: { readOnlyHint: true },
    handler: async (a, env) => {
      const { mailbox, limit, account: acc, ...criteria } = a as Args & { mailbox: string; limit?: number; account?: string };
      const list = await withImap(imapAuth(await account(env, acc)), (c) => c.searchMessages(mailbox, criteria, limit ?? 25));
      return asJson({ mailbox, account: acc ?? "(default)", count: list.length, messages: list });
    },
  },
  {
    name: "get_message",
    description:
      "Fetch one message by UID. Returns headers, full text+HTML body, attachment metadata (filenames + content types, NOT raw bytes), and threading IDs (Message-ID, In-Reply-To, References) for replies.",
    inputSchema: z.object({
      mailbox: z.string().describe("IMAP folder the message lives in"),
      uid: z.number().int().positive().describe("Message UID as returned by list_messages/search_messages"),
      account: accountSchema,
    }),
    annotations: { readOnlyHint: true },
    handler: async (a, env) => asJson(await withImap(imapAuth(await account(env, a.account)), (c) => c.getMessage(a.mailbox as string, a.uid as number))),
  },
  {
    name: "send_message",
    description:
      "Send an email via SMTP. WRITE OPERATION — the message goes out immediately. Use create_draft instead if you want to review before sending. Saves a copy in the Sent folder if configured. For replies, pass in_reply_to + references from the original get_message result.",
    inputSchema: z.object({
      to: recipientSchema.describe("Recipient(s). String or array of email addresses."),
      subject: z.string().min(1).describe("Subject line"),
      text: z.string().optional().describe("Plain-text body"),
      html: z.string().optional().describe("HTML body"),
      cc: recipientSchema.optional(),
      bcc: recipientSchema.optional(),
      reply_to: z.string().optional().describe("Reply-To header"),
      in_reply_to: z.string().optional().describe("Message-ID being replied to (for threading)"),
      references: z.array(z.string()).optional().describe("References header values (for threading)"),
      attachments: z.array(z.object({ filename: z.string(), content_base64: z.string(), content_type: z.string().optional() })).optional(),
      account: accountSchema,
    }),
    annotations: { destructiveHint: false, openWorldHint: true },
    handler: async (a, env) => {
      const acc = await account(env, a.account);
      const built = buildMessage(outgoing(a), { email: acc.mail.defaultFrom, name: acc.mail.defaultFromName });
      let result: Record<string, unknown>;
      // A mailbox with its own SMTP password sends via SMTP (for Gmail: smtp.gmail.com + app password),
      // so it never depends on the Google OAuth grant; the Gmail API is only for Workspace without passwords.
      const viaApi = Boolean(acc.google) && !acc.smtp?.pass;
      if (viaApi && acc.google) {
        result = { ...(await gmailSend(acc.google, built.raw)), accepted: built.recipients, rejected: [] };
      } else if (acc.smtp) {
        result = { ...(await smtpSend(acc.smtp, built.envelopeFrom, built.recipients, built.raw, built.messageId)) };
      } else {
        throw new Error(`Account "${acc.id}" has no smtp block in ACCOUNTS_JSON -- sending is not configured for it.`);
      }
      // Gmail files sent mail in Sent by itself (API and smtp.gmail.com); everything else gets a best-effort copy.
      const gmailFiles = viaApi || /(^|\.)gmail\.com$|googlemail\.com$/i.test(acc.smtp?.host ?? "");
      let savedToSent = gmailFiles;
      if (!gmailFiles && acc.mail.sentFolder) {
        try {
          await withImap(imapAuth(acc), (c) => c.append(acc.mail.sentFolder!, built.raw, ["\\Seen"]));
          savedToSent = true;
        } catch {
          // the message itself is already sent
        }
      }
      return asJson({ ...result, saved_to_sent: savedToSent });
    },
  },
  {
    name: "create_draft",
    description:
      "Build an RFC-822 message and APPEND it to the Drafts folder. Does NOT send. Use for compose-and-review flows where the user wants to edit in their mail client before sending.",
    inputSchema: z.object({
      to: recipientSchema,
      subject: z.string().min(1),
      text: z.string().optional(),
      html: z.string().optional(),
      cc: recipientSchema.optional(),
      bcc: recipientSchema.optional(),
      in_reply_to: z.string().optional(),
      references: z.array(z.string()).optional(),
      account: accountSchema,
    }),
    annotations: { destructiveHint: false },
    handler: async (a, env) => {
      const acc = await account(env, a.account);
      const built = buildMessage(outgoing(a), { email: acc.mail.defaultFrom, name: acc.mail.defaultFromName });
      await withImap(imapAuth(acc), (c) => c.append(acc.mail.draftsFolder, built.raw, ["\\Draft", "\\Seen"]));
      return asJson({ success: true, folder: acc.mail.draftsFolder, bytes: built.raw.length });
    },
  },
  {
    name: "mark_read",
    description: "Set or clear the \\Seen flag on a message. WRITE OPERATION but easily reversible.",
    inputSchema: z.object({
      mailbox: z.string(),
      uid: z.number().int().positive(),
      read: z.boolean().describe("true = mark as read, false = mark unread"),
      account: accountSchema,
    }),
    annotations: { idempotentHint: true, destructiveHint: false },
    handler: async (a, env) => {
      await withImap(imapAuth(await account(env, a.account)), (c) => c.markRead(a.mailbox as string, a.uid as number, a.read as boolean));
      return asJson({ success: true, mailbox: a.mailbox, uid: a.uid, read: a.read });
    },
  },
  {
    name: "move_message",
    description: "Move a message from one mailbox to another (e.g. Inbox → Archive). WRITE OPERATION.",
    inputSchema: z.object({
      source_mailbox: z.string(),
      uid: z.number().int().positive(),
      destination_mailbox: z.string(),
      account: accountSchema,
    }),
    annotations: { destructiveHint: false },
    handler: async (a, env) => {
      await withImap(imapAuth(await account(env, a.account)), (c) => c.moveMessage(a.source_mailbox as string, a.uid as number, a.destination_mailbox as string));
      return asJson({ success: true, from: a.source_mailbox, to: a.destination_mailbox, uid: a.uid });
    },
  },
  {
    name: "delete_message",
    description:
      "Delete a message. DESTRUCTIVE — most IMAP servers move it to Trash but some EXPUNGE immediately. Prefer move_message to a Trash folder for reversibility.",
    inputSchema: z.object({ mailbox: z.string(), uid: z.number().int().positive(), account: accountSchema }),
    annotations: { destructiveHint: true },
    handler: async (a, env) => {
      await withImap(imapAuth(await account(env, a.account)), (c) => c.deleteMessage(a.mailbox as string, a.uid as number));
      return asJson({ success: true, mailbox: a.mailbox, uid: a.uid });
    },
  },
];
