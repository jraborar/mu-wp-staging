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

# Set up SSH key — REQUIRED for all terminus wp (WP-CLI) commands.
# Without this, plugin/theme updates and cache flush will fail with Permission denied.
if [ -n "$PANTHEON_SSH_KEY" ]; then
  echo "[startup] Configuring SSH key..."
  mkdir -p ~/.ssh
  echo "$PANTHEON_SSH_KEY" | base64 -d > ~/.ssh/id_rsa
  chmod 600 ~/.ssh/id_rsa

  # Trust all Pantheon hosts (codeserver + appserver) without interactive prompts
  cat >> ~/.ssh/config <<'EOF'
Host *.drush.in
  StrictHostKeyChecking no
  UserKnownHostsFile /dev/null
  Port 2222
  IdentityFile ~/.ssh/id_rsa
EOF

  echo "[startup] SSH key configured for *.drush.in"
else
  echo "[startup] WARNING: PANTHEON_SSH_KEY not set — WP-CLI commands (plugin/theme updates, cache flush) will fail"
fi

echo "[startup] Starting MU WP Staging..."
exec node_modules/.bin/next start -p "${PORT:-3000}"
