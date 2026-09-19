#!/bin/sh
# Railway volume mounts arrive owned by root, but the server runs as the
# unprivileged `app` user. Hand the data volume over, then drop privileges.
set -e
mkdir -p /app/data
chown -R app:app /app/data
if command -v setpriv >/dev/null 2>&1; then
  exec setpriv --reuid app --regid app --clear-groups node mcp/dist/http.js
else
  exec su -s /bin/sh app -c 'exec node mcp/dist/http.js'
fi
