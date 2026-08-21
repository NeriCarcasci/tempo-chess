# Cloud Run image for the Forma API (Hono, TypeScript).
FROM node:24-bookworm-slim AS build
WORKDIR /app
COPY package.json package-lock.json* ./
RUN npm ci
COPY . .
RUN npm run build

# Maia-3 is built as an optional target so the API, ingestion and Stockfish
# services keep their small image. Only forma-maia uses this layer.
FROM node:24-bookworm-slim AS maia3-runtime
ARG MAIA3_CODE_REVISION=1e13597c42d4858b7cfd7cfdae01e297263364b2
ARG MAIA3_MODEL_REVISION=b6559de2398d7140b985f28fd2c19fb5e47ddabe
ARG MAIA3_MODEL_SHA256=ba14208b2992d85502f5fb501934abf6aaaeb355e9f3fdf90e326911f562524f
RUN apt-get update \
    && apt-get install -y --no-install-recommends git python3 python3-pip python3-venv ca-certificates \
    && rm -rf /var/lib/apt/lists/*
RUN python3 -m venv /opt/maia3-venv \
    && /opt/maia3-venv/bin/pip install --no-cache-dir \
      --extra-index-url https://download.pytorch.org/whl/cpu torch==2.13.0+cpu \
    && /opt/maia3-venv/bin/pip install --no-cache-dir \
      huggingface-hub==1.28.0 numpy==2.5.2 python-chess==1.999 \
    && mkdir -p /tmp/maia3 \
    && git -C /tmp/maia3 init \
    && git -C /tmp/maia3 remote add origin https://github.com/CSSLab/maia3.git \
    && git -C /tmp/maia3 fetch --depth 1 origin "${MAIA3_CODE_REVISION}" \
    && git -C /tmp/maia3 checkout --detach FETCH_HEAD \
    && /opt/maia3-venv/bin/pip install --no-cache-dir --no-deps /tmp/maia3 \
    && mkdir -p /opt/forma/maia3 /opt/forma/licenses/maia3 \
    && cp /tmp/maia3/LICENSE /opt/forma/licenses/maia3/LICENSE \
    && python3 -c "import urllib.request; urllib.request.urlretrieve('https://huggingface.co/UofTCSSLab/Maia3-5M/resolve/${MAIA3_MODEL_REVISION}/maia3-5m.pt?download=true', '/opt/forma/maia3/maia3-5m.pt')" \
    && echo "${MAIA3_MODEL_SHA256}  /opt/forma/maia3/maia3-5m.pt" | sha256sum -c - \
    && rm -rf /tmp/maia3

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
# The migration job applies these at runtime with drizzle-orm's migrator, so the
# SQL and its journal are part of the image rather than something fetched later.
COPY drizzle ./drizzle
# Cloud Run sets PORT; the server reads it (default 8080).
EXPOSE 8080
CMD ["node", "dist/index.js"]

# Build this target for forma-maia. The default final target below remains
# the lean Node/Stockfish image used by every other deployment.
FROM production AS maia-production
RUN apt-get update \
    && apt-get install -y --no-install-recommends python3 libgomp1 \
    && rm -rf /var/lib/apt/lists/*
COPY --from=maia3-runtime /opt/maia3-venv /opt/maia3-venv
COPY --from=maia3-runtime /opt/forma /opt/forma
COPY maia3 ./maia3
ENV MAIA3_PYTHON_PATH=/opt/maia3-venv/bin/python
ENV MAIA3_BRIDGE_PATH=/app/maia3/bridge.py
ENV MAIA3_CHECKPOINT_PATH=/opt/forma/maia3/maia3-5m.pt
ENV OMP_NUM_THREADS=1
ENV MKL_NUM_THREADS=1

FROM production AS final
