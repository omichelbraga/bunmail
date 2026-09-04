import nodemailer from "nodemailer";
import { config } from "../../../config.ts";
import { logger } from "../../../utils/logger.ts";
import { redactEmail } from "../../../utils/redact.ts";

/**
 * LMTP delivery to Dovecot.
 *
 * BunMail's inbound SMTP receiver stays the MX edge. When a message is
 * addressed to one or more enabled mailboxes, the receiver hands the raw
 * RFC 822 bytes to Dovecot over LMTP (RFC 2033) on the private Docker
 * network *before* running its own processing. LMTP answers per recipient,
 * so a full mailbox rejects only that recipient.
 *
 * Reuses Nodemailer (already a BunMail dependency) in LMTP mode — no new
 * protocol client to maintain.
 */

export interface LmtpDeliveryResult {
  /** Recipients Dovecot accepted (`250`). */
  accepted: string[];
  /** Recipients Dovecot refused, with the raw response line. */
  rejected: { recipient: string; response: string }[];
}

/** Error carrying an SMTP status code the receiver can relay to the sender. */
export class LmtpDeliveryError extends Error {
  constructor(
    message: string,
    /** 4xx = temporary (sender retries), 5xx = permanent. */
    public readonly responseCode: number,
  ) {
    super(message);
    this.name = "LmtpDeliveryError";
  }
}

/** Shape of the per-recipient errors Nodemailer attaches in LMTP mode. */
interface RecipientError extends Error {
  recipients?: string[];
  response?: string;
}

/** Type guard for {@link RecipientError} (Nodemailer types it as `unknown`). */
function isRecipientError(value: unknown): value is RecipientError {
  return value instanceof Error;
}

/**
 * Delivers `raw` to the given mailbox addresses via LMTP.
 *
 * Resolves with per-recipient outcomes when the LMTP session completed
 * (some recipients may still be rejected — e.g. over quota). Throws
 * `LmtpDeliveryError(451)` when Dovecot is unreachable or the session
 * fails outright, so the caller can return a temporary failure and let
 * the upstream MTA retry instead of losing the message.
 */
export async function deliverToMailboxes(
  raw: string | Buffer,
  envelopeFrom: string,
  recipients: string[],
): Promise<LmtpDeliveryResult> {
  const { host, port } = config.mailboxes.lmtp;

  const transport = nodemailer.createTransport({
    host,
    port,
    lmtp: true,
    secure: false,
    /** Private Docker network — Dovecot's LMTP listener has no TLS. */
    ignoreTLS: true,
    name: config.mail.hostname,
    connectionTimeout: 10_000,
    greetingTimeout: 10_000,
    socketTimeout: 60_000,
  });

  try {
    const info = await transport.sendMail({
      envelope: { from: envelopeFrom, to: recipients },
      raw,
    });

    /**
     * Nodemailer reports LMTP per-recipient results: `accepted` and
     * `rejected` (addresses) plus `rejectedErrors` (the responses).
     */
    const accepted = (info.accepted ?? []).map(String);
    const rejectedErrors =
      "rejectedErrors" in info && Array.isArray(info.rejectedErrors)
        ? info.rejectedErrors.filter(isRecipientError)
        : [];
    const rejected = (info.rejected ?? []).map((r) => {
      const address = String(r);
      const err = rejectedErrors.find((e) => e.recipients?.includes(address));
      return {
        recipient: address,
        response: err?.response ?? err?.message ?? "rejected",
      };
    });

    logger.info("LMTP delivery completed", {
      host,
      accepted: accepted.map(redactEmail),
      rejected: rejected.map((r) => ({
        to: redactEmail(r.recipient),
        response: r.response,
      })),
    });

    return { accepted, rejected };
  } catch (error) {
    const err = error as Error & { responseCode?: number; response?: string };
    /**
     * When *every* recipient is rejected Nodemailer throws instead of
     * resolving; surface Dovecot's code (e.g. 552 over quota) so the
     * sender gets a truthful answer. Anything without a code is a
     * transport failure → 451 (temporary).
     */
    const code = typeof err.responseCode === "number" ? err.responseCode : 451;
    const message =
      code >= 500
        ? (err.response ?? err.message)
        : "Temporary local error delivering to mailbox — try again later";
    logger.error("LMTP delivery failed", {
      host,
      port,
      code,
      error: err.message,
      recipients: recipients.map(redactEmail),
    });
    throw new LmtpDeliveryError(message, code);
  } finally {
    transport.close();
  }
}
