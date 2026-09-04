# ───────────────────────────────────────────────────────
# BunMail — STARTTLS front for the inbound SMTP receiver
#
# See proxy.py for the why. Pure standard library (asyncio + ssl), no
# dependencies. Listens on LISTEN_PORT (docker-compose sets it to the
# public SMTP port so the mapping is 25:25 — host firewalls filtering the
# DOCKER-USER chain match the post-DNAT container port).
# ───────────────────────────────────────────────────────
FROM python:3.12-alpine

# Runs as root only to read the 0600 private key on the shared certs
# volume (same as Dovecot); the process is ~200 lines of stdlib code.
WORKDIR /app
COPY proxy.py /app/proxy.py

ENV LISTEN_PORT=25 BACKEND_HOST=app BACKEND_PORT=25 CERT_FILE=/certs/fullchain.pem KEY_FILE=/certs/privkey.pem PYTHONUNBUFFERED=1

EXPOSE 25

HEALTHCHECK --interval=30s --timeout=5s --start-period=5s --retries=3 \
  CMD python3 -c "import os,socket; s=socket.create_connection(('127.0.0.1', int(os.environ.get('LISTEN_PORT','25'))), 3); s.recv(64); s.close()" || exit 1

CMD ["python3", "/app/proxy.py"]
