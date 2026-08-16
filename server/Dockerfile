# Cloud Run image for the Forma API (Hono, TypeScript).
FROM node:24-bookworm-slim AS build
WORKDIR /app
COPY package.json package-lock.json* ./
RUN npm ci
COPY . .
RUN npm run build

FROM node:24-bookworm-slim AS production
WORKDIR /app
ENV NODE_ENV=production
# Debian keeps Stockfish in /usr/games, which is not in the slim image's PATH.
RUN apt-get update \
    && apt-get install -y --no-install-recommends stockfish \
    && rm -rf /var/lib/apt/lists/*
ENV STOCKFISH_PATH=/usr/games/stockfish
COPY package.json package-lock.json* ./
RUN npm ci --omit=dev
COPY --from=build /app/dist ./dist
# Cloud Run sets PORT; the server reads it (default 8080).
EXPOSE 8080
CMD ["node", "dist/index.js"]
