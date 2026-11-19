#!/bin/sh
set -eu
DATABASE_URL=$(node scripts/cloud-database-url.mjs)
export DATABASE_URL
case "$1" in
  api)
    node node_modules/prisma/build/index.js migrate deploy
    exec node dist/apps/api/main.js
    ;;
  worker) exec node dist/apps/worker/main.js ;;
  *) exit 64 ;;
esac
