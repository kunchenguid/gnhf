#!/usr/bin/env bash
set -euo pipefail

# Compute changed files between base and head
BASE="${AIRLOCK_BASE_SHA:-HEAD~1}"
HEAD="${AIRLOCK_HEAD_SHA:-HEAD}"

CHANGED_FILES=$(git diff --name-only --diff-filter=ACMR "$BASE" "$HEAD" 2>/dev/null || true)

if [ -z "$CHANGED_FILES" ]; then
  echo "No changed files found."
  exit 0
fi

ensure_project_tools() {
  if [ -x "node_modules/.bin/prettier" ] && [ -x "node_modules/.bin/eslint" ]; then
    return
  fi

  echo "==> Installing project dependencies..."
  if [ -f "package-lock.json" ]; then
    npm ci
  else
    npm install
  fi
}

ensure_project_tools

PRETTIER_BIN="./node_modules/.bin/prettier"
ESLINT_BIN="./node_modules/.bin/eslint"

# Filter files by type
TS_FILES=$(echo "$CHANGED_FILES" | grep -E '\.(ts|tsx|js|jsx|mjs|cjs)$' || true)
PRETTIER_FILES=$(echo "$CHANGED_FILES" | grep -E '\.(ts|tsx|js|jsx|mjs|cjs|json|yml|yaml|md|css|html)$' || true)

# Filter to only files that still exist (not deleted)
if [ -n "$PRETTIER_FILES" ]; then
  PRETTIER_EXISTS=""
  while IFS= read -r f; do
    [ -f "$f" ] && PRETTIER_EXISTS="${PRETTIER_EXISTS}${f}"$'\n'
  done <<< "$PRETTIER_FILES"
  PRETTIER_FILES="${PRETTIER_EXISTS%$'\n'}"
fi

if [ -n "$TS_FILES" ]; then
  TS_EXISTS=""
  while IFS= read -r f; do
    [ -f "$f" ] && TS_EXISTS="${TS_EXISTS}${f}"$'\n'
  done <<< "$TS_FILES"
  TS_FILES="${TS_EXISTS%$'\n'}"
fi

ERRORS=0

# Step 1: Run Prettier auto-fix on changed files
if [ -n "$PRETTIER_FILES" ]; then
  echo "==> Running Prettier (auto-fix)..."
  echo "$PRETTIER_FILES" | xargs "$PRETTIER_BIN" --write || true
fi

# Step 2: Run ESLint auto-fix on changed TS/JS files
if [ -n "$TS_FILES" ]; then
  echo "==> Running ESLint (auto-fix)..."
  echo "$TS_FILES" | xargs "$ESLINT_BIN" --fix || true
fi

# Step 3: Run Prettier check mode to verify
if [ -n "$PRETTIER_FILES" ]; then
  echo "==> Running Prettier (check)..."
  if ! echo "$PRETTIER_FILES" | xargs "$PRETTIER_BIN" --check; then
    echo "ERROR: Prettier check failed."
    ERRORS=1
  fi
fi

# Step 4: Run ESLint check mode to verify
if [ -n "$TS_FILES" ]; then
  echo "==> Running ESLint (check)..."
  if ! echo "$TS_FILES" | xargs "$ESLINT_BIN"; then
    echo "ERROR: ESLint check failed."
    ERRORS=1
  fi
fi

if [ "$ERRORS" -ne 0 ]; then
  echo "Lint/format issues remain."
  exit 1
fi

echo "All lint/format checks passed."
exit 0
