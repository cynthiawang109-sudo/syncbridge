FROM node:22-bookworm-slim
RUN apt-get update && apt-get install -y --no-install-recommends openssl && rm -rf /var/lib/apt/lists/*
WORKDIR /srv
COPY . .
RUN npm ci && if [ -f prisma/schema.prisma ]; then npm run generate; fi && npm run build
