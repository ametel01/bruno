#!/bin/sh
set -eu

HERMES_HOME="${HERMES_HOME:-/opt/data}"
export HERMES_HOME HOME="$HERMES_HOME"

runtime_uid="$(id -u)"

if [ "$runtime_uid" -eq 0 ]; then
  # Bruno provisions the volume as UID/GID 10000. Perform all volume writes
  # after dropping privileges so a persisted symlink cannot turn bootstrap
  # into a privileged write outside HERMES_HOME.
  gosu hermes mkdir -p \
    "$HERMES_HOME/backups" \
    "$HERMES_HOME/cron" \
    "$HERMES_HOME/sessions" \
    "$HERMES_HOME/logs/gateways" \
    "$HERMES_HOME/hooks" \
    "$HERMES_HOME/memories" \
    "$HERMES_HOME/skills" \
    "$HERMES_HOME/plans" \
    "$HERMES_HOME/workspace" \
    "$HERMES_HOME/platforms/pairing" \
    "$HERMES_HOME/lazy-packages"

  if [ -f "$HERMES_HOME/config.yaml" ]; then
    gosu hermes /opt/hermes/.venv/bin/python /opt/hermes/scripts/docker_config_migrate.py || \
      echo "[bruno-hermes] Warning: config migration failed; continuing" >&2
  fi

  if [ -d /opt/hermes/skills ]; then
    gosu hermes /opt/hermes/.venv/bin/python /opt/hermes/tools/skills_sync.py || \
      echo "[bruno-hermes] Warning: bundled skill sync failed; continuing" >&2
  fi
elif [ "$runtime_uid" -ne 10000 ]; then
  echo "[bruno-hermes] Unsupported runtime UID; use the image default (10000)." >&2
  exit 1
fi

if [ "$#" -eq 0 ]; then
  set -- hermes
elif ! command -v "$1" >/dev/null 2>&1; then
  set -- hermes "$@"
fi

if [ "$runtime_uid" -eq 0 ]; then
  set -- gosu hermes "$@"
fi

exec "$@"
