FROM node:22-bookworm-slim

# Add ondrej/php PPA for multi-version PHP support
RUN apt-get update && apt-get install -y --no-install-recommends \
    ca-certificates curl gnupg lsb-release \
    && curl -fsSL https://packages.sury.org/php/apt.gpg \
       | gpg --dearmor -o /usr/share/keyrings/sury-php.gpg \
    && echo "deb [signed-by=/usr/share/keyrings/sury-php.gpg] https://packages.sury.org/php/ bookworm main" \
       > /etc/apt/sources.list.d/sury-php.list \
    && apt-get update

# Install PHP 7.4, 8.1, 8.2, 8.3, 8.4 so we can match whatever version the
# site uses. All versions are sourced from the ondrej/php PPA above.
#
# 7.4 — covers claybuck (WP) and micheal-watson-secretary-of-state (Drupal 8).
#        EOL upstream but still in service on Pantheon. Composer must resolve
#        under the real PHP version so platform constraints are not bypassed.
# 8.4 — covers bcbs-vermont; not yet in Debian Bookworm main repos.
#
# `patch` is required, not optional. cweagans/composer-patches tries `git apply
# --check` at -p1/-p0/-p2/-p4 and only falls back to the `patch` binary when all
# four fail — which they do on any Drupal repo carrying the standard
# .gitattributes (`*.inc text eol=lf whitespace=blank-at-eol,...`). Debian slim
# ships no `patch`, so without it cweagans has NO working applier and every
# committed-vendor site with patches dies at `composer install` with "Cannot
# apply patch" (composer-exit-on-patch-failure). Only the committed-vendor path
# installs packages, so only it applies patches — which is why the IC sites
# never surfaced this.
RUN apt-get install -y --no-install-recommends \
    php7.4-cli php7.4-curl php7.4-mbstring php7.4-xml php7.4-zip \
    php8.1-cli php8.1-curl php8.1-mbstring php8.1-xml php8.1-zip \
    php8.2-cli php8.2-curl php8.2-mbstring php8.2-xml php8.2-zip \
    php8.3-cli php8.3-curl php8.3-mbstring php8.3-xml php8.3-zip \
    php8.4-cli php8.4-curl php8.4-mbstring php8.4-xml php8.4-zip \
    git \
    openssh-client \
    unzip \
    patch \
    && rm -rf /var/lib/apt/lists/*

# Default to PHP 8.2 (most common on Pantheon)
RUN update-alternatives --set php /usr/bin/php8.2

# Composer — required for Drupal (Integrated Composer) staging: we clone the
# multidev, resolve composer.lock locally, and push. Pantheon builds server-side
# on push, so we only ever need the lock (composer update --no-install) — never a
# full vendor install. Invoked as `phpX.Y /usr/local/bin/composer` to match the
# site's PHP for resolution.
RUN curl -fsSL https://getcomposer.org/download/latest-stable/composer.phar \
    -o /usr/local/bin/composer \
    && chmod +x /usr/local/bin/composer \
    && php /usr/local/bin/composer --version

# Install Terminus 3 (PHP 7.x/8.0/8.1) and Terminus 4 (PHP 8.2+)
ARG TERMINUS3_VERSION=3.6.2
ARG TERMINUS4_VERSION=4.3.2
RUN curl -fsSL \
    "https://github.com/pantheon-systems/terminus/releases/download/${TERMINUS3_VERSION}/terminus.phar" \
    -o /usr/local/bin/terminus-3 \
    && chmod +x /usr/local/bin/terminus-3
RUN curl -fsSL \
    "https://github.com/pantheon-systems/terminus/releases/download/${TERMINUS4_VERSION}/terminus.phar" \
    -o /usr/local/bin/terminus-4 \
    && chmod +x /usr/local/bin/terminus-4

# Wrapper: picks php + terminus PER COMMAND from MU_TERMINUS_PHP (the site's php_version,
# set per-job by the app). No global `update-alternatives` — concurrent jobs on different
# PHP versions cannot race.
#   7.4        → php7.4  + terminus-3  (exact match — avoids wrong platform constraints)
#   7.x / 8.1  → php8.1  + terminus-3  (7.2 not packaged for Bookworm; 8.0 EOL)
#   8.2 / 8.3  → matching php + terminus-4
#   8.4+       → php8.4  + terminus-4
RUN printf '#!/bin/sh\nV="${MU_TERMINUS_PHP:-8.2}"\ncase "$V" in\n  7.4*)        exec php7.4 /usr/local/bin/terminus-3 "$@" ;;\n  7.*|8.0|8.1) exec php8.1 /usr/local/bin/terminus-3 "$@" ;;\n  8.3*)        exec php8.3 /usr/local/bin/terminus-4 "$@" ;;\n  8.4*)        exec php8.4 /usr/local/bin/terminus-4 "$@" ;;\n  *)           exec php8.2 /usr/local/bin/terminus-4 "$@" ;;\nesac\n' \
    > /usr/local/bin/terminus \
    && chmod +x /usr/local/bin/terminus \
    && terminus --version

WORKDIR /app

# Install dependencies
COPY package*.json ./
RUN npm ci

# Copy source and build
COPY . .
RUN npm run build

RUN chmod +x scripts/start.sh

EXPOSE 3000

CMD ["scripts/start.sh"]
