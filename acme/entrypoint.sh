#!/bin/sh
# ───────────────────────────────────────────────────────
# BunMail — acme.sh sidecar entrypoint
#
# Env:
#   ACME_DOMAINS   space-separated hostnames; first one is the cert's CN
#   ACME_EMAIL     Let's Encrypt account email
#   CF_Token       Cloudflare API token with Zone:DNS:Edit on the zone
#   CF_Zone_ID     Cloudflare zone id (optional but avoids zone lookup)
#   CF_Account_ID  Cloudflare account id (optional)
#   ACME_STAGING   "true" → use the Let's Encrypt staging CA (rate-limit safe)
#
# Behaviour:
#   1. If /certs is empty, write a temporary self-signed pair immediately
#      so Dovecot / BunMail can start (they reload when the real cert lands).
#   2. Issue the Let's Encrypt cert if missing, install it to /certs.
#   3. Run the acme.sh cron loop for renewals (re-installs on renew).
# ───────────────────────────────────────────────────────
set -eu

CERT_DIR="${CERT_DIR:-/certs}"
ACME_HOME="${LE_WORKING_DIR:-/acme.sh}"
DOMAINS="${ACME_DOMAINS:?ACME_DOMAINS is required (space-separated hostnames)}"
EMAIL="${ACME_EMAIL:?ACME_EMAIL is required}"
: "${CF_Token:?CF_Token is required for DNS-01 (Cloudflare)}"
PRIMARY="$(printf '%s' "$DOMAINS" | awk '{print $1}')"
SERVER="letsencrypt"
[ "${ACME_STAGING:-false}" = "true" ] && SERVER="letsencrypt_test"

mkdir -p "$CERT_DIR"

# ── 1. Placeholder so dependants can boot ──
if [ ! -s "$CERT_DIR/fullchain.pem" ] || [ ! -s "$CERT_DIR/privkey.pem" ]; then
  echo "[acme] no certificate yet — writing temporary self-signed placeholder for $PRIMARY"
  openssl req -x509 -newkey rsa:2048 -nodes -days 7 -subj "/CN=$PRIMARY" \
    -keyout "$CERT_DIR/privkey.pem" -out "$CERT_DIR/fullchain.pem" >/dev/null 2>&1
  touch "$CERT_DIR/.placeholder"
fi
chmod 644 "$CERT_DIR/fullchain.pem"; chmod 600 "$CERT_DIR/privkey.pem"

# ── 2. Issue + install ──
DOMAIN_ARGS=""
for d in $DOMAINS; do DOMAIN_ARGS="$DOMAIN_ARGS -d $d"; done

acme.sh --home "$ACME_HOME" --register-account -m "$EMAIL" --server "$SERVER" >/dev/null 2>&1 || true

issue_and_install() {
  echo "[acme] issuing certificate for: $DOMAINS (server=$SERVER)"
  # shellcheck disable=SC2086
  if acme.sh --home "$ACME_HOME" --issue --dns dns_cf $DOMAIN_ARGS \
       --server "$SERVER" --keylength ec-256 --dnssleep 30; then
    :
  else
    rc=$?
    # 2 = "domains not changed, skipping" — cert already valid, fine.
    if [ "$rc" != "2" ]; then
      echo "[acme] issue failed (rc=$rc) — keeping current files in $CERT_DIR"
      return 1
    fi
  fi
  acme.sh --home "$ACME_HOME" --install-cert -d "$PRIMARY" --ecc \
    --fullchain-file "$CERT_DIR/fullchain.pem" \
    --key-file "$CERT_DIR/privkey.pem" \
    --reloadcmd "chmod 644 $CERT_DIR/fullchain.pem; chmod 600 $CERT_DIR/privkey.pem; rm -f $CERT_DIR/.placeholder; echo '[acme] certificate installed to $CERT_DIR'"
}

if [ -f "$CERT_DIR/.placeholder" ] || [ ! -d "$ACME_HOME/${PRIMARY}_ecc" ]; then
  # Retry in the background so a transient DNS/API hiccup doesn't leave
  # the container exited; the cron loop below keeps the container alive.
  (
    n=0
    until issue_and_install; do
      n=$((n+1)); [ $n -ge 20 ] && { echo "[acme] giving up after $n attempts"; exit 1; }
      echo "[acme] retrying in 5 minutes (attempt $n)"; sleep 300
    done
  ) &
else
  echo "[acme] certificate for $PRIMARY already issued — renewals handled by cron"
  # Make sure the installed files match what acme.sh has (e.g. new volume).
  issue_and_install || true
fi

# ── 3. Renewal loop (acme.sh --cron, daily) ──
echo "[acme] entering renewal loop"
while true; do
  sleep 86400
  acme.sh --home "$ACME_HOME" --cron || echo "[acme] cron run failed"
done
