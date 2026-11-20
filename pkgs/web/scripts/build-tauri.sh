#!/bin/bash
set -e

cd "$(dirname "$0")/.."

# Files incompatible with Next.js output: 'export'
EXCLUDE_FILES=(
  "src/proxy.ts"
  "src/app/api"
  "src/app/auth/app"
  "src/instrumentation.ts"
  "sentry.server.config.ts"
  "sentry.edge.config.ts"
)

BACKUP_DIR=".tauri-build-backup"
mkdir -p "$BACKUP_DIR"

cleanup() {
  for file in "${EXCLUDE_FILES[@]}"; do
    backup_name=$(echo "$file" | tr '/' '_')
    if [ -e "$BACKUP_DIR/$backup_name" ]; then
      mv "$BACKUP_DIR/$backup_name" "$file"
    fi
  done
  rm -rf "$BACKUP_DIR"
  # These route types describe the tree without EXCLUDE_FILES. They conflict with
  # .next/dev/types in `tsc` once the files are restored.
  rm -rf .next/types
}

trap cleanup EXIT

for file in "${EXCLUDE_FILES[@]}"; do
  if [ -e "$file" ]; then
    backup_name=$(echo "$file" | tr '/' '_')
    mv "$file" "$BACKUP_DIR/$backup_name"
  fi
done

# The desktop build has no origin of its own, so API and share links need the deployed site's address.
# CI passes it through the environment, so the default only applies to local builds.
export NEXT_PUBLIC_API_BASE_URL="${NEXT_PUBLIC_API_BASE_URL:-https://paplico.hanak.la}"
# A guest opens the deployed site, so the relay must be the one the site uses, not the one in .env.
export NEXT_PUBLIC_COLLAB_MODE="${NEXT_PUBLIC_COLLAB_MODE:-cloud}"
export NEXT_PUBLIC_PARTYKIT_HOST="${NEXT_PUBLIC_PARTYKIT_HOST:-paplico-collab.hanakla.workers.dev}"

TAURI_BUILD=1 npx next build

echo "Static export complete: out/"
