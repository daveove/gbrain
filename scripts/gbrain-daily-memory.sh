#!/bin/bash
set -euo pipefail
export PATH="$HOME/.local/bin:$HOME/.bun/bin:/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin:/usr/sbin:/sbin"
export GBRAIN_POOL_SIZE=1 GBRAIN_SELF_UPGRADE_MODE=off GBRAIN_DISABLE_DIRECT_POOL=1
REPO="${GBRAIN_REPO_ROOT:-$HOME/gbrain}"
LOG="${GBRAIN_DAILY_MEMORY_LOG:-$HOME/Library/Logs/gbrain-daily-memory.log}"
mkdir -p "$(dirname "$LOG")" "$HOME/.local/state/gbrain"
if [[ -f "$HOME/.gbrain/env.sh" ]]; then
  source "$HOME/.gbrain/env.sh" >/dev/null 2>/dev/null
fi
# Launcher calendar zone: explicit setting > file-plane cycle.timezone >
# TZ from env.sh/host > UTC. Do not force Asia/Manila over brain config.
zone="$(python3 -c '
import json, os
from pathlib import Path
explicit = (os.environ.get("GBRAIN_DAILY_MEMORY_TZ") or "").strip()
if explicit:
    print(explicit, end="")
    raise SystemExit
cfg = Path.home() / ".gbrain" / "config.json"
if cfg.is_file():
    try:
        value = (json.loads(cfg.read_text()).get("cycle.timezone") or "").strip()
        if value:
            print(value, end="")
            raise SystemExit
    except (OSError, json.JSONDecodeError, TypeError, ValueError):
        pass
print((os.environ.get("TZ") or "UTC").strip() or "UTC", end="")
')"
# Validate IANA name; fall back to UTC when invalid.
if ! python3 -c 'import sys; from zoneinfo import ZoneInfo; ZoneInfo(sys.argv[1])' "$zone" 2>/dev/null; then
  zone=UTC
fi
export TZ="$zone"
if [[ "${GBRAIN_DAILY_LOCK_FD:-}" != 9 ]]; then
  exec python3 "$REPO/scripts/daily-memory-lock.py" "$0" "$@"
fi
TMP="$(mktemp)"
trap 'rm -f "$TMP"' EXIT
run_command() {
  local ec url resolver_ec
  set +e
  "$@" > "$TMP" 2>&1
  ec=$?
  if [[ $ec -ne 0 ]] && grep -q EMAXCONNSESSION "$TMP"; then
    echo 'session pool full; retrying this command on port 6543' >> "$LOG"
    url="$(bun -e 'const {loadConfig}=await import(process.argv[1]); const u=new URL(loadConfig().database_url); u.port="6543"; process.stdout.write(u.href)' "$REPO/src/core/config.ts")"
    resolver_ec=$?
    if [[ $resolver_ec -ne 0 || -z "$url" ]]; then
      echo 'could not resolve transaction pooler URL' >> "$LOG"
      set -e
      [[ $resolver_ec -ne 0 ]] || resolver_ec=1
      return "$resolver_ec"
    fi
    GBRAIN_DATABASE_URL="$url" "$@" > "$TMP" 2>&1
    ec=$?
  fi
  set -e
  sed -E 's#postgres(ql)?://[^[:space:]]+#[redacted-url]#g' "$TMP" >> "$LOG"
  return "$ec"
}
if [[ $# -eq 0 ]]; then
  day="$(TZ="$zone" date +%Y-%m-%d)"
  files=()
  python3 "$REPO/scripts/daily-memory-codex-files.py" "$HOME/.codex/sessions" "$day" "$zone" > "$TMP"
  while IFS= read -r -d '' path; do files+=("$path"); done < "$TMP"
  if [[ ${#files[@]} -gt 0 ]]; then
    since="$(python3 -c '
import sys
from datetime import datetime, time, timezone
from zoneinfo import ZoneInfo
day, zone_name = sys.argv[1], sys.argv[2]
start = datetime.combine(datetime.fromisoformat(day).date(), time(), ZoneInfo(zone_name))
print(start.astimezone(timezone.utc).isoformat())
' "$day" "$zone")"
    printf 'codex ingest day=%s zone=%s files=%s\n' "$day" "$zone" "${#files[@]}" >> "$LOG"
    run_command bun "$REPO/src/cli.ts" transcripts ingest --format codex --since "$since" --source-id default --date-zone "$zone" "${files[@]}"
  fi
  # Writer prefers cycle.timezone over process TZ; pass the same calendar day
  # already used for selector/ingest so the index cannot land on another date.
  set -- "$day"
fi
printf 'daily-memory start %s zone=%s\n' "$(TZ="$zone" date '+%Y-%m-%d %H:%M:%S %z')" "$zone" >> "$LOG"
run_command bun "$REPO/scripts/write-daily-memory.ts" "$@"
echo 'daily-memory ok' >> "$LOG"
