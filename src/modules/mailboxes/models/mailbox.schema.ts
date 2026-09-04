import { pgTable, varchar, boolean, timestamp, bigint, index } from "drizzle-orm/pg-core";
import { domains } from "../../domains/models/domain.schema.ts";

/**
 * Mailboxes table — real IMAP mailboxes backed by Dovecot.
 *
 * A mailbox is a full address (`user@example.com`) on a domain that is
 * already registered in BunMail (`domains`). Dovecot authenticates IMAP
 * logins **directly against this table** (SQL passdb/userdb, see
 * `dovecot/conf/dovecot-sql.conf.ext`), so the column names and the
 * password-hash format are part of the Dovecot contract:
 *
 *   - `email`         → Dovecot `user` (lower-cased, unique)
 *   - `password_hash` → Dovecot `password`, stored WITH its scheme prefix,
 *                       e.g. `{BLF-CRYPT}$2b$12$…` (bcrypt). BunMail
 *                       produces it with `Bun.password.hash`, Dovecot
 *                       verifies it natively. Never plaintext.
 *   - `quota_bytes`   → Dovecot `quota_rule = *:bytes=<quota_bytes>`
 *   - `enabled`       → both queries filter `enabled = true`, so a
 *                       disabled mailbox can neither log in nor receive
 *                       LMTP deliveries.
 *
 * Mail data itself lives on disk (Maildir under `/var/mail/<domain>/<local>`
 * in the Dovecot container's persistent volume), not in Postgres.
 */
export const mailboxes = pgTable(
  "mailboxes",
  {
    /** Unique identifier, prefixed with `mbx_` */
    id: varchar("id", { length: 36 }).primaryKey(),

    /**
     * Owning domain. Cascade so deleting a domain in BunMail also drops its
     * mailbox rows (Maildir files on disk are left for the operator).
     */
    domainId: varchar("domain_id", { length: 36 })
      .notNull()
      .references(() => domains.id, { onDelete: "cascade" }),

    /** Full address, lower-cased — the IMAP/SMTP username */
    email: varchar("email", { length: 255 }).notNull().unique(),

    /** Local part (before the `@`), lower-cased; used for the Maildir path */
    localPart: varchar("local_part", { length: 64 }).notNull(),

    /** Dovecot-compatible password hash with scheme prefix (`{BLF-CRYPT}…`) */
    passwordHash: varchar("password_hash", { length: 255 }).notNull(),

    /** Storage quota in bytes enforced by Dovecot's quota plugin. */
    quotaBytes: bigint("quota_bytes", { mode: "number" })
      .notNull()
      .default(1024 * 1024 * 1024),

    /** Soft-disable: blocks IMAP login, SMTP AUTH and LMTP delivery */
    enabled: boolean("enabled").notNull().default(true),

    /** When this mailbox was created */
    createdAt: timestamp("created_at").notNull().defaultNow(),

    /** Last modification timestamp (password / quota / enabled changes) */
    updatedAt: timestamp("updated_at").notNull().defaultNow(),
  },
  (table) => [index("idx_mailboxes_domain_id").on(table.domainId)],
);
