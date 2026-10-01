import datetime
import os
import stat
import json
import pathlib
import sys
from zoneinfo import ZoneInfo

root = pathlib.Path(sys.argv[1])
day = datetime.date.fromisoformat(sys.argv[2])
zone_name = sys.argv[3] if len(sys.argv) > 3 else 'UTC'
try:
    zone = ZoneInfo(zone_name)
except Exception:
    zone = datetime.timezone.utc
    zone_name = 'UTC'
start = datetime.datetime.combine(day, datetime.time(), zone).astimezone(datetime.timezone.utc)
end = start + datetime.timedelta(days=1)
# Optional prior-run watermark: sessions modified at/after this instant are
# reselected even when their start time and mtime fall outside today's window
# (e.g. final evening messages after an early same-day launcher run).
mtime_floor = start
if len(sys.argv) > 4 and sys.argv[4].strip():
    try:
        stamp = sys.argv[4].strip().replace('Z', '+00:00')
        watermark = datetime.datetime.fromisoformat(stamp)
        if watermark.tzinfo is None:
            watermark = watermark.replace(tzinfo=datetime.timezone.utc)
        mtime_floor = min(watermark.astimezone(datetime.timezone.utc), start)
    except ValueError:
        pass
# Sessions live under the UTC date of creation. Without a watermark, look back
# 14 days for mtime overlap. With a watermark, walk every existing day folder
# up to `last` so a resumed session older than 14 days is still found by mtime.
last = (end - datetime.timedelta(microseconds=1)).date()
selected: list[pathlib.Path] = []
def fail_scan(action: str, target: pathlib.Path, exc: BaseException) -> None:
    print(f'daily-memory-codex-files: cannot {action} {target}: {exc}', file=sys.stderr)
    raise SystemExit(1)


def scandir_sorted(directory: pathlib.Path):
    """List directory entries; surface OSError instead of Path.glob suppression."""
    try:
        return sorted(os.scandir(directory), key=lambda entry: entry.name)
    except FileNotFoundError:
        return []
    except OSError as exc:
        fail_scan('list', directory, exc)


def day_directories(sessions_root: pathlib.Path, *, watermark: bool) -> list[pathlib.Path]:
    if not watermark:
        lookback_start = (start - datetime.timedelta(days=14)).date()
        found: list[pathlib.Path] = []
        utc_day = lookback_start
        while utc_day <= last:
            directory = sessions_root / utc_day.strftime('%Y/%m/%d')
            try:
                st = directory.stat()
            except FileNotFoundError:
                utc_day += datetime.timedelta(days=1)
                continue
            except OSError as exc:
                fail_scan('stat', directory, exc)
            if stat.S_ISDIR(st.st_mode):
                found.append(directory)
            utc_day += datetime.timedelta(days=1)
        return found
    # Watermark path: walk every existing YYYY/MM/DD (no 14-day creation cutoff).
    found = []
    for year_ent in scandir_sorted(sessions_root):
        if not (year_ent.is_dir(follow_symlinks=False) and len(year_ent.name) == 4 and year_ent.name.isdigit()):
            continue
        year_path = pathlib.Path(year_ent.path)
        for month_ent in scandir_sorted(year_path):
            if not (month_ent.is_dir(follow_symlinks=False) and len(month_ent.name) == 2 and month_ent.name.isdigit()):
                continue
            month_path = pathlib.Path(month_ent.path)
            for day_ent in scandir_sorted(month_path):
                if not (day_ent.is_dir(follow_symlinks=False) and len(day_ent.name) == 2 and day_ent.name.isdigit()):
                    continue
                try:
                    utc_day = datetime.date.fromisoformat(f'{year_ent.name}-{month_ent.name}-{day_ent.name}')
                except ValueError:
                    continue
                if utc_day <= last:
                    found.append(pathlib.Path(day_ent.path))
    return found


# argv[4] present ⇒ walk all existing day dirs (no 14-day creation cutoff).
has_watermark = len(sys.argv) > 4 and bool(sys.argv[4].strip())
directories = day_directories(root, watermark=has_watermark)
for directory in directories:
    try:
        # Include symlinks named *.jsonl so a broken/unreadable target fails
        # closed at stat/open instead of being silently omitted by is_file().
        jsonl_paths = sorted(
            (pathlib.Path(entry.path) for entry in os.scandir(directory)
             if entry.name.endswith('.jsonl')
             and (entry.is_file(follow_symlinks=False) or entry.is_symlink())),
            key=lambda p: p.name,
        )
    except FileNotFoundError:
        continue
    except OSError as exc:
        fail_scan('list', directory, exc)
    for path in jsonl_paths:
        try:
            mtime = datetime.datetime.fromtimestamp(path.stat().st_mtime, datetime.timezone.utc)
        except OSError as exc:
            # Fail closed: a skipped unreadable session plus a clean watermark
            # advance would hide it forever once mtime falls behind the stamp.
            fail_scan('stat', path, exc)
        meta_in_window = False
        try:
            with path.open() as transcript:
                for index, line in enumerate(transcript):
                    if index >= 10:
                        break
                    try:
                        entry = json.loads(line)
                        if entry.get('type') != 'session_meta':
                            continue
                        stamp = entry['payload'].get('timestamp') or entry['timestamp']
                        instant = datetime.datetime.fromisoformat(stamp.replace('Z', '+00:00'))
                        if start <= instant < end:
                            meta_in_window = True
                        break
                    except (ValueError, KeyError, TypeError):
                        continue
        except OSError as exc:
            fail_scan('read', path, exc)
        # Start-time match for the calendar day, or modified since the prior
        # run / today's start so late evening messages converge on the next run.
        if meta_in_window or (mtime_floor <= mtime < end):
            selected.append(path)

for path in selected:
    # A 00:00-07:59 Manila session lives in the previous UTC folder. Ingest
    # stamps this selected day (--date-zone); the UTC date prefix would index
    # it yesterday.
    sys.stdout.buffer.write(str(path).encode() + b'\0')
