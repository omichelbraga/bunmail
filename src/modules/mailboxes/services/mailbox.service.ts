import { and, asc, eq, inArray } from "drizzle-orm";
import { db } from "../../../db/index.ts";
import { mailboxes } from "../models/mailbox.schema.ts";
import { mailboxAliases } from "../models/mailbox-alias.schema.ts";
import { apiKeys } from "../../api-keys/models/api-key.schema.ts";
import { getDomainByName } from "../../domains/services/domain.service.ts";
import { generateId } from "../../../utils/id.ts";
import { generateApiKey } from "../../../utils/crypto.ts";
import { logger } from "../../../utils/logger.ts";
import { redactEmail } from "../../../utils/redact.ts";
import { config } from "../../../config.ts";
import { MailboxConflictError, MailboxValidationError } from "../errors.ts";
import type {
  Mailbox,
  MailboxAlias,
  CreateMailboxInput,
  UpdateMailboxInput,
  MailboxClientSettings,
} from "../types/mailbox.types.ts";

/**
 * Mailbox service — the only layer that touches the `mailboxes` table.
 *
 * Dovecot reads the same table directly for IMAP authentication, so two
 * invariants live here and nowhere else:
 *   1. `email` is always stored lower-cased (Dovecot looks up `%Lu`).
 *   2. `password_hash` is always `{BLF-CRYPT}` + bcrypt — a scheme Dovecot
 *      verifies natively, produced here with `Bun.password`.
 */

/** Dovecot password-scheme prefix for bcrypt hashes. */
const PASSWORD_SCHEME_PREFIX = "{BLF-CRYPT}";

/**
 * bcrypt work factor. 12 keeps a verify around ~250 ms on a modest VPS —
 * slow enough to blunt online guessing on IMAP/SMTP AUTH (which are
 * additionally rate-limited per IP), fast enough for mail clients that
 * re-authenticate on every connection.
 */
const BCRYPT_COST = 12;

/** Minimum mailbox password length. */
export const MIN_PASSWORD_LENGTH = 10;

/**
 * Local-part rules (deliberately stricter than RFC 5321 so the address is
 * also safe as a Maildir directory name): letters, digits, `.`, `_`, `+`,
 * `-`; 1–64 chars; no leading/trailing dot.
 */
const LOCAL_PART_RE = /^(?!\.)[a-z0-9._+-]{1,64}(?<!\.)$/;
const DOMAIN_RE =
  /^[a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?(\.[a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?)+$/;

/** Name of the system API key that attributes mailbox SMTP submissions. */
const SUBMISSION_KEY_NAME = "Mailbox SMTP (system)";

/* ─── Password helpers ─── */

/**
 * Hashes a mailbox password into the Dovecot-compatible stored form:
 * `{BLF-CRYPT}$2b$12$…`.
 */
export async function hashMailboxPassword(password: string): Promise<string> {
  const hash = await Bun.password.hash(password, {
    algorithm: "bcrypt",
    cost: BCRYPT_COST,
  });
  return PASSWORD_SCHEME_PREFIX + hash;
}

/**
 * Verifies a plaintext password against the stored `{BLF-CRYPT}…` hash.
 * Never throws — malformed hashes simply fail verification.
 */
export async function verifyMailboxPassword(
  password: string,
  storedHash: string,
): Promise<boolean> {
  const hash = storedHash.startsWith(PASSWORD_SCHEME_PREFIX)
    ? storedHash.slice(PASSWORD_SCHEME_PREFIX.length)
    : storedHash;
  if (!hash.startsWith("$2")) return false;
  try {
    return await Bun.password.verify(password, hash, "bcrypt");
  } catch {
    return false;
  }
}

/* ─── Address helpers ─── */

export interface NormalizedAddress {
  /** Full lower-cased address */
  email: string;
  localPart: string;
  domainName: string;
}

/**
 * Lower-cases and validates a mailbox address. Returns `null` when the
 * shape is unacceptable (missing `@`, bad characters, over-long parts).
 * Pure — used by the service, the SMTP AUTH path and unit tests.
 */
export function normalizeMailboxAddress(raw: string): NormalizedAddress | null {
  const email = raw.trim().toLowerCase();
  const at = email.lastIndexOf("@");
  if (at <= 0 || at === email.length - 1) return null;
  const localPart = email.slice(0, at);
  const domainName = email.slice(at + 1);
  if (!LOCAL_PART_RE.test(localPart)) return null;
  if (domainName.length > 253 || !DOMAIN_RE.test(domainName)) return null;
  return { email, localPart, domainName };
}

/* ─── CRUD ─── */

/**
 * Creates a mailbox on an already-registered domain.
 *
 * The domain must exist in BunMail's `domains` table — the same registry
 * used for DKIM signing and inbound recipient validation. There is no
 * second domain system for mailboxes.
 *
 * @throws MailboxValidationError on a bad address / weak password / unknown domain
 * @throws MailboxConflictError when the address is already taken
 */
export async function createMailbox(input: CreateMailboxInput): Promise<Mailbox> {
  const address = normalizeMailboxAddress(input.email);
  if (!address) {
    throw new MailboxValidationError(
      "Enter a valid address like user@yourdomain.com (letters, digits, . _ + - only)",
    );
  }
  if (input.password.length < MIN_PASSWORD_LENGTH) {
    throw new MailboxValidationError(
      `Password must be at least ${MIN_PASSWORD_LENGTH} characters`,
    );
  }
  const quotaBytes = input.quotaBytes ?? config.mailboxes.defaultQuotaBytes;
  if (!Number.isFinite(quotaBytes) || quotaBytes <= 0) {
    throw new MailboxValidationError("Quota must be a positive number of bytes");
  }

  const domain = await getDomainByName(address.domainName);
  if (!domain) {
    throw new MailboxValidationError(
      `Domain "${address.domainName}" is not registered in BunMail — add it under Domains first`,
    );
  }

  const existing = await findMailboxByEmail(address.email);
  if (existing) throw new MailboxConflictError(address.email);

  const id = generateId("mbx");
  logger.info("Creating mailbox", { id, email: redactEmail(address.email) });

  const passwordHash = await hashMailboxPassword(input.password);

  const [mailbox] = await db
    .insert(mailboxes)
    .values({
      id,
      domainId: domain.id,
      email: address.email,
      localPart: address.localPart,
      passwordHash,
      quotaBytes: Math.floor(quotaBytes),
    })
    .returning();

  logger.info("Mailbox created", { id: mailbox!.id, email: redactEmail(mailbox!.email) });
  return mailbox!;
}

/** Lists every mailbox, ordered by address. */
export async function listMailboxes(): Promise<Mailbox[]> {
  logger.debug("Listing mailboxes");
  return db.select().from(mailboxes).orderBy(asc(mailboxes.email));
}

/** Returns a mailbox by id, or undefined. */
export async function getMailboxById(id: string): Promise<Mailbox | undefined> {
  const [row] = await db.select().from(mailboxes).where(eq(mailboxes.id, id));
  return row;
}

/**
 * Returns a mailbox by address regardless of `enabled`. The address is
 * lower-cased before lookup so callers can pass raw SMTP/IMAP input.
 */
export async function findMailboxByEmail(email: string): Promise<Mailbox | undefined> {
  const [row] = await db
    .select()
    .from(mailboxes)
    .where(eq(mailboxes.email, email.trim().toLowerCase()))
    .limit(1);
  return row;
}

/**
 * Resolves the subset of envelope recipients that should be delivered to
 * Dovecot: enabled mailboxes whose address matches exactly. Addresses that
 * don't match (programmable inbound like `reply+123@…`, disabled
 * mailboxes) are left to BunMail's normal inbound processing.
 *
 * Returns the deduplicated list of mailbox addresses (LMTP RCPT TOs).
 */
export async function resolveDeliverableMailboxes(
  recipients: string[],
): Promise<string[]> {
  const wanted = Array.from(
    new Set(recipients.map((r) => r.trim().toLowerCase()).filter(Boolean)),
  );
  if (wanted.length === 0) return [];
  const [direct, viaAlias] = await Promise.all([
    db
      .select({ email: mailboxes.email })
      .from(mailboxes)
      .where(and(inArray(mailboxes.email, wanted), eq(mailboxes.enabled, true))),
    /** Aliases resolve to their target mailbox (only if that one is enabled). */
    db
      .select({ email: mailboxes.email })
      .from(mailboxAliases)
      .innerJoin(mailboxes, eq(mailboxAliases.mailboxId, mailboxes.id))
      .where(and(inArray(mailboxAliases.email, wanted), eq(mailboxes.enabled, true))),
  ]);
  return Array.from(new Set([...direct, ...viaAlias].map((r) => r.email)));
}

/* ─── Aliases ─── */

/** Lists the aliases of one mailbox, ordered by address. */
export async function listAliases(mailboxId: string): Promise<MailboxAlias[]> {
  return db
    .select()
    .from(mailboxAliases)
    .where(eq(mailboxAliases.mailboxId, mailboxId))
    .orderBy(asc(mailboxAliases.email));
}

/**
 * Lists aliases for many mailboxes at once (dashboard / list API), keyed
 * by mailbox id. Avoids one query per row.
 */
export async function listAliasesByMailbox(
  mailboxIds: string[],
): Promise<Map<string, MailboxAlias[]>> {
  const out = new Map<string, MailboxAlias[]>();
  if (mailboxIds.length === 0) return out;
  const rows = await db
    .select()
    .from(mailboxAliases)
    .where(inArray(mailboxAliases.mailboxId, mailboxIds))
    .orderBy(asc(mailboxAliases.email));
  for (const row of rows) {
    const list = out.get(row.mailboxId) ?? [];
    list.push(row);
    out.set(row.mailboxId, list);
  }
  return out;
}

/**
 * Adds an alias that delivers into `mailboxId`. The alias must be on a
 * registered domain and must not collide with a mailbox or another alias.
 *
 * @throws MailboxValidationError on a bad address / unknown domain
 * @throws MailboxConflictError when the address is already taken
 */
export async function createAlias(
  mailboxId: string,
  rawEmail: string,
): Promise<MailboxAlias> {
  const address = normalizeMailboxAddress(rawEmail);
  if (!address) {
    throw new MailboxValidationError(
      "Enter a valid alias like support@yourdomain.com (letters, digits, . _ + - only)",
    );
  }
  const mailbox = await getMailboxById(mailboxId);
  if (!mailbox) throw new MailboxValidationError("Mailbox not found");

  const domain = await getDomainByName(address.domainName);
  if (!domain) {
    throw new MailboxValidationError(
      `Domain "${address.domainName}" is not registered in BunMail — add it under Domains first`,
    );
  }
  if (await findMailboxByEmail(address.email))
    throw new MailboxConflictError(address.email);
  const [taken] = await db
    .select({ id: mailboxAliases.id })
    .from(mailboxAliases)
    .where(eq(mailboxAliases.email, address.email))
    .limit(1);
  if (taken) throw new MailboxConflictError(address.email);

  const id = generateId("mba");
  logger.info("Creating mailbox alias", {
    id,
    mailboxId,
    alias: redactEmail(address.email),
  });
  const [alias] = await db
    .insert(mailboxAliases)
    .values({ id, mailboxId, domainId: domain.id, email: address.email })
    .returning();
  return alias!;
}

/** Deletes an alias of `mailboxId`. Returns undefined when it doesn't exist. */
export async function deleteAlias(
  mailboxId: string,
  aliasId: string,
): Promise<MailboxAlias | undefined> {
  const [row] = await db
    .delete(mailboxAliases)
    .where(and(eq(mailboxAliases.id, aliasId), eq(mailboxAliases.mailboxId, mailboxId)))
    .returning();
  if (row) logger.info("Mailbox alias deleted", { id: aliasId, mailboxId });
  return row;
}

/**
 * The set of addresses a mailbox login may use as `From` on the SMTP
 * submission server: its own address plus its aliases (lower-cased).
 */
export async function getAllowedSenderAddresses(mailbox: Mailbox): Promise<Set<string>> {
  const aliases = await listAliases(mailbox.id);
  return new Set([mailbox.email, ...aliases.map((a) => a.email)]);
}

/**
 * Updates password / quota / enabled. Only provided fields change.
 * Returns undefined when no mailbox matches.
 *
 * @throws MailboxValidationError on a weak password or bad quota
 */
export async function updateMailbox(
  id: string,
  input: UpdateMailboxInput,
): Promise<Mailbox | undefined> {
  const set: Partial<typeof mailboxes.$inferInsert> = {};

  if (input.password !== undefined) {
    if (input.password.length < MIN_PASSWORD_LENGTH) {
      throw new MailboxValidationError(
        `Password must be at least ${MIN_PASSWORD_LENGTH} characters`,
      );
    }
    set.passwordHash = await hashMailboxPassword(input.password);
  }
  if (input.quotaBytes !== undefined) {
    if (!Number.isFinite(input.quotaBytes) || input.quotaBytes <= 0) {
      throw new MailboxValidationError("Quota must be a positive number of bytes");
    }
    set.quotaBytes = Math.floor(input.quotaBytes);
  }
  if (input.enabled !== undefined) set.enabled = input.enabled;

  if (Object.keys(set).length === 0) return getMailboxById(id);

  set.updatedAt = new Date();
  logger.info("Updating mailbox", { id, fields: Object.keys(set) });

  const [row] = await db
    .update(mailboxes)
    .set(set)
    .where(eq(mailboxes.id, id))
    .returning();
  if (!row) logger.warn("Mailbox not found for update", { id });
  return row;
}

/**
 * Hard-deletes the mailbox row. Dovecot immediately stops authenticating
 * the address and BunMail stops LMTP delivery for it. The Maildir on the
 * Dovecot volume is NOT removed — operators can reclaim the space
 * manually (`/var/mail/<domain>/<local>`), which keeps deletes reversible
 * at the storage level.
 */
export async function deleteMailbox(id: string): Promise<Mailbox | undefined> {
  logger.info("Deleting mailbox", { id });
  const [row] = await db.delete(mailboxes).where(eq(mailboxes.id, id)).returning();
  if (!row) logger.warn("Mailbox not found for deletion", { id });
  else logger.info("Mailbox deleted", { id, email: redactEmail(row.email) });
  return row;
}

/* ─── Client settings ─── */

/**
 * Connection settings a mail client needs for this mailbox. IMAP is
 * always implicit TLS on 993 (Dovecot `ssl = required`); SMTP is BunMail's
 * submission server with STARTTLS when a cert is configured.
 */
export function getMailboxClientSettings(
  mailbox: Pick<Mailbox, "email">,
): MailboxClientSettings {
  const { tls, securePort } = config.smtpSubmission;
  const smtpHasTls = Boolean(tls.certPath && tls.keyPath);
  /**
   * Prefer the implicit-TLS port (465) when TLS is configured — see
   * `config.smtpSubmission.securePort` for why STARTTLS on 587 isn't
   * offered to mail clients.
   */
  const smtp: MailboxClientSettings["smtp"] =
    smtpHasTls && securePort > 0
      ? { host: config.mailboxes.smtpHost, port: securePort, security: "SSL/TLS" }
      : {
          host: config.mailboxes.smtpHost,
          port: config.smtpSubmission.port,
          security: smtpHasTls ? "STARTTLS" : "None",
        };
  return {
    imap: {
      host: config.mailboxes.imapHost,
      port: config.mailboxes.imapPort,
      security: "SSL/TLS",
    },
    smtp,
    username: mailbox.email,
  };
}

/* ─── SMTP submission attribution ─── */

/** Cached id of the system API key used to attribute mailbox SMTP sends. */
let submissionKeyId: string | null = null;

/**
 * Returns the id of the system API key that owns emails sent by mailbox
 * users through the SMTP submission server.
 *
 * Every row in `emails` must belong to an API key (that's how the queue,
 * stats, suppressions and the dashboard filters work), and we don't want
 * to change that contract for mailboxes. So mailbox submissions are
 * attributed to one restricted, non-admin system key. The key's raw
 * secret is generated and immediately discarded — it can never be used
 * for REST calls; it exists only as an attribution anchor. If an operator
 * revokes it, mailbox SMTP AUTH keeps working and a fresh one is created.
 */
export async function getMailboxSubmissionKeyId(): Promise<string> {
  if (submissionKeyId) {
    const [row] = await db
      .select({ id: apiKeys.id, isActive: apiKeys.isActive })
      .from(apiKeys)
      .where(eq(apiKeys.id, submissionKeyId));
    if (row?.isActive) return row.id;
    submissionKeyId = null;
  }

  const [existing] = await db
    .select({ id: apiKeys.id })
    .from(apiKeys)
    .where(and(eq(apiKeys.name, SUBMISSION_KEY_NAME), eq(apiKeys.isActive, true)))
    .orderBy(asc(apiKeys.createdAt))
    .limit(1);
  if (existing) {
    submissionKeyId = existing.id;
    return existing.id;
  }

  const id = generateId("key");
  const { hash, prefix } = generateApiKey();
  await db.insert(apiKeys).values({
    id,
    name: SUBMISSION_KEY_NAME,
    keyHash: hash,
    keyPrefix: prefix,
    isAdmin: false,
    allowedSenders: [],
  });
  logger.info("Created system API key for mailbox SMTP submissions", { id });
  submissionKeyId = id;
  return id;
}
