FROM node:22-bookworm-slim AS build

WORKDIR /app

COPY package*.json ./
RUN npm ci

COPY tsconfig.json ./
COPY src ./src
RUN npm run build

FROM node:22-bookworm-slim AS runtime

ENV NODE_ENV=production
WORKDIR /app

RUN apt-get update \
  && apt-get install -y --no-install-recommends openjdk-17-jre-headless \
  && rm -rf /var/lib/apt/lists/*

COPY package*.json ./
RUN npm ci --omit=dev && npm cache clean --force

COPY --from=build /app/dist ./dist
COPY static ./static
COPY lavalink ./lavalink
COPY render-start.sh ./render-start.sh

RUN mkdir -p /app/data /app/lavalink/logs /app/lavalink/plugins \
  && chmod +x /app/render-start.sh

EXPOSE 3000

CMD ["/app/render-start.sh"]
