# One image per Mastra server: docker build -f docker/mastra.Dockerfile --build-arg SERVER=credit .
# The build context is the repo root.

# Same for every server, so it is built once and shared.
FROM node:22-alpine AS deps
WORKDIR /app
RUN corepack enable && corepack prepare pnpm@10.33.0 --activate
COPY package.json pnpm-lock.yaml ./
RUN pnpm install --frozen-lockfile

FROM deps AS build
ARG SERVER
# Same layout as the repo: servers import ../../../shared and resolve packages from the root.
COPY servers/shared servers/shared
COPY servers/${SERVER} servers/${SERVER}
RUN cd servers/${SERVER} && /app/node_modules/.bin/mastra build

FROM node:22-alpine
ARG SERVER
WORKDIR /app
# The build output is self-contained: `mastra build` installs its node_modules.
COPY --from=build /app/servers/${SERVER}/.mastra/output/ ./
ENV NODE_ENV=production MASTRA_HOST=0.0.0.0
USER node
CMD ["node", "index.mjs"]
