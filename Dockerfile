FROM node:22-slim AS builder

WORKDIR /build

# Copy package files and install deps
COPY package.json package-lock.json* ./
RUN npm ci

# Copy source and build (for typecheck)
COPY . .
RUN npm run typecheck

# Build WebUI
WORKDIR /build/web
COPY web/package.json web/package-lock.json* ./
RUN npm ci
COPY web/ .
RUN npx vite build

WORKDIR /build

# ── Runtime ──
FROM node:22-slim AS runtime

RUN apt-get update && apt-get install -y --no-install-recommends \
    ca-certificates tini ffmpeg \
    && rm -rf /var/lib/apt/lists/*

# Install all deps (tsx is devDep, needed for runtime)
WORKDIR /app
COPY package.json package-lock.json* ./
RUN npm ci
RUN npm install -g tsx

# Copy source code (tsx runs from source)
COPY --from=builder /build/src ./src
COPY --from=builder /build/tsconfig.json ./
COPY --from=builder /build/src/web/dist ./src/web/dist

RUN useradd -r -u 1001 -m -d /data -s /usr/sbin/nologin tokenpool
USER tokenpool

EXPOSE 8000

HEALTHCHECK --interval=30s --timeout=3s --retries=3 \
  CMD node -e "fetch('http://127.0.0.1:8000/health').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"

ENTRYPOINT ["/usr/bin/tini", "--"]
CMD ["npx", "tsx", "src/main.ts"]
