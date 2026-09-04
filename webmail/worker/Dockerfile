# ───────────────────────────────────────────────────────
# BunMail — Kurrier worker image with a packaging fix
#
# The upstream v4.0.0 worker image ships tree-shaken copies of `nodemailer`
# under `.output/server/node_modules/.nitro/` that lack `lib/nodemailer.js`,
# so the worker crashes on boot with ERR_MODULE_NOT_FOUND. This overlay
# restores every bundled version to a complete package: from the image's
# pnpm store when that version is there, otherwise from the npm registry.
# Drop this Dockerfile (use the upstream image directly) once a fixed
# release is published.
# ───────────────────────────────────────────────────────
ARG KURRIER_VERSION=v4.0.0
FROM ghcr.io/kurrier-org/kurrier-worker:${KURRIER_VERSION}

RUN set -eu; \
  for dst in /app/.output/server/node_modules/.nitro/nodemailer@*; do \
    ver="${dst##*@}"; \
    src="/app/node_modules/.pnpm/nodemailer@${ver}/node_modules/nodemailer"; \
    if [ -d "$src" ]; then \
      cp -a "$src/." "$dst/"; \
    else \
      tmp="$(mktemp -d)"; cd "$tmp"; \
      npm pack "nodemailer@${ver}" --silent >/dev/null; \
      tar -xzf nodemailer-*.tgz; cp -a package/. "$dst/"; \
      cd /; rm -rf "$tmp"; \
    fi; \
    test -f "$dst/lib/nodemailer.js"; \
    echo "restored nodemailer@${ver}"; \
  done; \
  npm cache clean --force >/dev/null 2>&1 || true
