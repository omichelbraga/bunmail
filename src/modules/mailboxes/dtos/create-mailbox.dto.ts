import { t } from "elysia";

/**
 * Request body for `POST /api/v1/mailboxes`.
 */
export const createMailboxDto = t.Object({
  /** Full address on a registered domain, e.g. `mike@example.com`. */
  email: t.String({ format: "email", maxLength: 255 }),
  /** Plaintext password (min 10 chars); stored only as a bcrypt hash. */
  password: t.String({ minLength: 10, maxLength: 256 }),
  /** Optional quota in MB. Defaults to `MAILBOX_DEFAULT_QUOTA_MB`. */
  quotaMb: t.Optional(t.Integer({ minimum: 1, maximum: 1_000_000 })),
});
