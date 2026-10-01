import datetime
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
# Sessions live under the UTC date of creation. A long-lived session that is
# still receiving messages may sit in an older folder; look back so mtime
# overlap can select it. The transcript importer hash-skips unchanged files.
lookback_start = (start - datetime.timedelta(days=14)).date()
last = (end - datetime.timedelta(microseconds=1)).date()
selected: list[pathlib.Path] = []
utc_day = lookback_start
while utc_day <= last:
    directory = root / utc_day.strftime('%Y/%m/%d')
    utc_day += datetime.timedelta(days=1)
    if not directory.is_dir():
        continue
    for path in sorted(directory.glob('*.jsonl')):
        try:
            mtime = datetime.datetime.fromtimestamp(path.stat().st_mtime, datetime.timezone.utc)
        except OSError:
            continue
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
        except OSError:
            continue
        # Start-time match for the calendar day, or modified since the prior
        # run / today's start so late evening messages converge on the next run.
        if meta_in_window or (mtime_floor <= mtime < end):
            selected.append(path)

for path in selected:
    # A 00:00-07:59 Manila session lives in the previous UTC folder. Ingest
    # stamps this selected day (--date-zone); the UTC date prefix would index
    # it yesterday.
    sys.stdout.buffer.write(str(path).encode() + b'\0')
