import type { InferSelectModel } from "drizzle-orm";
import type { mailboxes } from "../models/mailbox.schema.ts";

/**
 * The shape of a mailbox row returned from the database.
 * Inferred from the Drizzle schema so it never drifts.
 */
export type Mailbox = InferSelectModel<typeof mailboxes>;

/** Input required to create a mailbox. */
export interface CreateMailboxInput {
  /** Full address, e.g. `mike@example.com`. The domain must be registered. */
  email: string;
  /** Plaintext password — hashed before it touches the database. */
  password: string;
  /** Storage quota in bytes. Defaults to `MAILBOX_DEFAULT_QUOTA_MB`. */
  quotaBytes?: number;
}

/** Mutable fields on a mailbox. Only provided fields change. */
export interface UpdateMailboxInput {
  /** New plaintext password — hashed before storage. */
  password?: string;
  /** New quota in bytes. */
  quotaBytes?: number;
  /** Enable / disable the mailbox. */
  enabled?: boolean;
}

/**
 * Client-facing connection settings for a mailbox, rendered on the
 * dashboard "copy IMAP/SMTP settings" block and returned by the API.
 */
export interface MailboxClientSettings {
  imap: { host: string; port: number; security: "SSL/TLS" | "STARTTLS" };
  smtp: { host: string; port: number; security: "SSL/TLS" | "STARTTLS" | "None" };
  username: string;
}
