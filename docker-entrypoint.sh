#!/bin/sh
set -eu

# Named volumes are typically owned by root:root on first run. We chown at startup
# and then drop privileges to the `node` user.
if [ "$(id -u)" = "0" ]; then
  mkdir -p /app/data
  chown -R node:node /app/data || true
  exec su-exec node "$@"
fi

exec "$@"

