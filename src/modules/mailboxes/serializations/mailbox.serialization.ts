import { getMailboxClientSettings } from "../services/mailbox.service.ts";
import type { Mailbox, MailboxClientSettings } from "../types/mailbox.types.ts";

/** API response shape for a mailbox. Never includes the password hash. */
export interface SerializedMailbox {
  id: string;
  domainId: string;
  email: string;
  quotaBytes: number;
  enabled: boolean;
  createdAt: string;
  updatedAt: string;
  /** IMAP/SMTP settings for a mail client. */
  clientSettings: MailboxClientSettings;
}

/**
 * Maps a mailbox row to its API shape — strips `passwordHash` and attaches
 * the connection settings a client needs.
 */
export function serializeMailbox(mailbox: Mailbox): SerializedMailbox {
  return {
    id: mailbox.id,
    domainId: mailbox.domainId,
    email: mailbox.email,
    quotaBytes: mailbox.quotaBytes,
    enabled: mailbox.enabled,
    createdAt: mailbox.createdAt.toISOString(),
    updatedAt: mailbox.updatedAt.toISOString(),
    clientSettings: getMailboxClientSettings(mailbox),
  };
}
