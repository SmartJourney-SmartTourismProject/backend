# NestJS API image (production). Built by CI on every push to main and pushed
# to ghcr.io/smartjourney-smarttourismproject/backend (see .github/workflows/ci.yml).
#
# Node 26 to match CI. The Prisma client is generated into src/generated (not
# committed), so `prisma generate` must run before `nest build`.
FROM node:26-slim AS build
WORKDIR /app

COPY package.json package-lock.json ./
# Retries: a single idle registry connection must not fail the whole build.
RUN npm config set fetch-retries 5 && npm config set fetch-retry-mintimeout 20000 && npm ci

COPY prisma ./prisma
COPY prisma7.config.ts tsconfig.json tsconfig.build.json nest-cli.json ./
RUN npx prisma generate

COPY src ./src
RUN npm run build && npm prune --omit=dev

FROM node:26-slim
ENV NODE_ENV=production \
    PORT=3001
WORKDIR /app

COPY --from=build /app/node_modules ./node_modules
COPY --from=build /app/dist ./dist
COPY package.json ./

# Not root. The slim image ships a `node` user.
USER node
EXPOSE 3001

# No curl in the slim image; Node itself does the probe. /health is public and
# runs a real `SELECT 1`, so this fails when the database is unreachable too.
HEALTHCHECK --interval=15s --timeout=5s --start-period=40s --retries=5 \
  CMD node -e "fetch('http://127.0.0.1:'+(process.env.PORT||3001)+'/health').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"

CMD ["node", "--enable-source-maps", "dist/main"]
