#!/usr/bin/env bash
# Deploy one service to the production server, with automatic rollback.
#
#   ./deploy.sh <service> <image-tag>
#   ./deploy.sh backend 3f9c2ab         # services: backend | ai-backend | keycloak | db
#
# Runs on the server in /opt/smartjourney (CD calls it over SSH). Steps:
#   1. remember the tag currently running (in .tags)
#   2. pull the new image and recreate just that service
#   3. wait for its healthcheck to go healthy
#   4. if it doesn't, put the previous tag back and exit non-zero
# Tags live in .tags (BACKEND_TAG=..., AI_TAG=...), which compose.sh reads
# together with .env, so any later `./compose.sh up -d` keeps the same versions.
set -euo pipefail
cd "$(dirname "$0")"

SERVICE="${1:?usage: deploy.sh <service> <image-tag>}"
TAG="${2:?usage: deploy.sh <service> <image-tag>}"
WAIT_SECONDS="${WAIT_SECONDS:-120}"
[ "$SERVICE" = keycloak ] && WAIT_SECONDS="${WAIT_SECONDS_KEYCLOAK:-300}"   # first start imports the realm

case "$SERVICE" in
  backend)    VAR=BACKEND_TAG ;;
  ai-backend) VAR=AI_TAG ;;
  keycloak)   VAR=KEYCLOAK_TAG ;;
  db)         VAR=DB_TAG ;;
  *) echo "unknown service '$SERVICE' (backend | ai-backend | keycloak | db)" >&2; exit 2 ;;
esac

touch .tags
COMPOSE=(./compose.sh)
PULL_RETRIES="${PULL_RETRIES:-3}"

current_tag() { grep -E "^${VAR}=" .tags | tail -n1 | cut -d= -f2- || true; }
set_tag() {
  grep -vE "^${VAR}=" .tags > .tags.new || true
  echo "${VAR}=$1" >> .tags.new
  mv .tags.new .tags
}

# healthy | unhealthy | starting | none (no healthcheck)
health_of() {
  local id
  id="$("${COMPOSE[@]}" ps -q "$SERVICE")"
  [ -n "$id" ] || { echo none; return; }
  docker inspect --format '{{if .State.Health}}{{.State.Health.Status}}{{else}}{{.State.Status}}{{end}}' "$id"
}

wait_healthy() {
  local waited=0 status
  while [ "$waited" -lt "$WAIT_SECONDS" ]; do
    status="$(health_of)"
    case "$status" in
      healthy|running) return 0 ;;
      unhealthy|exited|dead) return 1 ;;
    esac
    sleep 3; waited=$((waited + 3))
  done
  return 1
}

PREVIOUS="$(current_tag)"
echo ">> $SERVICE: ${PREVIOUS:-<none>} -> $TAG"

# Any failure on the way (image missing from the registry, container won't
# start, healthcheck never passes) takes the rollback path below - never leave
# the bad tag recorded in .tags.
try_deploy() {
  set_tag "$TAG"
  if [ "${DEPLOY_SKIP_PULL:-0}" != 1 ]; then
    local attempt
    for attempt in $(seq 1 "$PULL_RETRIES"); do
      if "${COMPOSE[@]}" pull "$SERVICE"; then
        break
      fi
      [ "$attempt" -lt "$PULL_RETRIES" ] || return 1
      echo "!! pull failed for $SERVICE (attempt $attempt/$PULL_RETRIES), retrying..." >&2
      sleep 3
    done
  fi
  "${COMPOSE[@]}" up -d --no-deps "$SERVICE" || return 1
  wait_healthy
}

if try_deploy; then
  echo ">> $SERVICE is healthy on $TAG"
  docker image prune -f >/dev/null 2>&1 || true
  exit 0
fi

echo "!! deploying $SERVICE $TAG failed - last logs:" >&2
"${COMPOSE[@]}" logs --tail 40 "$SERVICE" >&2 || true

if [ -n "$PREVIOUS" ]; then
  echo "!! rolling back to $PREVIOUS" >&2
  set_tag "$PREVIOUS"
  "${COMPOSE[@]}" up -d --no-deps "$SERVICE" || true
else
  echo "!! no previous version to roll back to (first deploy of $SERVICE)" >&2
fi
exit 1
