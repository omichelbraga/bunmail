# ───────────────────────────────────────────────────────
# BunMail — STARTTLS front for the inbound SMTP receiver
#
# See proxy.py for the why. Pure standard library (asyncio + ssl), no
# dependencies. Runs as an unprivileged user; the container publishes 25
# but the process listens on 2525 (mapped in docker-compose).
# ───────────────────────────────────────────────────────
FROM python:3.12-alpine

# Runs as root only to read the 0600 private key on the shared certs
# volume (same as Dovecot); the process is ~200 lines of stdlib code.
WORKDIR /app
COPY proxy.py /app/proxy.py

ENV LISTEN_PORT=2525 BACKEND_HOST=app BACKEND_PORT=25 CERT_FILE=/certs/fullchain.pem KEY_FILE=/certs/privkey.pem PYTHONUNBUFFERED=1

EXPOSE 2525

HEALTHCHECK --interval=30s --timeout=5s --start-period=5s --retries=3 \
  CMD python3 -c "import socket; s=socket.create_connection(('127.0.0.1', 2525), 3); s.recv(64); s.close()" || exit 1

CMD ["python3", "/app/proxy.py"]
