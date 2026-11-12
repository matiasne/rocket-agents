# The Next.js UI as a standalone server. The build context is the repo root.

FROM node:22-alpine AS deps
WORKDIR /app
RUN corepack enable && corepack prepare pnpm@10.33.0 --activate
COPY package.json pnpm-lock.yaml ./
RUN pnpm install --frozen-lockfile

FROM deps AS build
COPY next.config.ts tsconfig.json ./
COPY src src
RUN pnpm exec next build

FROM node:22-alpine
WORKDIR /app
COPY --from=build /app/.next/standalone ./
COPY --from=build /app/.next/static ./.next/static
ENV NODE_ENV=production PORT=3030 HOSTNAME=0.0.0.0
USER node
CMD ["node", "server.js"]
