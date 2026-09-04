/**
 * Pure message-mapping helpers for the SMTP submission server (#120).
 *
 * Kept dependency-free (type-only import of `SendEmailInput`) so it can be
 * unit-tested without pulling in the SMTPServer / config / db stack — the
 * server code in `services/smtp-submission.service.ts` extracts raw
 * addresses from the parsed message + SMTP envelope and delegates the
 * shaping decisions (sender resolution, BCC preservation, To fallback) to
 * these functions.
 */

import type { SendEmailInput } from "../emails/types/email.types.ts";

/**
 * De-duplicates a list of addresses (case-insensitive, first-occurrence
 * wins) and joins them into the comma-separated form the `emails` table /
 * `SendEmailInput` expects. Empty / whitespace entries are dropped.
 */
export function dedupeJoin(addresses: string[]): string {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const raw of addresses) {
    const addr = raw?.trim();
    if (!addr) continue;
    const lower = addr.toLowerCase();
    if (seen.has(lower)) continue;
    seen.add(lower);
    out.push(addr);
  }
  return out.join(", ");
}

/** Raw address material extracted from a submitted message + envelope. */
export interface SubmissionMessageParts {
  /** Address from the parsed `From:` header, if any. */
  fromHeader?: string;
  /** Envelope `MAIL FROM` address, if any (fallback for the sender). */
  envelopeFrom?: string;
  /** Addresses parsed from the visible `To:` header. */
  toHeader: string[];
  /** Addresses parsed from the visible `Cc:` header. */
  ccHeader: string[];
  /** Envelope `RCPT TO` addresses (the actual delivery set). */
  envelopeRecipients: string[];
  subject?: string;
  html?: string;
  text?: string;
}

/**
 * Builds a `SendEmailInput` from a submitted message.
 *
 * - **Sender**: the `From:` header wins; otherwise the envelope `MAIL FROM`.
 *   Throws if neither is present.
 * - **To / Cc**: taken from the visible headers.
 * - **BCC preservation**: any envelope recipient not present in the visible
 *   To/Cc headers is a blind recipient → placed in `bcc` so it's delivered
 *   but never rendered in headers. Matches how a normal MTA treats BCC.
 * - **To fallback**: if the message carried no `To:` header (some clients
 *   put everything in the envelope), the non-BCC envelope recipients become
 *   the `to` field so the send still has a visible recipient.
 *
 * Throws if there is no resolvable sender or no recipients at all — the
 * caller maps these to an SMTP 550.
 */
export function buildSubmissionInput(parts: SubmissionMessageParts): SendEmailInput {
  const from = parts.fromHeader?.trim() || parts.envelopeFrom?.trim();
  if (!from) {
    throw new Error("Missing sender address (no From header or MAIL FROM)");
  }

  const to = dedupeJoin(parts.toHeader);
  const cc = dedupeJoin(parts.ccHeader);
  const hasVisibleHeader = Boolean(to || cc);

  /** Visible set = every address rendered in To/Cc, lowercased. */
  const visible = new Set(
    [to, cc]
      .filter(Boolean)
      .join(", ")
      .split(",")
      .map((a) => a.trim().toLowerCase())
      .filter(Boolean),
  );

  let toField: string;
  let bcc: string;

  if (hasVisibleHeader) {
    /**
     * With visible To/Cc headers, any envelope recipient NOT shown in them
     * is a blind recipient (BCC) — delivered but never rendered.
     */
    const bccAddrs = parts.envelopeRecipients.filter(
      (addr) => addr && !visible.has(addr.trim().toLowerCase()),
    );
    bcc = dedupeJoin(bccAddrs);
    /** Prefer the To header; a Cc-only message falls back to non-BCC envelope. */
    const nonBcc = parts.envelopeRecipients.filter((addr) => !bccAddrs.includes(addr));
    toField = to || dedupeJoin(nonBcc);
  } else {
    /**
     * No visible headers at all — we can't tell To from BCC, so treat every
     * envelope recipient as a (visible) To recipient rather than silently
     * turning them all into BCC.
     */
    toField = dedupeJoin(parts.envelopeRecipients);
    bcc = "";
  }

  if (!toField) {
    throw new Error("No recipients");
  }

  return {
    from,
    to: toField,
    cc: cc || undefined,
    bcc: bcc || undefined,
    subject: parts.subject ?? "",
    html: parts.html,
    text: parts.text,
  };
}

/** Result of {@link prepareRawForRelay}. */
export interface PreparedRawMessage {
  /** Message ready to be relayed byte-for-byte (CRLF, no `Bcc:` header). */
  raw: string;
  /** The `Message-ID` the message carries after preparation. */
  messageId: string;
}

/**
 * Prepares a client-submitted RFC 822 message for faithful relay
 * (mailbox submissions, docs/mailboxes.md):
 *
 * - **Drops any `Bcc:` header.** Mail clients strip it themselves, but a
 *   misbehaving one must not leak blind recipients to everyone else; the
 *   envelope recipients are tracked separately by the submission server.
 * - **Ensures a `Message-ID`.** Clients set one; if it is missing, the
 *   provided fallback is inserted so retries, bounces and the dashboard
 *   have a stable identifier.
 *
 * Header folding (continuation lines starting with whitespace) is
 * respected when removing `Bcc:`. Only the header block is touched.
 */
export function prepareRawForRelay(
  raw: string,
  fallbackMessageId: string,
): PreparedRawMessage {
  const separator = raw.indexOf("\r\n\r\n");
  const headerBlock = separator === -1 ? raw : raw.slice(0, separator);
  const body = separator === -1 ? "" : raw.slice(separator);

  const lines = headerBlock.split("\r\n");
  const kept: string[] = [];
  let dropping = false;
  let messageId: string | undefined;
  for (const line of lines) {
    const isContinuation = /^[ \t]/.test(line);
    if (isContinuation) {
      if (!dropping) kept.push(line);
      continue;
    }
    dropping = /^bcc:/i.test(line);
    if (dropping) continue;
    const m = /^message-id:\s*(.+)$/i.exec(line);
    if (m && m[1]) messageId = m[1].trim();
    kept.push(line);
  }

  if (!messageId) {
    messageId = fallbackMessageId;
    kept.push(`Message-ID: ${messageId}`);
  }

  return { raw: kept.join("\r\n") + (body || "\r\n\r\n"), messageId };
}
