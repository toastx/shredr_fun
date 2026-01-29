# Stage 1: Build
FROM rust:1.84-slim-bookworm as builder

WORKDIR /app

# Install system dependencies (required for Solana/Crypto libs)
RUN apt-get update && apt-get install -y \
    pkg-config \
    libssl-dev \
    libudev-dev \
    build-essential

# Copy source
COPY . .

# Build release binary
RUN cargo build --release

# Stage 2: Runtime (Small, Clean)
FROM debian:bookworm-slim

WORKDIR /app

# Install runtime dependencies
RUN apt-get update && apt-get install -y \
    ca-certificates \
    libssl-dev \
    && rm -rf /var/lib/apt/lists/*

# Copy binary from builder
# REPLACE "shredr-backend" below with the actual name of your binary from Cargo.toml [package] name
COPY --from=builder /app/target/release/shredr-backend /usr/local/bin/server

CMD ["server"]