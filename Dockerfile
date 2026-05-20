# Runn — single-process Node worker + Claude CLI

FROM node:20-bookworm-slim

# bash for any shell behaviours Claude CLI invokes
RUN apt-get update \
 && apt-get install -y --no-install-recommends bash ca-certificates \
 && rm -rf /var/lib/apt/lists/*

# Claude CLI globally so the bridge can spawn `claude`
RUN npm install -g @anthropic-ai/claude-code

WORKDIR /app

# Install runn deps first (cache layer)
COPY package*.json ./
RUN npm install --omit=dev && npm cache clean --force

# App source
COPY worker/ ./worker/
COPY frontend/ ./frontend/

ENV HOST=0.0.0.0
ENV PORT=17777
EXPOSE 17777

CMD ["node", "worker/server.js"]
