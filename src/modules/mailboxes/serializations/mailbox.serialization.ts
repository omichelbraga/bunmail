import { getMailboxClientSettings } from "../services/mailbox.service.ts";
import type {
  Mailbox,
  MailboxAlias,
  MailboxClientSettings,
} from "../types/mailbox.types.ts";

/** API response shape for a mailbox. Never includes the password hash. */
export interface SerializedMailbox {
  id: string;
  domainId: string;
  email: string;
  quotaBytes: number;
  enabled: boolean;
  createdAt: string;
  updatedAt: string;
  /** Extra addresses that deliver into this mailbox. */
  aliases: { id: string; email: string; createdAt: string }[];
  /** IMAP/SMTP settings for a mail client. */
  clientSettings: MailboxClientSettings;
}

/**
 * Maps a mailbox row to its API shape — strips `passwordHash` and attaches
 * the connection settings a client needs.
 */
export function serializeMailbox(
  mailbox: Mailbox,
  aliases: MailboxAlias[] = [],
): SerializedMailbox {
  return {
    id: mailbox.id,
    domainId: mailbox.domainId,
    email: mailbox.email,
    quotaBytes: mailbox.quotaBytes,
    enabled: mailbox.enabled,
    createdAt: mailbox.createdAt.toISOString(),
    updatedAt: mailbox.updatedAt.toISOString(),
    aliases: aliases.map((a) => ({
      id: a.id,
      email: a.email,
      createdAt: a.createdAt.toISOString(),
    })),
    clientSettings: getMailboxClientSettings(mailbox),
  };
}
