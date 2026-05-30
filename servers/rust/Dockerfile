# syntax=docker/dockerfile:1.7

# -------- 1. Plan: collect dep info for cargo-chef so we can cache the
#                   slow `cargo build` step across rebuilds. --------
FROM rust:1.82-bookworm AS chef
WORKDIR /app
RUN cargo install cargo-chef --locked

FROM chef AS planner
COPY servers/rust /app
RUN cargo chef prepare --recipe-path recipe.json

# -------- 2. Build deps from the recipe (cache hit on every code-only change) --------
FROM chef AS deps
COPY --from=planner /app/recipe.json recipe.json
RUN cargo chef cook --release --recipe-path recipe.json

# -------- 3. Build the actual binary. The static SPA from apps/web/dist is --------
#            also pulled in and copied to /opt/scribe/dist so the binary
#            can serve it directly.
FROM chef AS builder
COPY --from=deps /app/target target
COPY --from=deps /usr/local/cargo /usr/local/cargo
COPY servers/rust /app
RUN cargo build --release --bin scribe-server
# Strip is already enabled via Cargo.toml release profile.

# Frontend build is a separate stage so a backend-only change skips it.
FROM node:22-bookworm AS web
WORKDIR /web
COPY package.json pnpm-workspace.yaml pnpm-lock.yaml ./
COPY apps apps
COPY packages packages
RUN corepack enable && CI=true pnpm install --frozen-lockfile
RUN pnpm --filter @scribe/web build

# -------- 4. Runtime image: debian-slim, kept minimal (glibc, matches build base). --------
#            Tectonic is pulled in as a static binary; we copy it into
#            /usr/local/bin so the worker's PATH lookup finds it.
FROM debian:bookworm-slim AS runtime
RUN apt-get update \
 && apt-get install -y --no-install-recommends ca-certificates curl \
 && rm -rf /var/lib/apt/lists/*

# Tectonic 0.15.0 statically-linked release.
RUN curl -L -o /tmp/tectonic.tar.gz \
      https://github.com/tectonic-typesetting/tectonic/releases/download/tectonic%400.15.0/tectonic-0.15.0-x86_64-unknown-linux-musl.tar.gz \
 && tar -xzf /tmp/tectonic.tar.gz -C /usr/local/bin tectonic \
 && rm /tmp/tectonic.tar.gz \
 && chmod +x /usr/local/bin/tectonic

WORKDIR /opt/scribe
COPY --from=builder /app/target/release/scribe-server /usr/local/bin/scribe-server
COPY --from=web    /web/apps/web/dist                /opt/scribe/web
COPY supabase/migrations                              /opt/scribe/migrations

ENV HOST=0.0.0.0 \
    PORT=3000 \
    RUST_LOG=info,scribe_server=info \
    SCRIBE_STATIC_DIR=/opt/scribe/web

EXPOSE 3000

# Drop to non-root for the runtime.
RUN useradd --system --uid 10001 --shell /usr/sbin/nologin scribe \
 && chown -R scribe:scribe /opt/scribe
USER scribe

ENTRYPOINT ["/usr/local/bin/scribe-server"]
