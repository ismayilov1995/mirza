#!/usr/bin/env bash
# Launcher for the canonical chunker.
#
# It exists to keep the script's NAME out of the caller's command line. Killing
# a previous run with `pkill -f` or `ps | grep` matches full command lines, so a
# shell whose own line mentions the script matches too — and kills itself. That
# happened three times before this file existed.
set -euo pipefail
cd "$(dirname "$0")/.."
LOG="${CHUNK_LOG:-/tmp/chunker.log}"
exec nohup npx tsx scripts/chunk-store.ts >> "$LOG" 2>&1
