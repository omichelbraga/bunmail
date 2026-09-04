# Webmail (Kurrier)

BunMail ships an optional, modern webmail for mailbox users:
[Kurrier](https://github.com/kurrier-org/kurrier) (AGPL-3.0). It is a separate
product running beside BunMail in `docker-compose.yml` — BunMail is not
modified for it. Users sign in with their mailbox address and password
(see [docs/mailboxes.md](mailboxes.md)); Kurrier talks IMAP to Dovecot and
SMTPS to BunMail's submission port, exactly like a desktop client would.

## What runs

| Service | Image | Role |
|---|---|---|
| `kurrier-init` | built from `webmail/` | one-shot: creates the `kurrier` and `baikal` databases **in BunMail's Postgres**, applies Kurrier's migrations, renders config files |
| `kurrier-web` | `ghcr.io/kurrier-org/kurrier-web` | the UI (port 3000, the only service with a domain) |
| `worker` | `ghcr.io/kurrier-org/kurrier-worker` | IMAP sync + API. **Name is fixed** — it is compiled into the web image's rewrites |
| `dav` | `ckulka/baikal` | CalDAV/CardDAV for calendars and contacts. **Name is fixed** for the same reason |
| `kurrier-redis`, `kurrier-typesense`, `kurrier-garage` | upstream images | queue/cache, full-text search, S3 store for bodies and attachments |

Kurrier keeps its own copy of each synced mailbox (Postgres + Garage), so
disk usage is roughly doubled for mailboxes opened in the webmail.

## Setup

1. Set the `KURRIER_*` / `BAIKAL_*` variables from `.env.example` (all secrets
   are random strings). `KURRIER_WEB_URL` is the public URL, e.g.
   `https://webmail.example.com`, served by your reverse proxy to
   `kurrier-web:3000`.
2. Deploy. `kurrier-init` runs first; the other services wait for it.
3. Open `/auth/signup`, create the first account, then set
   `KURRIER_DISABLE_SIGNUP=true` and restart `kurrier-web` so strangers cannot
   register on your instance.
4. In Kurrier, **Add mailbox → BunMail** (the preset built from
   `MAILBOX_IMAP_HOST` / `MAILBOX_SMTP_HOST`) and enter the mailbox address and
   password. The worker verifies IMAP/SMTP and starts syncing.

Calendars and contacts sync to external clients through the web URL
(`/.well-known/caldav`, `/.well-known/carddav` are proxied to Baikal).

## Removing it

Delete the `kurrier-*`, `worker` and `dav` services and the `kurrier_*`
volumes from `docker-compose.yml`, then drop the `kurrier` and `baikal`
databases and roles from Postgres. BunMail itself is unaffected.
