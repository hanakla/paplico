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
}

trap cleanup EXIT

for file in "${EXCLUDE_FILES[@]}"; do
  if [ -e "$file" ]; then
    backup_name=$(echo "$file" | tr '/' '_')
    mv "$file" "$BACKUP_DIR/$backup_name"
  fi
done

TAURI_BUILD=1 npx next build

echo "Static export complete: out/"
