FROM node:22-bookworm-slim

# Install PHP (required by Terminus), git, and SSH client
RUN apt-get update && apt-get install -y --no-install-recommends \
    ca-certificates \
    php-cli \
    php-curl \
    php-mbstring \
    php-xml \
    php-zip \
    curl \
    git \
    openssh-client \
    unzip \
    && rm -rf /var/lib/apt/lists/*

# Install Terminus (pinned version — update ARG to upgrade)
ARG TERMINUS_VERSION=4.3.2
RUN curl -fsSL \
    "https://github.com/pantheon-systems/terminus/releases/download/${TERMINUS_VERSION}/terminus.phar" \
    -o /usr/local/bin/terminus \
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
