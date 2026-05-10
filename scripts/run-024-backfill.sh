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

if [[ -z "$SUPABASE_DB_URL" ]]; then
  echo "Error: SUPABASE_DB_URL missing or empty in $ENV_FILE"
  exit 1
fi

# BREVO_API_KEY isn't part of the standard local .env (Edge Functions read
# it from their own env, not the dev .env). If it's missing, prompt for it
# silently (paste from LastPass, hit enter — input not echoed). Optional
# one-time fix: add `BREVO_API_KEY=xkeysib-...` to your .env.
if [[ -z "$BREVO_API_KEY" ]]; then
  echo "BREVO_API_KEY not found in $ENV_FILE."
  echo "Paste it now (from LastPass / Brevo account → SMTP & API → API keys)."
  echo "Input is hidden. Press Enter when done."
  echo ""
  printf "BREVO_API_KEY: "
  read -rs BREVO_API_KEY
  echo ""
  if [[ -z "$BREVO_API_KEY" ]]; then
    echo "Error: nothing entered, aborting."
    exit 1
  fi
  if [[ "$BREVO_API_KEY" != xkeysib-* ]]; then
    echo "Warning: that doesn't look like a Brevo API key (expected to start with 'xkeysib-')."
    printf "Continue anyway? [y/N] "
    read -r confirm
    if [[ "$confirm" != "y" && "$confirm" != "Y" ]]; then
      echo "Aborted."
      exit 1
    fi
  fi
  echo ""
fi

export BREVO_API_KEY SUPABASE_DB_URL

cd "$PLATFORM_DIR"

echo "→ platform dir: $PLATFORM_DIR"
echo "→ env file:     $ENV_FILE"
echo "→ args:         $*"
echo ""

exec deno run --allow-net --allow-env --allow-read --allow-write \
  supabase/data-ops/024_backfill_referral_and_fastrack_urls_2026_05_10.ts "$@"
