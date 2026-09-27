# Full Debian (glibc) base. better-sqlite3 13 needs Node >= 22 and ships prebuilt native binaries inside
# its npm package (linux x64/arm64), so nothing is compiled and no npm install scripts run during npm ci.
FROM node:22-bookworm

WORKDIR /app

ENV NODE_ENV=production

# Install dependencies first so this layer is cached until package*.json change.
# npm ci is non-interactive: it installs exactly what package-lock.json lists and never prompts.
# The second command opens an in-memory database so the build fails now, not at runtime, if the
# native better-sqlite3 binary can't load on this platform.
# Everything under /app except data/ stays owned by root (these files, node_modules from npm ci, and the
# source below), so the app, running as `node`, can read its code and config but not modify them.
COPY package.json package-lock.json ./
RUN npm ci --omit=dev \
  && node -e "new (require('better-sqlite3'))(':memory:')"

COPY . .

# SQLite lives here; mount a volume over it so the database survives container rebuilds. This is the only
# directory the app needs to write. Changing ownership of just this empty directory keeps the layer tiny.
RUN mkdir -p /app/data && chown node:node /app/data

# Run as the image's unprivileged `node` user (uid 1000) instead of root. A bind-mounted ./data keeps the
# host's ownership, so on the host run `sudo chown -R 1000:1000 data` before first start (see README).
USER node

EXPOSE 3000

CMD ["node", "server.js"]
