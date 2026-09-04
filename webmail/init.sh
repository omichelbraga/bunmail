#!/bin/sh
# ───────────────────────────────────────────────────────
# BunMail — Kurrier bootstrap against BunMail's Postgres. See Dockerfile.
#
# Env (from docker-compose):
#   DB_HOST / DB_PORT                 BunMail Postgres (default db:5432)
#   POSTGRES_USER / POSTGRES_PASSWORD superuser of that instance (bunmail)
#   KURRIER_DB_PASSWORD               password for the `kurrier` RLS role
#   BAIKAL_DB_PASSWORD                password for the `baikal` role
#   BAIKAL_ENCRYPTION_KEY             Baikal config encryption key (hex)
#   CONFIG_DIR                        shared volume for baikal.yaml/garage.toml
# ───────────────────────────────────────────────────────
set -eu

DB_HOST="${DB_HOST:-db}"; DB_PORT="${DB_PORT:-5432}"
export PGHOST="$DB_HOST" PGPORT="$DB_PORT" PGUSER="${POSTGRES_USER:-bunmail}" PGPASSWORD="${POSTGRES_PASSWORD:?POSTGRES_PASSWORD required}"
: "${KURRIER_DB_PASSWORD:?KURRIER_DB_PASSWORD required}"
: "${BAIKAL_DB_PASSWORD:?BAIKAL_DB_PASSWORD required}"
: "${BAIKAL_ENCRYPTION_KEY:?BAIKAL_ENCRYPTION_KEY required}"
CONFIG_DIR="${CONFIG_DIR:-/config}"
ADMIN_DB="${POSTGRES_DB:-bunmail}"

echo "[kurrier-init] waiting for Postgres at $PGHOST:$PGPORT"
until pg_isready -q; do sleep 2; done

# SQL-escape a literal for embedding in single quotes.
esc() { printf '%s' "$1" | sed "s/'/''/g"; }

# ── 1. Roles + databases (idempotent) ──
psql -d "$ADMIN_DB" -v ON_ERROR_STOP=1 -q <<SQL
DO \$\$
BEGIN
  IF NOT EXISTS (SELECT FROM pg_roles WHERE rolname = 'kurrier') THEN
    CREATE ROLE kurrier LOGIN PASSWORD '$(esc "$KURRIER_DB_PASSWORD")';
  ELSE
    ALTER ROLE kurrier WITH LOGIN PASSWORD '$(esc "$KURRIER_DB_PASSWORD")';
  END IF;
  IF NOT EXISTS (SELECT FROM pg_roles WHERE rolname = 'baikal') THEN
    CREATE ROLE baikal LOGIN PASSWORD '$(esc "$BAIKAL_DB_PASSWORD")';
  ELSE
    ALTER ROLE baikal WITH LOGIN PASSWORD '$(esc "$BAIKAL_DB_PASSWORD")';
  END IF;
END
\$\$;
SQL
for spec in "kurrier:$PGUSER" "baikal:baikal"; do
  name="${spec%%:*}"; owner="${spec##*:}"
  if ! psql -d "$ADMIN_DB" -tAc "SELECT 1 FROM pg_database WHERE datname = '$name'" | grep -q 1; then
    echo "[kurrier-init] creating database $name (owner $owner)"
    psql -d "$ADMIN_DB" -v ON_ERROR_STOP=1 -qc "CREATE DATABASE \"$name\" OWNER \"$owner\""
  fi
done

# ── 3. Kurrier migrations (same bookkeeping as upstream db-bootstrap.sh) ──
psql -d kurrier -v ON_ERROR_STOP=1 -q <<'SQL'
CREATE TABLE IF NOT EXISTS public.migrations (
  version text PRIMARY KEY,
  applied_at timestamptz DEFAULT now()
);
SQL
# Recover from an earlier partial run: an empty `auth` schema (created by
# the grants step or a failed attempt) makes 001 fail, since it uses
# CREATE SCHEMA without IF NOT EXISTS. Only dropped when nothing was ever
# migrated and the schema holds no tables.
if [ "$(psql -d kurrier -tAc "SELECT count(*) FROM public.migrations")" = "0" ] \
   && [ "$(psql -d kurrier -tAc "SELECT count(*) FROM information_schema.tables WHERE table_schema = 'auth'")" = "0" ]; then
  psql -d kurrier -v ON_ERROR_STOP=1 -qc "DROP SCHEMA IF EXISTS auth CASCADE"
fi
for file in $(ls /kurrier/migrations/*.sql | sort); do
  version="$(basename "$file" .sql)"
  if psql -d kurrier -tAc "SELECT 1 FROM public.migrations WHERE version = '$version'" | grep -q 1; then
    continue
  fi
  echo "[kurrier-init] applying migration $version"
  psql -d kurrier -v ON_ERROR_STOP=1 -q -f "$file"
  psql -d kurrier -v ON_ERROR_STOP=1 -qc "INSERT INTO public.migrations(version) VALUES ('$version')"
done

# ── 3b. Kurrier schema grants (upstream db/init/init.sql, password from env).
# Runs AFTER the migrations: 001 creates the `auth` schema itself (without
# IF NOT EXISTS), and the grants must cover the tables the migrations made.
sed "s/replace_with_your_password/$(esc "$KURRIER_DB_PASSWORD" | sed 's/[\/&]/\\&/g')/" /kurrier/init.sql \
  | psql -d kurrier -v ON_ERROR_STOP=1 -q

# ── 4. Baikal schema on first run ──
if ! psql -d baikal -tAc "SELECT to_regclass('public.addressbooks') IS NOT NULL" | grep -q t; then
  echo "[kurrier-init] loading Baikal schema"
  # The upstream dump comes from Postgres 18; drop the settings PG16 lacks.
  grep -vE '^SET (transaction_timeout|idle_in_transaction_session_timeout)' /kurrier/baikal-init/baikal.sql \
    | PGUSER=baikal PGPASSWORD="$BAIKAL_DB_PASSWORD" psql -d baikal -v ON_ERROR_STOP=1 -q
fi

# ── 5. Config files for the dav + garage services ──
mkdir -p "$CONFIG_DIR/baikal" "$CONFIG_DIR/garage"
cat > "$CONFIG_DIR/baikal/baikal.yaml" <<YAML
system:
    configured_version: 0.10.1
    timezone: UTC
    card_enabled: true
    cal_enabled: true
    dav_auth_type: Digest
    admin_passwordhash: $(printf '%s' "$BAIKAL_ENCRYPTION_KEY-admin-disabled" | sha256sum | cut -d' ' -f1)
    failed_access_message: 'user %u authentication failure for Baikal'
    auth_realm: BaikalDAV
    base_uri: ''
    invite_from: noreply@_
database:
    sqlite_file: /var/www/baikal/Specific/db/db.sqlite
    backend: pgsql
    mysql_host: ''
    mysql_dbname: ''
    mysql_username: ''
    mysql_password: ''
    encryption_key: $BAIKAL_ENCRYPTION_KEY
    pgsql_host: $DB_HOST
    pgsql_dbname: baikal
    pgsql_username: baikal
    pgsql_password: $BAIKAL_DB_PASSWORD
YAML
printf 'Order allow,deny\nDeny from all\n' > "$CONFIG_DIR/baikal/.htaccess"
cat > "$CONFIG_DIR/garage/garage.toml" <<'TOML'
metadata_dir = "/var/lib/garage/meta"
data_dir = "/var/lib/garage/data"
db_engine = "sqlite"
replication_factor = 1
consistency_mode = "consistent"
rpc_bind_addr = "[::]:3901"
rpc_public_addr = "127.0.0.1:3901"

[s3_api]
s3_region = "garage"
api_bind_addr = "[::]:3900"

[s3_web]
bind_addr = "[::]:3902"
root_domain = "localhost"

[admin]
api_bind_addr = "[::]:3903"
TOML
chmod -R a+rX "$CONFIG_DIR"
echo "[kurrier-init] done"
