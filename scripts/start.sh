#!/bin/sh
set -e

# Authenticate Terminus with machine token (non-fatal — Next.js starts regardless)
if [ -n "$TERMINUS_TOKEN" ]; then
  echo "[startup] Authenticating Terminus..."
  if terminus auth:login --machine-token="$TERMINUS_TOKEN" 2>&1; then
    echo "[startup] Terminus authenticated as: $(terminus auth:whoami 2>/dev/null || echo 'unknown')"
  else
    echo "[startup] WARNING: Terminus auth failed — jobs may fail until Pantheon API recovers"
  fi
else
  echo "[startup] WARNING: TERMINUS_TOKEN not set — jobs will fail"
fi

# Set up SSH key for Pantheon git access (needed for upstream conflict revert)
if [ -n "$PANTHEON_SSH_KEY" ]; then
  echo "[startup] Configuring SSH key..."
  mkdir -p ~/.ssh
  echo "$PANTHEON_SSH_KEY" > ~/.ssh/id_rsa
  chmod 600 ~/.ssh/id_rsa
  ssh-keyscan -p 2222 codeserver.dev.drush.in >> ~/.ssh/known_hosts 2>/dev/null || true
  echo "[startup] SSH key configured"
else
  echo "[startup] NOTE: PANTHEON_SSH_KEY not set — upstream conflict auto-revert will be skipped"
fi

echo "[startup] Starting MU WP Staging..."
exec node_modules/.bin/next start -p "${PORT:-3000}"
