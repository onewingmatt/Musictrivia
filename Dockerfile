FROM node:22-bookworm AS frontend-builder
WORKDIR /app/frontend
COPY frontend/package*.json ./
RUN npm install
COPY frontend/ ./
RUN npm run build

FROM node:22-bookworm AS backend-builder
WORKDIR /app/backend
RUN apt-get update && apt-get install -y --no-install-recommends python3 make g++ && rm -rf /var/lib/apt/lists/*
COPY backend/package*.json ./
ENV npm_config_build_from_source=true
RUN npm install
COPY backend/ ./

FROM node:22-bookworm AS runtime
WORKDIR /app
ENV NODE_ENV=production
ENV PORT=3001
ENV DB_PATH=/data/database.sqlite
ENV FRONTEND_DIST=/app/frontend/dist
RUN apt-get update && apt-get install -y --no-install-recommends python3 python3-pip ffmpeg && pip3 install --break-system-packages --no-cache-dir requests beautifulsoup4 yt-dlp billboard.py && rm -rf /var/lib/apt/lists/*
RUN mkdir -p /data /app/frontend
COPY --from=backend-builder /app/backend /app/backend
COPY --from=backend-builder /app/backend/node_modules /app/backend/node_modules
COPY --from=frontend-builder /app/frontend/dist /app/frontend/dist
WORKDIR /app/backend
EXPOSE 3001
CMD ["node", "src/index.js"]