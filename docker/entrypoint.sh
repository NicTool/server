#!/bin/sh
set -e

TOML="/data/etc/nictool.toml"
mkdir -p /data/etc

if [ ! -f "$TOML" ]; then
  cat > "$TOML" <<EOF
configured = true

[store]
type = "${NICTOOL_STORE_TYPE:-mysql}"
host = "${NICTOOL_DB_HOST:-db}"
port = ${NICTOOL_DB_PORT:-3306}
user = "${NICTOOL_DB_USER:-nictool}"
password = "${NICTOOL_DB_USER_PASSWORD}"
database = "${NICTOOL_DB_NAME:-nictool}"

[api]
mode = "remote"
host = "${NICTOOL_API_HOST:-api}"
port = ${NICTOOL_API_PORT:-3000}
EOF
  echo "Generated $TOML"
fi

exec node bin/start.js -c /data
