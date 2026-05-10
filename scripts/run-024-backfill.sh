#!/usr/bin/env zsh
# Wrapper for data-ops/024 (backfill SW_REFERRAL_URL + SW_FASTRACK_URL).
#
# Why a wrapper: sourcing the whole .env directly tripped on shell-syntax
# quirks in the file (quotes, comments, spacing). This script extracts ONLY
# the two vars it needs by exact prefix match, so the rest of the .env is
# irrelevant.
#
# Usage:
#   ./scripts/run-024-backfill.sh          # dry run
#   ./scripts/run-024-backfill.sh --apply  # live run
#   ./scripts/run-024-backfill.sh --reset  # clear checkpoint, start over

set -e

# Resolve to absolute platform/ dir regardless of where the user invoked from.
SCRIPT_DIR="${0:A:h}"
PLATFORM_DIR="$(cd "$SCRIPT_DIR/.." && pwd)"

ENV_FILE="$HOME/Switchable/platform/.env"

if [[ ! -f "$ENV_FILE" ]]; then
  echo "Error: env file not found at $ENV_FILE"
  echo "If your secrets file lives somewhere else, edit ENV_FILE in this script."
  exit 1
fi

# Pull a single KEY=value line from the env, by exact KEY= prefix.
# Strips optional surrounding double or single quotes and trailing whitespace.
# Tolerates an `export ` prefix (some env files use it, some don't).
extract_env() {
  local key="$1"
  grep -E "^(export[[:space:]]+)?${key}=" "$ENV_FILE" \
    | tail -1 \
    | sed -E "s/^(export[[:space:]]+)?${key}=//" \
    | sed -E 's/[[:space:]]+$//' \
    | sed -E 's/^"(.*)"$/\1/' \
    | sed -E "s/^'(.*)'\$/\1/"
}

BREVO_API_KEY=$(extract_env BREVO_API_KEY)
SUPABASE_DB_URL=$(extract_env SUPABASE_DB_URL)

if [[ -z "$BREVO_API_KEY" ]]; then
  echo "Error: BREVO_API_KEY missing or empty in $ENV_FILE"
  exit 1
fi
if [[ -z "$SUPABASE_DB_URL" ]]; then
  echo "Error: SUPABASE_DB_URL missing or empty in $ENV_FILE"
  exit 1
fi

export BREVO_API_KEY SUPABASE_DB_URL

cd "$PLATFORM_DIR"

echo "→ platform dir: $PLATFORM_DIR"
echo "→ env file:     $ENV_FILE"
echo "→ args:         $*"
echo ""

exec deno run --allow-net --allow-env --allow-read --allow-write \
  supabase/data-ops/024_backfill_referral_and_fastrack_urls_2026_05_10.ts "$@"
