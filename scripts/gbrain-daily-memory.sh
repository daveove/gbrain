#!/bin/bash
set -euo pipefail
export PATH="$HOME/.local/bin:$HOME/.bun/bin:/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin:/usr/sbin:/sbin"
export GBRAIN_POOL_SIZE=1 GBRAIN_SELF_UPGRADE_MODE=off GBRAIN_DISABLE_DIRECT_POOL=1
REPO="${GBRAIN_REPO_ROOT:-$HOME/gbrain}"
LOG="${GBRAIN_DAILY_MEMORY_LOG:-$HOME/Library/Logs/gbrain-daily-memory.log}"
STATE="${GBRAIN_DAILY_MEMORY_STATE:-$HOME/.local/state/gbrain}"
export GBRAIN_DAILY_MEMORY_STATE="$STATE"
WATERMARK="$STATE/daily-memory-codex-mtime"
mkdir -p "$(dirname "$LOG")" "$STATE"
if [[ -f "$HOME/.gbrain/env.sh" ]]; then
  source "$HOME/.gbrain/env.sh" >/dev/null 2>/dev/null
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
# Scheduled (no-arg) runs may scan Codex transcripts and may advance the
# mtime watermark. Explicit-date backfills only rewrite the daily index.
scheduled_run=0
# 1 unless a scheduled ingest reported cleanScan!=true (partial errors).
ingest_clean_scan=1
# Prospective watermark captured before selection/ingest so appends during the
# run stay at/after this floor on the next scheduled pass.
scan_started=""
if [[ $# -eq 0 ]]; then
  scheduled_run=1
  scan_started="$(python3 -c 'import datetime; print(datetime.datetime.now(datetime.timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ"))')"
  day="$(TZ="$zone" date +%Y-%m-%d)"
  files=()
  watermark=""
  if [[ -f "$WATERMARK" ]]; then
    watermark="$(tr -d '[:space:]' < "$WATERMARK" || true)"
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
  python3 "$REPO/scripts/daily-memory-codex-files.py" "$HOME/.codex/sessions" "$day" "$zone" "$watermark" > "$TMP"
  while IFS= read -r -d '' path; do files+=("$path"); done < "$TMP"
  if [[ ${#files[@]} -gt 0 ]]; then
    # Prefer the prior-run watermark as --since so cross-midnight rescans
    # (session mtime after last run, last message still before today's
    # midnight) are not filtered out by ingest.ts. Fall back to the target
    # day's midnight on the first scheduled run with no watermark yet.
    if [[ -n "$watermark" ]]; then
      since="$watermark"
    else
      since="$(python3 -c '
import sys
from datetime import datetime, time, timezone
from zoneinfo import ZoneInfo
day, zone_name = sys.argv[1], sys.argv[2]
start = datetime.combine(datetime.fromisoformat(day).date(), time(), ZoneInfo(zone_name))
print(start.astimezone(timezone.utc).isoformat())
' "$day" "$zone")"
    fi
    printf 'codex ingest day=%s zone=%s files=%s\n' "$day" "$zone" "${#files[@]}" >> "$LOG"
    # --json so the launcher can gate the mtime watermark on cleanScan; partial
    # file errors leave the process exit 0 (allFailed-only) and must not advance.
    run_command bun "$REPO/src/cli.ts" transcripts ingest --json --format codex --since "$since" --source-id default --date-zone "$zone" "${files[@]}"
    if ! python3 -c '
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
      ingest_clean_scan=0
      echo 'codex ingest unclean (cleanScan!=true); holding mtime watermark' >> "$LOG"
    fi
  fi
  # Pass the same calendar day already used for selector/ingest; zone rides in
  # GBRAIN_DAILY_MEMORY_ZONE so writer timestamp filters match day selection.
  # LOOKBACK asks the writer for previousCalendarDay refresh (inline/fanout parity)
  # without dropping the pinned day across a midnight boundary.
  export GBRAIN_DAILY_MEMORY_LOOKBACK=1
  set -- "$day"
fi
printf 'daily-memory start %s zone=%s\n' "$(TZ="$zone" date '+%Y-%m-%d %H:%M:%S %z')" "$zone" >> "$LOG"
run_command bun "$REPO/scripts/write-daily-memory.ts" "$@"
# Advance the Codex mtime watermark only after a successful scheduled write
# with a clean ingest (or no ingest when the day had no selected files).
# Explicit-date backfills skip transcript selection; advancing here would hide
# ongoing sessions that were never scanned. Partial unclean scans exit 0 but
# must not move the watermark or failed sessions can be skipped forever.
if [[ "$scheduled_run" -eq 1 && -n "$scan_started" && "$ingest_clean_scan" -eq 1 ]]; then
  # Commit the pre-scan stamp (not "now") so mid-run appends remain eligible.
  # Atomic rename: a crash mid-write must not leave an empty/malformed watermark
  # that resets the next run to day-midnight and permanently skips late sessions.
  python3 -c 'import os, pathlib, sys; p=pathlib.Path(sys.argv[1]); t=p.with_name(p.name+".tmp"); t.write_text(sys.argv[2]+"\n"); os.replace(t, p)' "$WATERMARK" "$scan_started"
fi
echo 'daily-memory ok' >> "$LOG"
