#!/bin/sh
# ───────────────────────────────────────────────────────
# BunMail — Dovecot container entrypoint
#
#   1. Render dovecot-sql.conf.ext from env (DB credentials).
#   2. Make sure a TLS cert pair exists (temporary self-signed until the
#      acme sidecar delivers the Let's Encrypt one on the shared volume).
#   3. Start Dovecot in the foreground.
#   4. Watch the cert files; `doveadm reload` when they change so renewals
#      apply without a restart.
# ───────────────────────────────────────────────────────
set -eu

DB_HOST="${DB_HOST:-db}"
DB_PORT="${DB_PORT:-5432}"
DB_NAME="${POSTGRES_DB:-bunmail}"
DB_USER="${POSTGRES_USER:-bunmail}"
DB_PASSWORD="${POSTGRES_PASSWORD:?POSTGRES_PASSWORD is required}"
CERT_DIR="${CERT_DIR:-/certs}"
CERT_FILE="$CERT_DIR/fullchain.pem"
KEY_FILE="$CERT_DIR/privkey.pem"
MAIL_HOSTNAME="${MAIL_HOSTNAME:-localhost}"

# ── 1. SQL config (mode 600: it carries the DB password) ──
# Escape sed-special characters in the password so `&`, `/`, `\` survive.
esc() { printf '%s' "$1" | sed -e 's/[\/&\\]/\\&/g'; }
sed \
  -e "s/__DB_HOST__/$(esc "$DB_HOST")/" \
  -e "s/__DB_PORT__/$(esc "$DB_PORT")/" \
  -e "s/__DB_NAME__/$(esc "$DB_NAME")/" \
  -e "s/__DB_USER__/$(esc "$DB_USER")/" \
  -e "s/__DB_PASSWORD__/$(esc "$DB_PASSWORD")/" \
  /etc/dovecot/dovecot-sql.conf.ext.template > /etc/dovecot/dovecot-sql.conf.ext
chmod 600 /etc/dovecot/dovecot-sql.conf.ext

# ── 2. TLS material ──
mkdir -p /etc/dovecot/certs
install_certs() {
  if [ -s "$CERT_FILE" ] && [ -s "$KEY_FILE" ]; then
    cp "$CERT_FILE" /etc/dovecot/certs/fullchain.pem
    cp "$KEY_FILE" /etc/dovecot/certs/privkey.pem
    echo "[dovecot-entrypoint] using certificate from $CERT_DIR"
    return 0
  fi
  return 1
}
if ! install_certs; then
  echo "[dovecot-entrypoint] no certificate in $CERT_DIR yet — generating a temporary self-signed one for $MAIL_HOSTNAME"
  openssl req -x509 -newkey rsa:2048 -nodes -days 30 \
    -subj "/CN=$MAIL_HOSTNAME" \
    -keyout /etc/dovecot/certs/privkey.pem \
    -out /etc/dovecot/certs/fullchain.pem >/dev/null 2>&1
fi
chmod 600 /etc/dovecot/certs/privkey.pem

mkdir -p /var/mail && chown vmail:vmail /var/mail

# ── 3. Start Dovecot ──
dovecot -F &
DOVECOT_PID=$!
trap 'kill -TERM $DOVECOT_PID 2>/dev/null; wait $DOVECOT_PID' TERM INT

# ── 4. Certificate watcher ──
# Reload when the shared-volume cert changes (initial issue or renewal).
(
  last=""
  while kill -0 $DOVECOT_PID 2>/dev/null; do
    if [ -s "$CERT_FILE" ] && [ -s "$KEY_FILE" ]; then
      cur="$(cat "$CERT_FILE" "$KEY_FILE" | md5sum | cut -d' ' -f1)"
      if [ "$cur" != "$last" ]; then
        if [ -n "$last" ] || ! cmp -s "$CERT_FILE" /etc/dovecot/certs/fullchain.pem; then
          install_certs && doveadm reload && echo "[dovecot-entrypoint] certificate reloaded"
        fi
        last="$cur"
      fi
    fi
    sleep 60
  done
) &

wait $DOVECOT_PID
