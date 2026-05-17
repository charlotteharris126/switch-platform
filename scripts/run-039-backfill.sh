#!/usr/bin/env zsh
# Wrapper for data-ops/039 (backfill SW_PROVIDER_CONTACT_BLOCK on existing
# Brevo contacts). Loops the backfill-sw-provider-contact-block Edge Function
# over chunks of 20 IDs until done.
#
# Usage:
#   ./scripts/run-039-backfill.sh "AUDIT_SHARED_SECRET_VALUE"
#
# Get the audit key from Supabase SQL Editor:
#   SELECT public.get_shared_secret('AUDIT_SHARED_SECRET');

set -e

AUDIT_KEY="$1"
if [[ -z "$AUDIT_KEY" ]]; then
  echo "Usage: $0 \"AUDIT_KEY\""
  echo ""
  echo "Get the audit key from Supabase SQL Editor:"
  echo "  SELECT public.get_shared_secret('AUDIT_SHARED_SECRET');"
  exit 1
fi

URL="https://igvlngouxcirqhlsrhga.supabase.co/functions/v1/backfill-sw-provider-contact-block"
OFFSET=0
TOTAL_OK=0
TOTAL_SKIP=0
TOTAL_ERR=0

while true; do
  RESP=$(curl -s -X POST -H "x-audit-key: $AUDIT_KEY" "$URL?offset=$OFFSET")

  # jq's `//` operator treats false as null-like, so use `tostring` to
  # preserve the literal "false" / "true" string for the loop condition.
  HAS_MORE=$(echo "$RESP" | jq -r '.has_more | tostring')
  if [[ "$HAS_MORE" != "true" && "$HAS_MORE" != "false" ]]; then
    echo "Unexpected response:"
    echo "$RESP"
    exit 1
  fi

  CHUNK_OK=$(echo "$RESP" | jq -r '.chunk.ok_count')
  CHUNK_SKIP=$(echo "$RESP" | jq -r '.chunk.skipped_count')
  CHUNK_ERR=$(echo "$RESP" | jq -r '.chunk.error_count')
  TOTAL=$(echo "$RESP" | jq -r '.total')
  NEXT=$(echo "$RESP" | jq -r '.next_offset')

  TOTAL_OK=$((TOTAL_OK + CHUNK_OK))
  TOTAL_SKIP=$((TOTAL_SKIP + CHUNK_SKIP))
  TOTAL_ERR=$((TOTAL_ERR + CHUNK_ERR))

  echo "offset=$OFFSET → ok=$CHUNK_OK skip=$CHUNK_SKIP err=$CHUNK_ERR  (running totals: ok=$TOTAL_OK skip=$TOTAL_SKIP err=$TOTAL_ERR / $TOTAL)"

  if [[ "$HAS_MORE" != "true" ]]; then
    break
  fi
  OFFSET=$NEXT
done

echo ""
echo "Done."
echo "  ok      $TOTAL_OK"
echo "  skipped $TOTAL_SKIP"
echo "  errors  $TOTAL_ERR"
