# Dashboard "Maison" (Hue + Alexa + teles) pour Sonoff iHost (armv7) et PC (amd64).
# Image publique sur GHCR : AUCUN secret ici. Les secrets arrivent par variables d'environnement
# (voir dashboard/config.js et DEPLOY-IHOST.md) et sont ecrits au 1er demarrage dans le volume /data.
FROM node:20-alpine

ENV NODE_ENV=production \
    TZ=Europe/Paris \
    MAISON_DATA=/data \
    MAISON_BIND=0.0.0.0

WORKDIR /app

# Fuseau horaire (TZ=Europe/Paris) : alpine n'embarque pas les zones sans tzdata
RUN apk add --no-cache tzdata

# Dependances Alexa d'abord (couche mise en cache tant que package*.json ne change pas)
COPY alexa/package.json alexa/package-lock.json ./alexa/
RUN cd alexa && npm ci --omit=dev --no-audit --no-fund && npm cache clean --force

# Code (les fichiers secrets sont exclus par .dockerignore)
COPY alexa/alexa-common.js ./alexa/
COPY dashboard/ ./dashboard/
COPY icon/ ./icon/

# Donnees persistantes (secrets bootstrapes, access.json, history.json, timers.json, tv-tokens.json)
RUN mkdir -p /data
VOLUME ["/data"]

# 8090 dashboard, 8091 page texte pour les teles (3001 = proxy de connexion Amazon, seulement si le cookie expire)
EXPOSE 8090 8091

HEALTHCHECK --interval=60s --timeout=5s --start-period=20s --retries=3 \
    CMD wget -qO- http://127.0.0.1:8090/api/login-required >/dev/null 2>&1 || exit 1

CMD ["node", "--no-deprecation", "dashboard/server.js"]
