# Runs the Express app (static site + API) as a container for Cloud Run.
# No build step -- the frontend is plain HTML/CSS/JS served directly by
# server.js, so this is just "install deps, copy source, run".

FROM node:22-slim

WORKDIR /app

# Install dependencies first so this layer is cached unless package*.json changes.
COPY package.json package-lock.json ./
RUN npm ci --omit=dev

COPY . .

# Cloud Run injects PORT (defaults to 8080) and expects the container to
# listen on it; config.js already reads process.env.PORT.
ENV NODE_ENV=production
EXPOSE 8080

# Run as a non-root user.
RUN useradd --uid 1001 --user-group --no-create-home appuser \
  && chown -R appuser:appuser /app
USER appuser

CMD ["node", "server.js"]
