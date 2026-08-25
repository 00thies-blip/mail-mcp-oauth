/**
 * Per-account client pool.
 *
 * Holds one ImapClient + SmtpClient (+ optional GmailApiClient) per
 * account, lazy-initialized on first use. When accounts change the entire
 * pool is dropped and rebuilt on next request — simpler than diffing
 * per-field credential changes, and IMAP reconnects are cheap (~one TLS
 * handshake).
 */

import { ImapClient } from "./imap-client.js";
import { SmtpClient } from "./smtp-client.js";
import { GmailApiClient } from "./gmail-client.js";
import { getGoogleAccessToken } from "./google-oauth.js";
import { Account, AccountsStore } from "./accounts.js";

interface AccountClients {
  imap: ImapClient;
  smtp: SmtpClient;
  /** Set for Google-hosted mailboxes — send_message prefers this over Brevo/direct SMTP. */
  gmailApi: GmailApiClient | null;
  draftsFolder: string;
  sentFolder: string | null;
}

export class ClientPool {
  private readonly store: AccountsStore;
  private pool: Map<string, AccountClients> = new Map();

  constructor(store: AccountsStore) {
    this.store = store;
  }

  /**
   * Resolve the requested account ID (or default if omitted) and return its
   * client pair. Lazy-initializes the underlying connections on first use.
   */
  for(accountId?: string): AccountClients {
    const account = this.store.resolve(accountId);
    const existing = this.pool.get(account.id);
    if (existing) return existing;
    const clients = this.build(account);
    this.pool.set(account.id, clients);
    return clients;
  }

  /**
   * Drop and close all cached clients — call this when accounts change so
   * the next request rebuilds with fresh credentials.
   */
  async resetAll(): Promise<void> {
    const old = Array.from(this.pool.values());
    this.pool.clear();
    await Promise.all(old.map((c) => c.imap.close().catch(() => {})));
  }

  /** Shutdown: close every IMAP connection. */
  async closeAll(): Promise<void> {
    await this.resetAll();
  }

  private build(account: Account): AccountClients {
    const google = account.google;
    const imap = new ImapClient({
      host: account.imap.host,
      port: account.imap.port,
      user: account.imap.user,
      pass: account.imap.pass,
      secure: account.imap.tls,
      // Empty imap.pass + a google block = Workspace account with app
      // passwords disabled; authenticate IMAP via XOAUTH2 instead.
      accessTokenProvider:
        google && account.imap.pass === ""
          ? () => getGoogleAccessToken(google)
          : undefined,
    });
    const smtp = new SmtpClient(
      {
        host: account.smtp.host,
        port: account.smtp.port,
        user: account.smtp.user,
        pass: account.smtp.pass,
        secure: account.smtp.tls,
      },
      {
        from: account.mail.defaultFrom,
        fromName: account.mail.defaultFromName || undefined,
      }
    );
    // smtp is still built even when using Gmail API to send — its
    // buildRawSource() (pure local MIME composition, no network) is reused
    // by both the Gmail API path and the Sent-folder-copy step.
    const gmailApi = google ? new GmailApiClient(google, smtp) : null;
    return {
      imap,
      smtp,
      gmailApi,
      draftsFolder: account.mail.draftsFolder,
      sentFolder: account.mail.sentFolder,
    };
  }
}
