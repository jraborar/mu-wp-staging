FROM node:22-bookworm-slim

# Add ondrej/php PPA for multi-version PHP support
RUN apt-get update && apt-get install -y --no-install-recommends \
    ca-certificates curl gnupg lsb-release \
    && curl -fsSL https://packages.sury.org/php/apt.gpg \
       | gpg --dearmor -o /usr/share/keyrings/sury-php.gpg \
    && echo "deb [signed-by=/usr/share/keyrings/sury-php.gpg] https://packages.sury.org/php/ bookworm main" \
       > /etc/apt/sources.list.d/sury-php.list \
    && apt-get update

# Install PHP 8.1, 8.2, 8.3 so we can match whatever version the site uses
RUN apt-get install -y --no-install-recommends \
    php8.1-cli php8.1-curl php8.1-mbstring php8.1-xml php8.1-zip \
    php8.2-cli php8.2-curl php8.2-mbstring php8.2-xml php8.2-zip \
    php8.3-cli php8.3-curl php8.3-mbstring php8.3-xml php8.3-zip \
    git \
    openssh-client \
    unzip \
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
# set per-job by the app). ≤8.1 → php8.1 + terminus-3; 8.2+ → php8.2 + terminus-4.
# No global `update-alternatives` — concurrent jobs on different PHP versions can't race.
RUN printf '#!/bin/sh\nV="${MU_TERMINUS_PHP:-8.2}"\ncase "$V" in\n  7.*|8.0|8.1) exec php8.1 /usr/local/bin/terminus-3 "$@" ;;\n  *)           exec php8.2 /usr/local/bin/terminus-4 "$@" ;;\nesac\n' \
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
