import { t } from "elysia";

/**
 * Request body for `PATCH /api/v1/mailboxes/:id`. Every field is optional;
 * only provided fields change.
 */
export const updateMailboxDto = t.Object({
  /** New plaintext password (min 10 chars). */
  password: t.Optional(t.String({ minLength: 10, maxLength: 256 })),
  /** New quota in MB. */
  quotaMb: t.Optional(t.Integer({ minimum: 1, maximum: 1_000_000 })),
  /** Enable or disable the mailbox (IMAP login, SMTP AUTH and delivery). */
  enabled: t.Optional(t.Boolean()),
});
