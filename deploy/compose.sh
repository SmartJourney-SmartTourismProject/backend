#!/usr/bin/env bash
# `docker compose` for the production stack, always with the right files:
#   .env   secrets and settings you wrote by hand (never touched by CD)
#   .tags  image tags written by deploy.sh (BACKEND_TAG=..., AI_TAG=...)
# Use this instead of plain `docker compose` on the server:
#   ./compose.sh ps
#   ./compose.sh logs -f --tail 200 backend
#   ./compose.sh run --rm migrate --status
set -euo pipefail
cd "$(dirname "$0")"
touch .tags
exec docker compose --env-file .env --env-file .tags -f compose.prod.yml "$@"
