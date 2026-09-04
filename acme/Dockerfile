# ───────────────────────────────────────────────────────
# BunMail — Let's Encrypt sidecar (acme.sh, DNS-01 via Cloudflare)
#
# Issues one certificate covering the mail hostnames (mail., imap.,
# smtp.) and keeps it renewed. DNS-01 is used instead of HTTP-01 because
# the mail hostnames are DNS-only (never proxied) and the HTTP edge is
# owned by the reverse proxy. The resulting PEM pair is written to the
# shared `/certs` volume that Dovecot (IMAPS) and BunMail (SMTP
# submission STARTTLS) read; both reload on change without a restart.
# ───────────────────────────────────────────────────────
FROM neilpang/acme.sh:3.1.1

COPY entrypoint.sh /bunmail-acme.sh
RUN chmod +x /bunmail-acme.sh

ENTRYPOINT ["/bunmail-acme.sh"]
