# syntax=docker/dockerfile:1
#
# SIN VERIFICAR: escrito sin Docker disponible en la máquina de desarrollo.
# Ni el build ni el run se han ejecutado nunca. Ver docs/readme-notes.md.

# ---------------------------------------------------------------- compilación
FROM node:22-alpine AS build

# node-gyp, por si better-sqlite3 tuviera que compilarse.
# Con la versión actual no llega a hacerlo: declara "gypfile": false y trae
# binarios precompilados para linuxmusl x64 y arm64. Esto está aquí para el día
# que falte el prebuild de una plataforma, y se descarta con la etapa.
RUN apk add --no-cache python3 make g++

WORKDIR /app

# Las dependencias en su propia capa: tocar el código no invalida el npm ci.
COPY package.json package-lock.json ./
RUN npm ci

COPY tsconfig.json ./
COPY src ./src
COPY scripts/copy-migrations.mjs ./scripts/

# tsc a dist/ y copia de los .sql de migración junto al JS que los lee.
RUN npm run build

# Deja node_modules solo con producción, conservando el binario nativo ya
# resuelto para musl. Hacerlo aquí y no un npm ci --omit=dev aparte evita
# resolver las dependencias dos veces.
RUN npm prune --omit=dev


# --------------------------------------------------------------- imagen final
FROM node:22-alpine AS runtime

ENV NODE_ENV=production \
    SONDA_DATA_DIR=/data \
    SONDA_PORT=8080

WORKDIR /app

COPY --from=build /app/node_modules ./node_modules
COPY --from=build /app/dist ./dist
# GET /api/health lee la versión de aquí; es la única fuente.
COPY package.json ./

# Nada de src/ ni de scripts/: acuñar tokens dentro del contenedor se hace con
# dist/cli.js, que sí viaja compilado. El seed se queda fuera a propósito, no
# tiene sentido sembrar datos falsos en producción.

# El uid 1000 ('node') es el dueño del punto de montaje. Un volumen con nombre
# hereda este dueño y funciona sin tocar nada; un bind mount hereda el del
# directorio del host, que tiene que ser escribible por el uid 1000.
RUN mkdir -p /data && chown node:node /data
USER node

EXPOSE 8080
VOLUME /data

# En forma shell a propósito, para que ${SONDA_PORT} se expanda al arrancar y el
# healthcheck siga valiendo si se cambia el puerto por variable de entorno.
# wget viene en el busybox de alpine: no hace falta instalar curl.
#
# El timeout es generoso porque better-sqlite3 es síncrono y un GET /api/export
# sobre una base grande bloquea el event loop mientras dura.
HEALTHCHECK --interval=30s --timeout=5s --start-period=10s --retries=3 \
  CMD wget -q -O /dev/null "http://127.0.0.1:${SONDA_PORT:-8080}/api/health" || exit 1

# Forma exec: node queda como PID 1 y recibe la señal directa de docker stop.
# src/index.ts maneja SIGTERM y cierra ordenado, así que no hace falta tini.
CMD ["node", "dist/index.js"]
