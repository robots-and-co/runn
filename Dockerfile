# Runn — single-process Node worker + Claude CLI

FROM node:20-bookworm-slim

# bash for any shell behaviours Claude CLI invokes; openssh-client so spawned
# sessions can ssh into clients; git so sessions (and the worker) can version
# the data dir / app and run git-backed tooling; curl for HTTP probing from
# sessions and tooling.
RUN apt-get update \
 && apt-get install -y --no-install-recommends bash ca-certificates curl git openssh-client \
 && rm -rf /var/lib/apt/lists/*

# Default git identity for the container (system-level, so it survives the
# /home/waz bind-mounts that would shadow a ~/.gitconfig). Matches the
# "Runn <runn@local>" author already in the app's history; any real repo can
# still override with its own local user.name/user.email.
RUN git config --system user.name "Runn" \
 && git config --system user.email "runn@local"

# The base image's uid-1000 `node` user has home /home/node, but we run with
# HOME=/home/waz and mount ~/.ssh there. ssh/git resolve ~ from the passwd
# database (getpwuid), NOT $HOME — so without this they'd look in /home/node
# and never find the mounted keys/config. Point passwd home at /home/waz.
RUN usermod -d /home/waz node

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
