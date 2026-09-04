# Mailboxes Module (IMAP via Dovecot)

Adds **real mailboxes** to BunMail: an address like `mike@example.com` that a
person configures in Outlook, Thunderbird, Apple Mail, iPhone or Android over
IMAP, using the same credentials to send through BunMail's SMTP submission
server.

BunMail stays the core. Nothing about the REST API, the outbound queue, DKIM,
webhooks, inbound processing or the dashboard is replaced — a mailbox is an
*additional destination* for mail BunMail already receives, and mailbox
credentials are an *additional credential type* on the SMTP server BunMail
already runs.

## Architecture

```
Internet ──SMTP:25──▶ BunMail inbound receiver (unchanged: DNSBL, rate limit,
                      │                          registered-domain check)
                      ├─▶ recipient is an enabled mailbox?
                      │     └─▶ LMTP :24 (private network) ──▶ Dovecot ──▶ Maildir
                      │                                            │
                      └─▶ normal BunMail processing (unchanged):   │
                          bounce / DMARC branching, inbound_emails, │
                          email.received webhook, notifications    │
                                                                    ▼
Outlook / Thunderbird / Apple Mail ◀──IMAPS:993 (TLS)──────────── Dovecot
                                   ──SMTPS:465 (TLS, mailbox login)──────▶ BunMail submission
                                                                            └─▶ createEmail → queue → DKIM → MX
```

- **Dovecot** (`dovecot/`): Alpine + Dovecot 2.3, IMAP on 993 (implicit TLS)
  and 143 (STARTTLS), LMTP on 24 (never published). Maildir under
  `/var/mail/<domain>/<local>` on the persistent `maildata` volume.
- **Auth**: Dovecot's SQL passdb/userdb query BunMail's own Postgres
  (`mailboxes` table). No local user files. Passwords are stored as
  `{BLF-CRYPT}$2b$12$…` (bcrypt) — produced by `Bun.password`, verified
  natively by Dovecot.
- **Delivery**: the inbound receiver hands the raw message to Dovecot over
  LMTP **before** any BunMail persistence. A Dovecot outage yields SMTP `451`
  so the sender retries (nothing was stored, so the retry can't duplicate a
  row or a webhook). Recipients that aren't enabled mailboxes — programmable
  addresses like `reply+123@…`, disabled mailboxes — are simply skipped by
  this step and flow through BunMail as before. Mailbox mail also continues
  through BunMail, so it still appears under Inbound, the API and webhooks.
- **Sending**: the SMTP submission server (#120) accepts `user@domain` +
  mailbox password in addition to API keys, on a new implicit-TLS listener
  (SMTPS, port 465). Clients get 465 rather than 587 because the STARTTLS
  socket upgrade `smtp-server` performs is not implemented by Bun, so the
  587 handshake never completes. The `From` is pinned to the
  mailbox address. Emails are attributed to a restricted system API key named
  `Mailbox SMTP (system)` (its secret is discarded at creation; it exists only
  so `emails.api_key_id` stays NOT NULL and the dashboard filters keep working).
- **TLS**: the `acme` sidecar issues one Let's Encrypt certificate for the mail
  hostnames via Cloudflare DNS-01 and writes it to the shared `certs` volume.
  Dovecot reloads on change; BunMail swaps the STARTTLS context in place.

## Database

Table: `mailboxes` (migration `0013_mailboxes`)

| Column        | Type         | Constraints                                        |
|---------------|--------------|----------------------------------------------------|
| id            | varchar(36)  | PK, prefixed `mbx_`                                |
| domain_id     | varchar(36)  | FK → domains.id, ON DELETE CASCADE                 |
| email         | varchar(255) | NOT NULL, UNIQUE, lower-cased (Dovecot `user`)     |
| local_part    | varchar(64)  | NOT NULL, lower-cased                              |
| password_hash | varchar(255) | NOT NULL, `{BLF-CRYPT}` + bcrypt (Dovecot `password`) |
| quota_bytes   | bigint       | NOT NULL, default 1 GiB (Dovecot `quota_rule`)     |
| enabled       | boolean      | NOT NULL, default true                             |
| created_at    | timestamp    | NOT NULL, default `now()`                          |
| updated_at    | timestamp    | NOT NULL, default `now()`                          |

Dovecot's queries (`dovecot/conf/dovecot-sql.conf.ext.template`) filter on
`enabled = true`, so disabling a mailbox blocks IMAP login, SMTP AUTH and LMTP
delivery at once. Deleting a mailbox removes the row only; the Maildir stays on
the volume until an operator removes `/var/mail/<domain>/<local>`.

## Configuration

| Env Variable                 | Default        | Description |
|------------------------------|----------------|-------------|
| `MAILBOXES_ENABLED`          | `false`        | Master switch for LMTP delivery + mailbox SMTP AUTH. Management works regardless. |
| `MAILBOX_LMTP_HOST` / `_PORT`| `dovecot` / `24` | Dovecot LMTP endpoint on the private network. |
| `MAILBOX_DEFAULT_QUOTA_MB`   | `1024`         | Quota for new mailboxes. |
| `MAILBOX_IMAP_HOST` / `_PORT`| `MAIL_HOSTNAME` / `993` | Shown to users in client settings. |
| `MAILBOX_SMTP_HOST`          | `MAIL_HOSTNAME`| Shown to users (port = `SMTP_SUBMISSION_TLS_PORT`, 465). |
| `MAILBOX_SMTP_AUTH_ENABLED`  | `true`         | Accept mailbox credentials on the submission server. |
| `IMAPS_PORT` / `IMAP_PORT`   | `993` / `143`  | Host ports for Dovecot in docker-compose. |
| `ACME_DOMAINS`               | `MAIL_HOSTNAME`| Space-separated hostnames on the cert (first = CN). |
| `ACME_EMAIL`                 | —              | Let's Encrypt account email (required). |
| `CF_DNS_API_TOKEN`           | —              | Cloudflare token with Zone → DNS → Edit (required). |
| `CF_ZONE_ID` / `CF_ACCOUNT_ID` | —            | Optional; skip zone lookup. |
| `ACME_STAGING`               | `false`        | Use the LE staging CA while testing. |

The submission server must have `SMTP_SUBMISSION_ENABLED=true`; docker-compose
points `SMTP_SUBMISSION_TLS_CERT/KEY` at the acme volume, which opens the
implicit-TLS listener on `SMTP_SUBMISSION_TLS_PORT` (465).

## DNS

For a domain `example.com` served from `203.0.113.10`:

| Type | Host     | Value                                   | Proxy    |
|------|----------|-----------------------------------------|----------|
| A    | `mail`   | `203.0.113.10`                          | DNS-only |
| A    | `imap`   | `203.0.113.10`                          | DNS-only |
| A    | `smtp`   | `203.0.113.10`                          | DNS-only |
| MX   | `@`      | `mail.example.com` (10)                 | —        |
| TXT  | `@`      | `v=spf1 mx ip4:203.0.113.10 -all`       | —        |
| TXT  | `_dmarc` | `v=DMARC1; p=quarantine; rua=mailto:postmaster@example.com` | — |
| TXT  | `bunmail._domainkey` | from `POST /api/v1/domains`     | —        |

SMTP and IMAP **cannot** go through Cloudflare's HTTP proxy — keep those
records DNS-only. The PTR of the server IP should be `mail.example.com`.

## Dashboard

**Mailboxes** (`/dashboard/mailboxes`): create (local part + registered domain
+ password + quota), change password, set quota, enable/disable, delete, and a
"Mail client settings" card with a copy button.

## API Endpoints

Admin key required (like domains / api-keys). Rate-limited.

| Method | Path                      | Description                          |
|--------|---------------------------|--------------------------------------|
| POST   | `/api/v1/mailboxes`       | `{ email, password, quotaMb? }` → 201 |
| GET    | `/api/v1/mailboxes`       | List                                  |
| GET    | `/api/v1/mailboxes/:id`   | Get (includes `clientSettings`)       |
| PATCH  | `/api/v1/mailboxes/:id`   | `{ password?, quotaMb?, enabled? }`   |
| DELETE | `/api/v1/mailboxes/:id`   | Delete row                            |

Errors: `400 MAILBOX_INVALID` (bad address / weak password / unregistered
domain), `409 MAILBOX_EXISTS`.

## Mail client setup

| Setting          | Value                                   |
|------------------|-----------------------------------------|
| Incoming (IMAP)  | `imap.example.com`, port 993, SSL/TLS   |
| Outgoing (SMTP)  | `smtp.example.com`, port 465, SSL/TLS   |
| Username         | full address (`mike@example.com`)       |
| Password         | mailbox password                        |

## Abuse controls

- Inbound (25) still only accepts registered domains — no open relay.
- Submission (SMTPS 465) requires AUTH over TLS; mailbox logins may only send
  `From` their own address; per-IP failed-AUTH lockout (#133) applies to
  mailbox logins. The plaintext port (587) is not published.
- Dovecot: `ssl = required`, `disable_plaintext_auth = yes`, bcrypt cost 12,
  per-user connection cap, quota enforced at LMTP time (`552` when full).
- `SMTP_SUBMISSION_DAILY_QUOTA` caps sends per key per day; mailbox sends share
  the system key's quota (a coarse global cap on mailbox outbound).
- Publish SPF `-all`, DKIM and DMARC so third parties can't spoof the domain;
  BunMail ingests the DMARC reports sent to `postmaster@`.
- Run fail2ban on the host watching Dovecot / BunMail AUTH failures (see
  [docs/self-hosting.md](self-hosting.md#fail2ban-for-imap--smtp-auth)).

## Testing

```bash
# IMAP login
openssl s_client -connect imap.example.com:993 -crlf -quiet
a LOGIN mike@example.com 'password'
b LIST "" "*"
c LOGOUT

# Send through the submission server with mailbox credentials
swaks --to you@gmail.com --from mike@example.com --server smtp.example.com:465 \
      --tlsc --auth-user mike@example.com --auth-password 'password'
```

## Limitations (v1)

- No aliases yet (`support@` → `mike@`); planned as a follow-up.
- Sent mail from a client is not copied into the IMAP `Sent` folder by the
  server; mail clients do this themselves (all major ones do).
- Sieve/filters, shared folders and webmail are out of scope.
