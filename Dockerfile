FROM node:22-bookworm-slim
RUN apt-get update && apt-get install -y --no-install-recommends openssl && rm -rf /var/lib/apt/lists/*
WORKDIR /srv
COPY package.json package-lock.json ./
COPY apps/api/package.json apps/api/
COPY apps/worker/package.json apps/worker/
COPY apps/mock-provider/package.json apps/mock-provider/
COPY packages/shared/package.json packages/shared/
RUN npm ci
COPY . .
RUN npm run generate && npm run build
