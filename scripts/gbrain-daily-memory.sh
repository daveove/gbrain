#!/bin/bash
set -euo pipefail
export PATH="$HOME/.local/bin:$HOME/.bun/bin:/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin:/usr/sbin:/sbin"
export GBRAIN_POOL_SIZE=1 GBRAIN_SELF_UPGRADE_MODE=off GBRAIN_DISABLE_DIRECT_POOL=1
export TZ=Asia/Manila
REPO="${GBRAIN_REPO_ROOT:-$HOME/gbrain}"
LOG="${GBRAIN_DAILY_MEMORY_LOG:-$HOME/Library/Logs/gbrain-daily-memory.log}"
mkdir -p "$(dirname "$LOG")" "$HOME/.local/state/gbrain"
if [[ -f "$HOME/.gbrain/env.sh" ]]; then
  source "$HOME/.gbrain/env.sh" >/dev/null 2>/dev/null
fi
LOCK="$HOME/.local/state/gbrain/daily-memory.lock"
if ! mkdir "$LOCK" 2>/dev/null; then
  pid="$(cat "$LOCK/pid" 2>/dev/null || true)"
  if [[ -n "$pid" ]] && kill -0 "$pid" 2>/dev/null; then
    echo 'daily-memory writer already running' >> "$LOG"
    exit 0
  fi
  rm -f "$LOCK/pid"
  rmdir "$LOCK"
  mkdir "$LOCK"
fi
printf '%s\n' "$$" > "$LOCK/pid"
TMP="$(mktemp)"
trap 'rm -f "$TMP" "$LOCK/pid"; rmdir "$LOCK"' EXIT
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
  day="$(TZ=Asia/Manila date +%Y-%m-%d)"
  files=()
  python3 "$REPO/scripts/daily-memory-codex-files.py" "$HOME/.codex/sessions" "$day" > "$TMP"
  while IFS= read -r -d '' path; do files+=("$path"); done < "$TMP"
  if [[ ${#files[@]} -gt 0 ]]; then
    since="$(python3 -c 'import datetime,sys; d=datetime.datetime.fromisoformat(sys.argv[1]+"T00:00:00+08:00"); print(d.astimezone(datetime.timezone.utc).isoformat())' "$day")"
    printf 'codex ingest day=%s files=%s\n' "$day" "${#files[@]}" >> "$LOG"
    run_command bun "$REPO/src/cli.ts" transcripts ingest --format codex --since "$since" --source-id default --date-zone Asia/Manila "${files[@]}"
  fi
fi
printf 'daily-memory start %s\n' "$(TZ=Asia/Manila date '+%Y-%m-%d %H:%M:%S %z')" >> "$LOG"
run_command bun "$REPO/scripts/write-daily-memory.ts" "$@"
echo 'daily-memory ok' >> "$LOG"
