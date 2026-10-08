#!/bin/bash
set -euo pipefail
export PATH="$HOME/.local/bin:$HOME/.bun/bin:/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin:/usr/sbin:/sbin"
# Two connections: putPage can need a second one inside its transaction.
export GBRAIN_POOL_SIZE=2 GBRAIN_SELF_UPGRADE_MODE=off GBRAIN_DISABLE_DIRECT_POOL=1
REPO="${GBRAIN_REPO_ROOT:-$HOME/gbrain}"
LOG="${GBRAIN_DAILY_MEMORY_LOG:-$HOME/Library/Logs/gbrain-daily-memory.log}"
STATE="${GBRAIN_DAILY_MEMORY_STATE:-$HOME/.local/state/gbrain}"
export GBRAIN_DAILY_MEMORY_STATE="$STATE"
mkdir -p "$(dirname "$LOG")" "$STATE"
if [[ -f "$HOME/.gbrain/env.sh" ]]; then
  source "$HOME/.gbrain/env.sh" >/dev/null 2>/dev/null
fi
# Scheduled jobs hold one session-mode connection (:5432), never the Supabase
# transaction pooler (:6543). loadConfig honors GBRAIN_HOME and env precedence.
session_url="$(bun -e 'const { loadConfig } = await import(process.argv[1]); const { deriveSessionPoolerUrl } = await import(process.argv[2]); const url = loadConfig()?.database_url; if (url) process.stdout.write(deriveSessionPoolerUrl(url) ?? url);' "$REPO/src/core/config.ts" "$REPO/src/core/connection-manager.ts")"
if [[ -n "$session_url" ]]; then
  export GBRAIN_DATABASE_URL="$session_url" DATABASE_URL="$session_url"
fi
# Launcher calendar zone: explicit setting > brain DB (config set) >
# file-plane cycle.timezone > TZ from env.sh/host > UTC.
zone="$(REPO="$REPO" python3 -c '
import json, os, subprocess
from pathlib import Path
explicit = (os.environ.get("GBRAIN_DAILY_MEMORY_TZ") or "").strip()
if explicit:
    print(explicit, end="")
    raise SystemExit
repo = Path(os.environ["REPO"])
helper = repo / "scripts" / "daily-memory-timezone.ts"
bun = os.environ.get("PATH", "")
try:
    proc = subprocess.run(
        ["bun", str(helper)],
        capture_output=True, text=True, timeout=60,
        env=os.environ,
    )
    value = (proc.stdout or "").strip()
    if proc.returncode == 0 and value:
        print(value, end="")
        raise SystemExit
except (OSError, subprocess.SubprocessError):
    pass
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
# Writer reloads cycle.timezone from DB unless given this selected zone.
export GBRAIN_DAILY_MEMORY_ZONE="$zone"
if [[ "${GBRAIN_DAILY_LOCK_FD:-}" != 9 ]]; then
  exec python3 "$REPO/scripts/daily-memory-lock.py" "$0" "$@"
fi
TMP="$(mktemp)"
EXPORTS="$(mktemp -d)"
trap 'rm -rf "$TMP" "$EXPORTS"' EXIT
run_command() {
  local ec
  set +e
  "$@" > "$TMP" 2>&1
  ec=$?
  set -e
  sed -E 's#postgres(ql)?://[^[:space:]]+#[redacted-url]#g' "$TMP" >> "$LOG"
  return "$ec"
}
# Agent seats ingested on scheduled runs, in the order listed. Reading another
# harness's sessions is capture, so seats beyond codex are opt-in:
# GBRAIN_DAILY_MEMORY_SEATS="codex omp claude-code opencode pi cursor".
# Each seat has its own mtime watermark under $STATE; a seat whose root is
# absent is skipped.
read -r -a SEATS <<< "${GBRAIN_DAILY_MEMORY_SEATS:-codex}"
seat_root() {
  case "$1" in
    codex) printf '%s' "${GBRAIN_DAILY_MEMORY_CODEX_ROOT:-$HOME/.codex/sessions}" ;;
    omp) printf '%s' "${GBRAIN_DAILY_MEMORY_OMP_ROOT:-$HOME/.omp/agent/sessions}" ;;
    claude-code) printf '%s' "${GBRAIN_DAILY_MEMORY_CLAUDE_CODE_ROOT:-${CLAUDE_CONFIG_DIR:-$HOME/.claude}/projects}" ;;
    opencode) printf '%s' "${GBRAIN_DAILY_MEMORY_OPENCODE_ROOT:-${XDG_DATA_HOME:-$HOME/.local/share}/opencode/opencode.db}" ;;
    pi) printf '%s' "${GBRAIN_DAILY_MEMORY_PI_ROOT:-$HOME/.pi/agent/sessions}" ;;
    cursor) printf '%s' "${GBRAIN_DAILY_MEMORY_CURSOR_ROOT:-$HOME/.cursor/projects}" ;;
  esac
}
# Scheduled (no-arg) runs scan every seat and may advance their watermarks.
# Explicit-date backfills only rewrite the daily index.
scheduled_run=0
# Seats whose scan was clean; only these advance after a successful write.
advance_seats=()
# First failing seat's exit code. A failed seat holds its watermark, the
# other seats and the daily write still run, and the launcher exits with it.
seat_failure=0
# Prospective watermark captured before selection/ingest so appends during the
# run stay at/after this floor on the next scheduled pass.
scan_started=""
if [[ $# -eq 0 ]]; then
  scheduled_run=1
  scan_started="$(python3 -c 'import datetime; print(datetime.datetime.now(datetime.timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ"))')"
  day="$(TZ="$zone" date +%Y-%m-%d)"
  # --since for a seat with no watermark yet: the target day's local midnight.
  day_start="$(python3 -c '
import sys
from datetime import datetime, time, timezone
from zoneinfo import ZoneInfo
day, zone_name = sys.argv[1], sys.argv[2]
start = datetime.combine(datetime.fromisoformat(day).date(), time(), ZoneInfo(zone_name))
print(start.astimezone(timezone.utc).isoformat())
' "$day" "$zone")"
  for seat in ${SEATS[@]+"${SEATS[@]}"}; do
    root="$(seat_root "$seat")"
    if [[ -z "$root" ]]; then
      printf '%s skipped: unknown seat in GBRAIN_DAILY_MEMORY_SEATS\n' "$seat" >> "$LOG"
      continue
    fi
    if [[ ! -e "$root" ]]; then
      printf '%s skipped: no root at %s\n' "$seat" "$root" >> "$LOG"
      continue
    fi
    mark="$STATE/daily-memory-$seat-mtime"
    watermark=""
    if [[ -f "$mark" ]]; then
      watermark="$(tr -d '[:space:]' < "$mark" || true)"
    fi
    # Reject malformed or future watermarks once; selector and ingest --since
    # must share that normalized value or a future cutoff can filter every
    # selected session while still reporting cleanScan=true.
    if [[ -n "$watermark" ]]; then
      watermark="$(python3 -c '
import sys
from datetime import datetime, timezone
raw = sys.argv[1].strip()
if not raw:
    raise SystemExit(0)
try:
    stamp = raw.replace("Z", "+00:00")
    dt = datetime.fromisoformat(stamp)
except ValueError:
    raise SystemExit(0)
if dt.tzinfo is None:
    dt = dt.replace(tzinfo=timezone.utc)
if dt.astimezone(timezone.utc) > datetime.now(timezone.utc):
    raise SystemExit(0)
print(raw)
' "$watermark" || true)"
    fi
    ec=0
    python3 "$REPO/scripts/daily-memory-seat-files.py" "$seat" "$root" "$day" "$zone" "$watermark" "$EXPORTS" > "$TMP" 2>> "$LOG" || ec=$?
    if [[ $ec -ne 0 ]]; then
      printf '%s selection failed (exit %s); holding its watermark\n' "$seat" "$ec" >> "$LOG"
      [[ $seat_failure -ne 0 ]] || seat_failure=$ec
      continue
    fi
    files=()
    while IFS= read -r -d '' path; do files+=("$path"); done < "$TMP"
    if [[ ${#files[@]} -eq 0 ]]; then
      advance_seats+=("$seat")
      continue
    fi
    # Prefer the prior-run watermark as --since so cross-midnight rescans
    # (session mtime after last run, last message still before today's
    # midnight) are not filtered out by ingest.ts.
    since="${watermark:-$day_start}"
    printf '%s ingest day=%s zone=%s files=%s\n' "$seat" "$day" "$zone" "${#files[@]}" >> "$LOG"
    # --json so the launcher can gate the watermark on cleanScan; partial
    # file errors leave the process exit 0 (allFailed-only) and must not advance.
    ec=0
    run_command bun "$REPO/src/cli.ts" transcripts ingest --json --format "$seat" --since "$since" --source-id default --date-zone "$zone" "${files[@]}" || ec=$?
    if [[ $ec -ne 0 ]]; then
      printf '%s ingest failed (exit %s); holding its watermark\n' "$seat" "$ec" >> "$LOG"
      [[ $seat_failure -ne 0 ]] || seat_failure=$ec
      continue
    fi
    if python3 -c '
import json, sys
text = open(sys.argv[1], encoding="utf-8", errors="replace").read()
decoder = json.JSONDecoder()
clean = None
i = 0
while True:
    j = text.find("{", i)
    if j < 0:
        break
    try:
        obj, end = decoder.raw_decode(text, j)
    except json.JSONDecodeError:
        i = j + 1
        continue
    if isinstance(obj, dict) and "cleanScan" in obj:
        clean = obj["cleanScan"]
    i = end
raise SystemExit(0 if clean is True else 1)
' "$TMP"; then
      advance_seats+=("$seat")
    else
      printf '%s ingest unclean (cleanScan!=true); holding its watermark\n' "$seat" >> "$LOG"
      [[ $seat_failure -ne 0 ]] || seat_failure=1
    fi
  done
  # Pass the same calendar day already used for selector/ingest; zone rides in
  # GBRAIN_DAILY_MEMORY_ZONE so writer timestamp filters match day selection.
  # LOOKBACK asks the writer for previousCalendarDay refresh (inline/fanout parity)
  # without dropping the pinned day across a midnight boundary.
  export GBRAIN_DAILY_MEMORY_LOOKBACK=1
  set -- "$day"
fi
printf 'daily-memory start %s zone=%s\n' "$(TZ="$zone" date '+%Y-%m-%d %H:%M:%S %z')" "$zone" >> "$LOG"
run_command bun "$REPO/scripts/write-daily-memory.ts" "$@"
# Advance each clean seat's watermark only after a successful scheduled write
# (an empty selection is clean). Explicit-date backfills skip selection;
# advancing there would hide ongoing sessions that were never scanned.
if [[ "$scheduled_run" -eq 1 && -n "$scan_started" ]]; then
  for seat in ${advance_seats[@]+"${advance_seats[@]}"}; do
    # Commit the pre-scan stamp (not "now") so mid-run appends remain eligible.
    # Atomic rename: a crash mid-write must not leave an empty/malformed watermark
    # that resets the next run to day-midnight and permanently skips late sessions.
    python3 -c 'import os, pathlib, sys; p=pathlib.Path(sys.argv[1]); t=p.with_name(p.name+".tmp"); t.write_text(sys.argv[2]+"\n"); os.replace(t, p)' "$STATE/daily-memory-$seat-mtime" "$scan_started"
  done
fi
if [[ $seat_failure -ne 0 ]]; then
  printf 'daily-memory wrote the day with seat failures; exit %s\n' "$seat_failure" >> "$LOG"
  exit "$seat_failure"
fi
echo 'daily-memory ok' >> "$LOG"
