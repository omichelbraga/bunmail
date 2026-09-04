# ───────────────────────────────────────────────────────
# BunMail — Dovecot IMAP/LMTP sidecar
#
# Provides real mailboxes (IMAP for Outlook / Thunderbird / Apple Mail /
# mobile clients) on top of BunMail. Dovecot never talks SMTP to the
# internet: BunMail's inbound receiver stays the MX edge and hands mail
# for enabled mailboxes to this container over LMTP on the private
# Docker network. Authentication is SQL against BunMail's own Postgres
# (`mailboxes` table) — no local user files.
#
# Alpine 3.21 ships Dovecot 2.3.21 (the last 2.3 series) with the pgsql
# and lmtpd packages we need; the image is ~30 MB.
# ───────────────────────────────────────────────────────
FROM alpine:3.21

RUN apk add --no-cache dovecot dovecot-pgsql dovecot-lmtpd openssl ca-certificates tzdata \
  && addgroup -g 5000 vmail \
  && adduser -D -H -u 5000 -G vmail -s /sbin/nologin vmail \
  && mkdir -p /var/mail /etc/dovecot/certs /run/dovecot \
  && chown -R vmail:vmail /var/mail \
  && rm -f /etc/dovecot/conf.d/*.conf /etc/dovecot/dovecot.conf

COPY conf/dovecot.conf /etc/dovecot/dovecot.conf
COPY conf/dovecot-sql.conf.ext.template /etc/dovecot/dovecot-sql.conf.ext.template
COPY entrypoint.sh /entrypoint.sh
RUN chmod +x /entrypoint.sh

# 24 = LMTP (private network only, never publish), 143 = IMAP+STARTTLS, 993 = IMAPS
EXPOSE 24 143 993

VOLUME ["/var/mail"]

HEALTHCHECK --interval=30s --timeout=5s --start-period=15s --retries=3 \
  CMD doveadm service status imap-login >/dev/null 2>&1 || exit 1

ENTRYPOINT ["/entrypoint.sh"]
