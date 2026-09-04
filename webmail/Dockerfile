# ───────────────────────────────────────────────────────
# BunMail — Kurrier webmail bootstrap (one-shot init container)
#
# Kurrier (https://github.com/kurrier-org/kurrier, AGPL-3.0) is the webmail
# UI offered to mailbox users. Its official compose ships two dedicated
# Postgres containers; here both of its databases (`kurrier` and `baikal`
# for CalDAV/CardDAV) live in BunMail's existing Postgres instead.
#
# This image runs once per deploy, before the Kurrier services start:
#   1. creates the roles/databases if missing,
#   2. applies Kurrier's SQL migrations (idempotent, tracked like upstream),
#   3. loads the Baikal schema on first run,
#   4. renders the Baikal + Garage config files into a shared volume.
#
# Kurrier's `db/init` tree is fetched from the pinned release tag at build
# time, so nothing from Kurrier is vendored into this repository.
# ───────────────────────────────────────────────────────
FROM postgres:16-alpine

ARG KURRIER_VERSION=v4.0.0

RUN apk add --no-cache curl tar \
  && mkdir -p /kurrier \
  && curl -fsSL "https://github.com/kurrier-org/kurrier/archive/refs/tags/${KURRIER_VERSION}.tar.gz" \
     | tar -xz -C /kurrier --strip-components=3 --wildcards "kurrier-*/db/init/*" \
  && ls /kurrier/migrations >/dev/null

COPY init.sh /init.sh
RUN chmod +x /init.sh

ENTRYPOINT ["/init.sh"]
