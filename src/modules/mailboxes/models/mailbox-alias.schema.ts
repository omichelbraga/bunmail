import { pgTable, varchar, timestamp, index } from "drizzle-orm/pg-core";
import { domains } from "../../domains/models/domain.schema.ts";
import { mailboxes } from "./mailbox.schema.ts";

/**
 * Mailbox aliases — extra addresses that deliver into a mailbox
 * (`support@example.com` → `mike@example.com`).
 *
 * Aliases are resolved by BunMail, not Dovecot: the inbound receiver maps
 * an alias to its mailbox before the LMTP hand-off, and the SMTP submission
 * server lets a mailbox login send `From` any of its aliases. Dovecot only
 * ever sees the target mailbox, so the `mailboxes` table stays the single
 * auth contract.
 */
export const mailboxAliases = pgTable(
  "mailbox_aliases",
  {
    /** Unique identifier, prefixed with `mba_` */
    id: varchar("id", { length: 36 }).primaryKey(),

    /** Target mailbox — cascade so deleting the mailbox drops its aliases */
    mailboxId: varchar("mailbox_id", { length: 36 })
      .notNull()
      .references(() => mailboxes.id, { onDelete: "cascade" }),

    /** Domain of the alias address (must be registered in BunMail) */
    domainId: varchar("domain_id", { length: 36 })
      .notNull()
      .references(() => domains.id, { onDelete: "cascade" }),

    /** Full alias address, lower-cased, unique across aliases */
    email: varchar("email", { length: 255 }).notNull().unique(),

    /** When this alias was created */
    createdAt: timestamp("created_at").notNull().defaultNow(),
  },
  (table) => [index("idx_mailbox_aliases_mailbox_id").on(table.mailboxId)],
);
