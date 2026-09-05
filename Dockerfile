# syntax=docker/dockerfile:1
#
# UNVERIFIED: written without Docker available on the development machine.
# Neither the build nor the run has ever been executed.

# --------------------------------------------------------------------- build
FROM node:22-alpine AS build

# node-gyp, in case better-sqlite3 ever has to compile. With the current version
# it does not: it declares "gypfile": false and ships prebuilt binaries for
# linuxmusl x64 and arm64. This is here for the day a platform's prebuild is
# missing, and it is discarded along with the stage.
RUN apk add --no-cache python3 make g++

WORKDIR /app

# Dependencies in their own layer: touching source does not invalidate npm ci.
COPY package.json package-lock.json ./
RUN npm ci

COPY tsconfig.json ./
COPY src ./src
COPY scripts/copy-migrations.mjs ./scripts/

RUN npm run build

# Strip node_modules down to production, keeping the native binary already
# resolved for musl. Doing it here rather than as a separate npm ci --omit=dev
# avoids resolving the dependency tree twice.
RUN npm prune --omit=dev


# ------------------------------------------------------------- runtime image
FROM node:22-alpine AS runtime

ENV NODE_ENV=production \
    SONDA_DATA_DIR=/data \
    SONDA_PORT=8080

WORKDIR /app

COPY --from=build /app/node_modules ./node_modules
COPY --from=build /app/dist ./dist
# GET /api/health reads the version from here; it is the single source.
COPY package.json ./

# No src/ and no scripts/: minting a token inside the container is done with
# dist/cli.js, which does ship compiled. The seed is left out on purpose.

# uid 1000 ('node') owns the mount point. A named volume inherits this owner and
# just works; a bind mount inherits the host directory's owner, which therefore
# has to be writable by uid 1000.
RUN mkdir -p /data && chown node:node /data
USER node

EXPOSE 8080
VOLUME /data

# Shell form on purpose, so ${SONDA_PORT} expands at run time and the health
# check keeps working when the port is changed through the environment.
# wget ships with alpine's busybox; there is no need to install curl.
#
# The timeout is generous because better-sqlite3 is synchronous, and a
# GET /api/export over a large database blocks the event loop while it runs.
HEALTHCHECK --interval=30s --timeout=5s --start-period=10s --retries=3 \
  CMD wget -q -O /dev/null "http://127.0.0.1:${SONDA_PORT:-8080}/api/health" || exit 1

# Exec form: node stays PID 1 and receives docker stop's signal directly.
# src/index.ts handles SIGTERM and shuts down cleanly, so tini is not needed.
CMD ["node", "dist/index.js"]
