import datetime
import json
import pathlib
import sys

root = pathlib.Path(sys.argv[1])
day = datetime.date.fromisoformat(sys.argv[2])
zone = datetime.timezone(datetime.timedelta(hours=8))
start = datetime.datetime.combine(day, datetime.time(), zone).astimezone(datetime.timezone.utc)
end = start + datetime.timedelta(days=1)
for utc_day in sorted({start.date(), (end - datetime.timedelta(microseconds=1)).date()}):
    directory = root / utc_day.strftime('%Y/%m/%d')
    for path in sorted(directory.glob('*.jsonl')):
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
                        sys.stdout.buffer.write(str(path).encode() + b'\0')
                    break
                except (ValueError, KeyError, TypeError):
                    continue
