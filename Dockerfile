# Multi-stage build for Shredr Frontend
# Stage 1: Build the application
FROM node:20-alpine AS builder

# Set working directory
WORKDIR /app

# Copy package files
COPY package.json package-lock.json ./

# Install dependencies
RUN apk add --no-cache python3 make g++ linux-headers eudev-dev
RUN npm ci

# Copy source code and configuration files
COPY index.html ./
COPY vite.config.ts ./
COPY tsconfig.json ./
COPY tsconfig.app.json ./
COPY tsconfig.node.json ./
COPY eslint.config.js ./
COPY public ./public
COPY src ./src

# Vite inlines VITE_* at BUILD time, so .env has to be present here or every
# constant resolves to "" and the app fails at runtime (new Connection("")
# throws, and the empty WSS URL falls back to the page origin).
# .dockerignore deliberately does not exclude .env. Values in it are public by
# construction — they ship inside the client bundle either way.
COPY .env ./

# Build the application
RUN npm run build

# Stage 2: Serve with nginx
FROM nginx:alpine AS production

# Copy built assets from builder stage
COPY --from=builder /app/dist /usr/share/nginx/html

# Copy custom nginx configuration (optional)
# COPY nginx.conf /etc/nginx/nginx.conf

# Expose port 80
EXPOSE 80

# Start nginx
CMD ["nginx", "-g", "daemon off;"]
