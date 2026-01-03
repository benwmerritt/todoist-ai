# syntax=docker/dockerfile:1.9
FROM node:22-slim

WORKDIR /app

ENV NODE_ENV=production \
    PORT=8000

# Copy package files first for layer caching
COPY package.json package-lock.json ./

# Install all dependencies (need devDependencies for build)
RUN npm ci

# Copy source and build
COPY . .
RUN npm run build

# Remove dev dependencies after build
RUN npm prune --production

EXPOSE 8000

CMD ["node", "dist/remote.js"]
