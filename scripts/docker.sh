#!/usr/bin/env bash
# Runs the whole demo in Docker: one container per Mastra server, plus the UI
# (see docker-compose.yml).
#
#   scripts/docker.sh [up]            build and start everything, wait until healthy
#   scripts/docker.sh down            stop and remove the containers
#   scripts/docker.sh logs [service]  follow the logs (all services, or one)
#   scripts/docker.sh ps              list the containers
#   scripts/docker.sh rebuild <service>  rebuild and restart one service
set -euo pipefail
cd "$(dirname "$0")/.."

docker compose version >/dev/null 2>&1 || { echo "Docker with the compose plugin is required: https://docs.docker.com/get-docker/" >&2; exit 1; }
docker info >/dev/null 2>&1 || { echo "Docker is not running." >&2; exit 1; }

case "${1:-up}" in
  up)
    [ -f .env ] || { echo "No .env file. Run: cp .env.example .env, then add ANTHROPIC_API_KEY." >&2; exit 1; }
    docker compose up --build -d --wait
    echo
    echo "UI:      http://localhost:3030"
    echo "Servers: http://localhost:4111 (router) to http://localhost:4121 (credit)"
    echo "Gateway: http://localhost:8080 (Bifrost)"
    echo "Logs:    scripts/docker.sh logs [service]"
    echo "Stop:    scripts/docker.sh down"
    ;;
  down)
    docker compose down
    ;;
  logs)
    shift
    docker compose logs -f "$@"
    ;;
  ps)
    docker compose ps
    ;;
  rebuild)
    [ -n "${2:-}" ] || { echo "Usage: scripts/docker.sh rebuild <service>" >&2; exit 1; }
    docker compose up --build -d --wait "$2"
    ;;
  *)
    echo "Usage: scripts/docker.sh [up|down|logs [service]|ps|rebuild <service>]" >&2
    exit 1
    ;;
esac
