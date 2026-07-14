# Cloud Run image for the Tempo Chess API (Hono, TypeScript).
FROM node:24-alpine AS build
WORKDIR /app
COPY package.json package-lock.json* ./
RUN npm install
COPY . .
RUN npm run build

FROM node:24-alpine AS production
WORKDIR /app
ENV NODE_ENV=production
COPY package.json package-lock.json* ./
RUN npm install --omit=dev
COPY --from=build /app/dist ./dist
# Cloud Run sets PORT; the server reads it (default 8080).
EXPOSE 8080
CMD ["node", "dist/index.js"]
