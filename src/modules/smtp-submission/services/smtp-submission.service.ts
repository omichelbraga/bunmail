import { readFileSync } from "fs";
import { createServer as createTlsServer, type Server as TlsServer } from "tls";
import { SMTPServer } from "smtp-server";
import type {
  SMTPServerAuthentication,
  SMTPServerSession,
  SMTPServerAuthenticationResponse,
  SMTPServerDataStream,
} from "smtp-server";
import { simpleParser } from "mailparser";
import type { AddressObject } from "mailparser";
import { config } from "../../../config.ts";
import { logger } from "../../../utils/logger.ts";
import { redactEmail } from "../../../utils/redact.ts";
import { hashApiKey } from "../../../utils/crypto.ts";
import { findByHash } from "../../api-keys/services/api-key.service.ts";
import { createEmail } from "../../emails/services/email.service.ts";
import { SuppressedRecipientError } from "../../suppressions/errors.ts";
import type { SendEmailInput } from "../../emails/types/email.types.ts";
import { buildSubmissionInput } from "../message-mapper.ts";
import { recordOutcome, getAcceptedToday } from "./usage.service.ts";
import {
  findMailboxByEmail,
  verifyMailboxPassword,
  getMailboxById,
  getMailboxSubmissionKeyId,
  getAllowedSenderAddresses,
} from "../../mailboxes/services/mailbox.service.ts";

/**
 * The SMTP submission server (#120) lets any SMTP-capable app (Infisical,
 * Netbird, Dify, a NestJS/Nodemailer backend, …) send *through* BunMail by
 * pointing its SMTP settings here and authenticating with a `bm_live_` API
 * key as the password. Accepted messages are handed to the normal outbound
 * pipeline via `createEmail` (queue → DKIM → direct-to-MX).
 *
 * This is deliberately distinct from the inbound receiver
 * (`src/modules/inbound/services/smtp-receiver.service.ts`): inbound has
 * AUTH disabled and validates recipient domains (it's an MX receiver);
 * submission *requires* AUTH and relays to any recipient (the open-relay
 * guard here is authentication, not recipient-domain validation).
 */

/**
 * Maximum size (bytes) of a submitted message — advertised via the SIZE
 * ESMTP extension and enforced inside `onData`. Matches the inbound cap.
 */
const MAX_MESSAGE_BYTES = 10 * 1024 * 1024;

/**
 * Maximum recipients accepted per transaction. A submission client that
 * blows past this is almost certainly misbehaving; legitimate
 * transactional mail rarely exceeds a handful.
 */
const MAX_RECIPIENTS_PER_TRANSACTION = 50;

/** The running server instance (STARTTLS-capable, plaintext port), or null when stopped. */
let server: SMTPServer | null = null;

/**
 * The implicit-TLS (SMTPS, port 465) instance, or null when TLS isn't
 * configured. Shares every handler with `server`; only the transport
 * differs. Mail clients should use this one — see `config.smtpSubmission.securePort`.
 */
let secureServer: SMTPServer | null = null;

/**
 * Our own TLS listener for `secureServer`. `smtp-server` does its TLS by
 * wrapping each accepted socket in `new tls.TLSSocket(socket)` — for both
 * implicit TLS and the STARTTLS upgrade. Bun does not implement that
 * wrapping (the handshake never completes), while `tls.createServer`
 * works. So we terminate TLS here and hand the already-encrypted sockets
 * to an SMTPServer created with `secured: true`, which tells `smtp-server`
 * the socket is TLS-terminated upstream.
 */
let tlsListener: TlsServer | null = null;

/** Interval handle for the periodic rate-limit map cleanup. */
let cleanupInterval: ReturnType<typeof setInterval> | null = null;

/* ─── Per-IP sliding-window counters ─── */

interface WindowEntry {
  /** Number of events in the current window. */
  count: number;
  /** Timestamp (ms) when the current window started. */
  windowStart: number;
}

/** IP → connection-count state (connection rate limiting). */
const connectionMap = new Map<string, WindowEntry>();
/** IP → failed-AUTH-count state (key brute-force throttle). */
const authFailureMap = new Map<string, WindowEntry>();

/**
 * `session.user` is a string, so the two credential types share it via a
 * prefix: `mbx:<mailbox id>` for mailbox logins, a bare `key_…` id for
 * API-key logins (unchanged from #120).
 */
const MAILBOX_USER_PREFIX = "mbx:";

/** Interval handle for the TLS certificate reload watcher. */
let tlsReloadInterval: ReturnType<typeof setInterval> | null = null;
/** Fingerprint of the cert+key currently loaded, to detect renewals. */
let loadedTlsFingerprint: string | null = null;

/**
 * Authenticates `user@domain` + mailbox password (docs/mailboxes.md).
 * Returns the mailbox id on success, null on any failure (unknown address,
 * disabled mailbox, wrong password). Only attempted when the username looks
 * like an address; API-key AUTH is tried afterwards so existing clients
 * that happen to use an email as username keep working.
 */
async function authenticateMailbox(
  username: string,
  password: string,
): Promise<string | null> {
  if (!config.mailboxes.enabled || !config.mailboxes.smtpAuthEnabled) return null;
  if (!username.includes("@") || !password) return null;
  const mailbox = await findMailboxByEmail(username);
  if (!mailbox || !mailbox.enabled) return null;
  const ok = await verifyMailboxPassword(password, mailbox.passwordHash);
  return ok ? mailbox.id : null;
}

/**
 * Generic sliding-window check-and-increment. Returns true once `max`
 * events have accumulated for `ip` within `windowSec`. A fresh window
 * starts on the first event or after the previous one expired.
 */
function hitWindow(
  map: Map<string, WindowEntry>,
  ip: string,
  max: number,
  windowSec: number,
): boolean {
  const windowMs = windowSec * 1000;
  const now = Date.now();
  const entry = map.get(ip);

  if (!entry || now - entry.windowStart >= windowMs) {
    map.set(ip, { count: 1, windowStart: now });
    return 1 > max;
  }

  entry.count += 1;
  return entry.count > max;
}

/**
 * Read-only check of whether an IP is currently over the failed-AUTH
 * limit, without recording a new failure. Used to reject before the key
 * lookup so a locked-out IP can't keep probing keys.
 */
function isAuthLockedOut(ip: string): boolean {
  const { maxAttempts, windowSec } = config.smtpSubmission.authRateLimit;
  const entry = authFailureMap.get(ip);
  if (!entry || Date.now() - entry.windowStart >= windowSec * 1000) return false;
  return entry.count >= maxAttempts;
}

/** Record a failed AUTH for an IP (starts/extends its window). */
function recordAuthFailure(ip: string): void {
  const { windowSec } = config.smtpSubmission.authRateLimit;
  hitWindow(authFailureMap, ip, Number.POSITIVE_INFINITY, windowSec);
}

/* ─── Message parsing helpers ─── */

/**
 * Flattens a mailparser address field (single object or array) into a flat
 * list of raw addresses. Shaping (dedup, To/Cc/BCC assignment) is handled
 * by the pure `message-mapper` module.
 */
function extractAddresses(field: AddressObject | AddressObject[] | undefined): string[] {
  if (!field) return [];
  const objs = Array.isArray(field) ? field : [field];
  const out: string[] = [];
  for (const obj of objs) {
    for (const a of obj.value ?? []) {
      const addr = a.address?.trim();
      if (addr) out.push(addr);
    }
  }
  return out;
}

/**
 * Maps an SMTP error to a response with a specific SMTP status code so the
 * submitting client sees a real rejection instead of a generic failure.
 */
function smtpError(message: string, responseCode: number): Error {
  const err = new Error(message) as Error & { responseCode: number };
  err.responseCode = responseCode;
  return err;
}

/** Cheap change detector for the PEM pair (lengths + content hash). */
function tlsFingerprint(material: { key: Buffer; cert: Buffer }): string {
  return Bun.hash(Buffer.concat([material.cert, material.key])).toString(16);
}

/* ─── Server lifecycle ─── */

/**
 * Starts the SMTP submission server on the configured port. Requires
 * AUTH; authenticates the password against the API-keys table. STARTTLS is
 * advertised when a cert/key pair is configured; plaintext AUTH is allowed
 * (`allowInsecureAuth`) so the common same-host / private-network setup
 * works with zero TLS configuration.
 */
export function start(portOverride?: number): void {
  const { tls, connectionRateLimit } = config.smtpSubmission;
  /** `portOverride` lets integration tests bind an isolated port. */
  const port = portOverride ?? config.smtpSubmission.port;

  /**
   * Load TLS material if both a cert and key path are configured. When
   * present, an implicit-TLS listener (SMTPS) is opened on `securePort`
   * backed by this cert. A bad path fails loudly at start rather than
   * silently downgrading security.
   */
  let tlsOptions: { key: Buffer; cert: Buffer } | undefined;
  if (tls.certPath && tls.keyPath) {
    try {
      tlsOptions = {
        cert: readFileSync(tls.certPath),
        key: readFileSync(tls.keyPath),
      };
    } catch (error) {
      throw new Error(
        `[smtp-submission] Failed to read TLS cert/key from ` +
          `SMTP_SUBMISSION_TLS_CERT="${tls.certPath}" / ` +
          `SMTP_SUBMISSION_TLS_KEY="${tls.keyPath}"`,
        { cause: error },
      );
    }
  }

  /**
   * Refuse to accept AUTH credentials in cleartext by default (#133). The
   * password is a full-privilege `bm_live_…` key. Plaintext AUTH is only
   * allowed when TLS is configured (clients STARTTLS first) or the operator
   * has explicitly opted in via `SMTP_SUBMISSION_ALLOW_INSECURE=true` for a
   * trusted-network deployment. Failing fast here beats silently leaking
   * keys on the wire.
   */
  const allowInsecureAuth = config.smtpSubmission.allowInsecureAuth;
  if (!tlsOptions && !allowInsecureAuth) {
    throw new Error(
      "[smtp-submission] Refusing to start: AUTH would be accepted over a\n" +
        "  plaintext connection, and the password is a full-privilege API key.\n" +
        "  → Configure TLS (SMTP_SUBMISSION_TLS_CERT + SMTP_SUBMISSION_TLS_KEY)\n" +
        "    so clients STARTTLS before AUTH, OR set\n" +
        "    SMTP_SUBMISSION_ALLOW_INSECURE=true if the server is only reachable\n" +
        "    over a trusted network (same host / private Docker network).",
    );
  }

  const serverOptions: ConstructorParameters<typeof SMTPServer>[0] = {
    /**
     * Hostname announced in the 220 greeting / EHLO response. Defaults to
     * the OS hostname, which inside Docker is the container id — receiving
     * and sending MTAs compare this against PTR/forward DNS, so it must be
     * the public mail hostname.
     */
    name: config.mail.hostname,
    /**
     * STARTTLS is never offered: the socket upgrade `smtp-server` performs
     * for it is not implemented by Bun and would hang the client mid-
     * handshake. TLS is provided by the implicit-TLS listener below.
     */
    hideSTARTTLS: true,
    /** AUTH is mandatory — this is the open-relay guard for submission. */
    authOptional: false,
    /** Only password-based mechanisms; the password carries the API key. */
    authMethods: ["PLAIN", "LOGIN"],
    /**
     * Allow AUTH over a plaintext connection only when opted in (#133).
     * `false` by default; the `start()` guard above already refuses to boot
     * with neither TLS nor the explicit opt-in, so reaching here with
     * `false` means TLS is configured and clients STARTTLS before AUTH.
     */
    allowInsecureAuth,
    size: MAX_MESSAGE_BYTES,

    /**
     * Per-IP connection rate limiting (instant, no I/O). Runs before AUTH
     * to blunt connection churn. SMTP 421 = temporary rejection.
     */
    onConnect(session: SMTPServerSession, callback: (err?: Error) => void) {
      const ip = session.remoteAddress;
      if (
        connectionRateLimit.enabled &&
        hitWindow(
          connectionMap,
          ip,
          connectionRateLimit.max,
          connectionRateLimit.windowSec,
        )
      ) {
        logger.warn("SMTP submission connection rate limited", { ip });
        return callback(smtpError("Too many connections, try again later", 421));
      }
      callback();
    },

    /**
     * Authenticate the client. The password (falling back to the username
     * for clients that only fill one field) is treated as a `bm_live_` API
     * key: SHA-256 hashed and looked up. A per-IP failed-AUTH throttle
     * blunts key brute-forcing; a success clears the counter.
     */
    onAuth(
      auth: SMTPServerAuthentication,
      session: SMTPServerSession,
      callback: (
        err: Error | null | undefined,
        response?: SMTPServerAuthenticationResponse,
      ) => void,
    ) {
      const ip = session.remoteAddress;
      const { authRateLimit } = config.smtpSubmission;

      if (authRateLimit.enabled && isAuthLockedOut(ip)) {
        logger.warn("SMTP submission AUTH rate limited", { ip });
        /** 454 = temporary auth failure; client should back off. */
        return callback(smtpError("Too many failed authentication attempts", 454));
      }

      /** Password is the API key; some clients only set the username. */
      const candidate = auth.password || auth.username || "";
      if (!candidate) {
        if (authRateLimit.enabled) recordAuthFailure(ip);
        return callback(smtpError("Authentication credentials required", 535));
      }

      /**
       * Mailbox credentials first (`user@domain` + mailbox password), then
       * the API-key path. A mailbox mismatch falls through rather than
       * failing, so a client using an email as username with an API key
       * as password (allowed since #120) is unaffected.
       */
      authenticateMailbox(auth.username ?? "", auth.password ?? "")
        .then(async (mailboxId) => {
          if (mailboxId) {
            authFailureMap.delete(ip);
            logger.info("SMTP submission mailbox authenticated", {
              ip,
              mailboxId,
              user: redactEmail(auth.username ?? ""),
            });
            return callback(null, { user: `${MAILBOX_USER_PREFIX}${mailboxId}` });
          }
          const apiKey = await findByHash(hashApiKey(candidate));
          if (!apiKey || !apiKey.isActive) {
            if (authRateLimit.enabled) recordAuthFailure(ip);
            logger.warn("SMTP submission AUTH failed — invalid or inactive key", { ip });
            return callback(smtpError("Invalid credentials", 535));
          }
          /** Success — clear the failure counter and stash the key id. */
          authFailureMap.delete(ip);
          logger.info("SMTP submission client authenticated", {
            ip,
            apiKeyId: apiKey.id,
          });
          callback(null, { user: apiKey.id });
        })
        .catch((error) => {
          logger.error("SMTP submission AUTH lookup failed", {
            ip,
            error: error instanceof Error ? error.message : String(error),
          });
          /** 451 = local error; don't leak details, don't count as a guess. */
          callback(smtpError("Temporary authentication failure", 451));
        });
    },

    /**
     * Cap recipients per transaction (open-relay-fanout defence). Unlike
     * the inbound receiver we do NOT validate the recipient domain —
     * submission legitimately sends to arbitrary external recipients; AUTH
     * is what prevents abuse.
     */
    onRcptTo(
      _address: { address: string },
      session: SMTPServerSession,
      callback: (err?: Error) => void,
    ) {
      const acceptedSoFar = session.envelope.rcptTo?.length ?? 0;
      if (acceptedSoFar >= MAX_RECIPIENTS_PER_TRANSACTION) {
        logger.warn("SMTP submission RCPT TO rejected — too many recipients", {
          acceptedSoFar,
          ip: session.remoteAddress,
        });
        return callback(
          smtpError(
            `Too many recipients (max ${MAX_RECIPIENTS_PER_TRANSACTION} per transaction)`,
            452,
          ),
        );
      }
      callback();
    },

    /**
     * Parse the submitted message and enqueue it via the outbound
     * pipeline, attributed to the authenticated API key.
     */
    onData(
      stream: SMTPServerDataStream,
      session: SMTPServerSession,
      callback: (err?: Error) => void,
    ) {
      const chunks: Buffer[] = [];
      let totalBytes = 0;
      let aborted = false;

      stream.on("data", (chunk: Buffer) => {
        if (aborted) return;
        totalBytes += chunk.length;
        if (totalBytes > MAX_MESSAGE_BYTES) {
          aborted = true;
          logger.warn("SMTP submission DATA rejected — message exceeds size cap", {
            ip: session.remoteAddress,
            totalBytes,
            cap: MAX_MESSAGE_BYTES,
          });
          chunks.length = 0;
          stream.unpipe();
          stream.resume();
          callback(smtpError("Message size exceeds limit", 552));
          return;
        }
        chunks.push(chunk);
      });

      stream.on("end", async () => {
        if (aborted) return;

        /** onAuth stashed the API key id (or `mbx:<id>`) here; guard defensively. */
        const sessionUser = session.user;
        if (!sessionUser) {
          logger.error("SMTP submission DATA without an authenticated session");
          callback(smtpError("Authentication required", 530));
          return;
        }

        /**
         * Mailbox sessions: the email is attributed to the system
         * "Mailbox SMTP" API key (every `emails` row needs an owning key —
         * queue, stats, suppressions and dashboard filters rely on it) and
         * the `From` is pinned to the mailbox address so a mailbox login
         * can't impersonate other identities on the domain.
         */
        let apiKeyId = sessionUser;
        /** Addresses this session may send From (mailbox + aliases), or null for API keys. */
        let allowedFrom: Set<string> | null = null;
        if (sessionUser.startsWith(MAILBOX_USER_PREFIX)) {
          const mailbox = await getMailboxById(
            sessionUser.slice(MAILBOX_USER_PREFIX.length),
          );
          if (!mailbox || !mailbox.enabled) {
            logger.warn("SMTP submission DATA rejected — mailbox no longer available");
            callback(smtpError("Mailbox is disabled", 530));
            return;
          }
          allowedFrom = await getAllowedSenderAddresses(mailbox);
          try {
            apiKeyId = await getMailboxSubmissionKeyId();
          } catch (error) {
            logger.error("SMTP submission — failed to resolve mailbox system key", {
              error: error instanceof Error ? error.message : String(error),
            });
            callback(smtpError("Temporary local error", 451));
            return;
          }
        }

        try {
          /**
           * Per-key daily quota (#123). Checked before the send so an
           * over-quota key never queues. `452` is temporary — the quota
           * window resets at the next UTC day, so the client should retry
           * later rather than treat it as a permanent failure.
           */
          const { dailyQuota } = config.smtpSubmission;
          if (dailyQuota > 0) {
            const usedToday = await getAcceptedToday(apiKeyId);
            if (usedToday >= dailyQuota) {
              logger.warn("SMTP submission rejected — daily quota exceeded", {
                apiKeyId,
                usedToday,
                dailyQuota,
              });
              await recordOutcome(apiKeyId, "rejected");
              callback(
                smtpError(
                  `Daily send quota of ${dailyQuota} reached for this API key; resets at 00:00 UTC`,
                  452,
                ),
              );
              return;
            }
          }

          const rawMessage = Buffer.concat(chunks).toString("utf-8");
          const parsed = await simpleParser(rawMessage);

          const envelopeFrom =
            session.envelope.mailFrom && typeof session.envelope.mailFrom === "object"
              ? session.envelope.mailFrom.address
              : undefined;

          /** Delegate all shaping (sender resolution, BCC merge, To fallback). */
          const input: SendEmailInput = buildSubmissionInput({
            fromHeader: parsed.from?.value?.[0]?.address,
            envelopeFrom,
            toHeader: extractAddresses(parsed.to),
            ccHeader: extractAddresses(parsed.cc),
            envelopeRecipients: (session.envelope.rcptTo ?? []).map((r) => r.address),
            subject: parsed.subject ?? "",
            html: typeof parsed.html === "string" ? parsed.html : undefined,
            text: typeof parsed.text === "string" ? parsed.text : undefined,
          });

          if (allowedFrom && !allowedFrom.has(input.from.trim().toLowerCase())) {
            logger.warn(
              "SMTP submission rejected — From is not the mailbox or one of its aliases",
              {
                from: redactEmail(input.from),
                allowed: allowedFrom.size,
              },
            );
            await recordOutcome(apiKeyId, "rejected");
            callback(
              smtpError(
                `From address must be your mailbox address or one of its aliases (${[...allowedFrom].join(", ")})`,
                550,
              ),
            );
            return;
          }

          /** Tag the row as SMTP-sourced so the dashboard can filter it (#137). */
          const email = await createEmail(input, apiKeyId, "smtp");
          await recordOutcome(apiKeyId, "accepted");

          logger.info("SMTP submission accepted — email queued", {
            id: email.id,
            apiKeyId,
            from: redactEmail(input.from),
            to: redactEmail(input.to),
          });

          callback();
        } catch (error) {
          /** Post-auth rejection — count it against the key's daily usage. */
          await recordOutcome(apiKeyId, "rejected").catch(() => {});
          if (error instanceof SuppressedRecipientError) {
            logger.warn("SMTP submission rejected — recipient suppressed", {
              apiKeyId,
              suppressionId: error.suppressionId,
            });
            callback(smtpError(error.message, 550));
            return;
          }
          const message = error instanceof Error ? error.message : String(error);
          logger.warn("SMTP submission rejected", { apiKeyId, error: message });
          /** Sender-domain / validation errors from createEmail → 550. */
          callback(smtpError(message, 550));
        }
      });
    },
  };

  server = new SMTPServer({ ...serverOptions, secure: false });

  server.listen(port, () => {
    logger.info("SMTP submission server started", {
      port,
      auth: allowInsecureAuth
        ? "plaintext (allowInsecureAuth)"
        : "disabled on this port — use the TLS port",
    });
  });

  server.on("error", (err: Error) => {
    logger.error("SMTP submission server error", { error: err.message });
  });

  /**
   * Implicit-TLS listener (SMTPS, RFC 8314). Same handlers as above; TLS
   * from the first byte, terminated by our own `tls.Server` (see the note
   * on `tlsListener`). This is the port advertised to mailbox users.
   */
  const { securePort } = config.smtpSubmission;
  if (tlsOptions && securePort > 0) {
    const smtps = new SMTPServer({ ...serverOptions, secure: true, secured: true });
    smtps.on("error", (err: Error) => {
      logger.error("SMTP submission TLS server error", { error: err.message });
    });
    const listener = createTlsServer({ ...tlsOptions, minVersion: "TLSv1.2" }, (socket) =>
      smtps.connect(socket, {}),
    );
    listener.on("tlsClientError", (err: Error) => {
      logger.debug("SMTP submission TLS handshake failed", { error: err.message });
    });
    listener.on("error", (err: Error) => {
      logger.error("SMTP submission TLS listener error", { error: err.message });
    });
    listener.listen(securePort, () => {
      logger.info("SMTP submission server started (implicit TLS)", { port: securePort });
    });
    secureServer = smtps;
    tlsListener = listener;
  }

  /**
   * Certificate renewal watcher. Let's Encrypt certs rotate every ~60
   * days; re-read the PEM files periodically and swap the TLS context in
   * place (`setSecureContext`) so SMTPS keeps presenting a valid
   * chain without restarting the server. Mirrors the Dovecot sidecar's
   * `doveadm reload` on cert change.
   */
  if (tlsOptions) {
    loadedTlsFingerprint = tlsFingerprint(tlsOptions);
    tlsReloadInterval = setInterval(
      () => {
        try {
          const fresh = {
            cert: readFileSync(tls.certPath),
            key: readFileSync(tls.keyPath),
          };
          const fp = tlsFingerprint(fresh);
          if (fp !== loadedTlsFingerprint && tlsListener) {
            tlsListener.setSecureContext(fresh);
            loadedTlsFingerprint = fp;
            logger.info("SMTP submission TLS certificate reloaded");
          }
        } catch (error) {
          logger.warn("SMTP submission TLS reload check failed", {
            error: error instanceof Error ? error.message : String(error),
          });
        }
      },
      10 * 60 * 1000,
    );
  }

  /** Periodic sweep of expired rate-limit entries (every 5 minutes). */
  cleanupInterval = setInterval(
    () => {
      const now = Date.now();
      const connMs = connectionRateLimit.windowSec * 1000;
      const authMs = config.smtpSubmission.authRateLimit.windowSec * 1000;
      for (const [ip, entry] of connectionMap) {
        if (now - entry.windowStart >= connMs) connectionMap.delete(ip);
      }
      for (const [ip, entry] of authFailureMap) {
        if (now - entry.windowStart >= authMs) authFailureMap.delete(ip);
      }
    },
    5 * 60 * 1000,
  );
}

/** Stops the SMTP submission server gracefully (called on shutdown). */
export function stop(): void {
  if (cleanupInterval) {
    clearInterval(cleanupInterval);
    cleanupInterval = null;
  }
  if (tlsReloadInterval) {
    clearInterval(tlsReloadInterval);
    tlsReloadInterval = null;
  }
  if (tlsListener) {
    tlsListener.close();
    tlsListener = null;
  }
  if (secureServer) {
    secureServer.close(() => {
      logger.info("SMTP submission TLS server stopped");
    });
    secureServer = null;
  }
  if (server) {
    server.close(() => {
      logger.info("SMTP submission server stopped");
    });
    server = null;
  }
}
