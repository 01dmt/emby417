FROM node:20-bookworm AS build

WORKDIR /app

COPY package.json package-lock.json tsconfig.json ./
RUN npm ci

COPY src ./src
COPY public ./public
COPY bridge ./bridge
RUN npm run build


FROM python:3.12-slim-bookworm

WORKDIR /app

RUN apt-get update \
  && apt-get install -y --no-install-recommends \
    bash \
    ca-certificates \
    curl \
    caddy \
    nodejs \
    npm \
  && rm -rf /var/lib/apt/lists/*

COPY package.json package-lock.json ./
RUN npm ci --omit=dev

COPY --from=build /app/dist ./dist
COPY --from=build /app/public ./public
COPY --from=build /app/bridge ./bridge
COPY docker/entrypoint.sh ./docker/entrypoint.sh

RUN python3 -m pip install --no-cache-dir --break-system-packages -r bridge/requirements.txt

ENV HOST=0.0.0.0
ENV APP_DATA_DIR=/data
ENV APP_LOG_DIR=/data/logs
ENV CADDYFILE_PATH=/data/Caddyfile.local
ENV XDG_DATA_HOME=/data
ENV XDG_CONFIG_HOME=/data

VOLUME ["/data"]

EXPOSE 8417 5088 5089

CMD ["bash", "/app/docker/entrypoint.sh"]
