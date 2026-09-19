# nycfoodie MCP server (Streamable HTTP).
# Build:  docker build -t nycfoodie .
# Run:    docker run -p 3000:3000 nycfoodie
# The SQLite database ships inside the image; the feedback table migrates
# on startup. Mount a volume at /app/data and set NYCFOODIE_DB to persist
# feedback + call logs across deploys.

FROM node:22-slim AS build
# toolchain fallback in case better-sqlite3 needs compiling for this ABI
RUN apt-get update && apt-get install -y --no-install-recommends python3 make g++ \
  && rm -rf /var/lib/apt/lists/*
WORKDIR /app
COPY package.json package-lock.json* ./
COPY db/package.json ./db/
COPY mcp/package.json ./mcp/
COPY crawler/package.json ./crawler/
RUN npm ci
COPY tsconfig.base.json ./
COPY db ./db
COPY mcp ./mcp
RUN npm run build --workspace=nycfoodie-db --workspace=nycfoodie-mcp

FROM node:22-slim AS runtime
ENV NODE_ENV=production
WORKDIR /app
COPY --from=build /app/package.json /app/package-lock.json* ./
COPY --from=build /app/db/package.json ./db/
COPY --from=build /app/mcp/package.json ./mcp/
COPY --from=build /app/crawler/package.json ./crawler/
COPY --from=build /app/node_modules ./node_modules
COPY --from=build /app/db/dist ./db/dist
COPY --from=build /app/mcp/dist ./mcp/dist
# database ships with the image
COPY nycfoodie.db ./nycfoodie.db
RUN useradd --create-home --shell /usr/sbin/nologin app \
  && mkdir -p /app/data && chown -R app:app /app
USER app
EXPOSE 3000
ENV PORT=3000
HEALTHCHECK --interval=30s --timeout=5s CMD node -e "fetch('http://localhost:'+(process.env.PORT||3000)+'/healthz').then(r=>{if(!r.ok)process.exit(1)}).catch(()=>process.exit(1))"
CMD ["node", "mcp/dist/http.js"]
