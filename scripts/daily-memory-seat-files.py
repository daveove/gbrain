"""Select one agent seat's sessions for a local calendar day.

usage: daily-memory-seat-files.py SEAT ROOT DAY ZONE [WATERMARK] [EXPORT_DIR]

Prints NUL-separated session files for `gbrain transcripts ingest --format
SEAT`. A session is selected when it started inside the local day, or was
modified at/after min(WATERMARK, day start) and before the next local
midnight, so late messages after an earlier run converge on the next one.

Every listing/stat/read error fails the scan (exit 1) so the launcher holds
that seat's watermark instead of hiding an unread session forever.

opencode keeps sessions in SQLite. Its ROOT is the opencode.db file, opened
read-only; each selected session is written to EXPORT_DIR in the
`opencode export` JSON shape and that file path is printed.
"""

import datetime
import json
import os
import pathlib
import sqlite3
import sys
from zoneinfo import ZoneInfo

UTC = datetime.timezone.utc
CLAUDE_SELF_CWD = 'gbrain-claude-cli-cwd-'


def fail_scan(action: str, target, exc: BaseException) -> None:
    print(f'daily-memory-seat-files: cannot {action} {target}: {exc}', file=sys.stderr)
    raise SystemExit(1)


def scandir_sorted(directory: pathlib.Path, *, missing_ok: bool = True):
    """List directory entries; a missing ROOT (missing_ok=False) fails closed."""
    try:
        return sorted(os.scandir(directory), key=lambda entry: entry.name)
    except FileNotFoundError as exc:
        if missing_ok:
            return []
        fail_scan('list', directory, exc)
    except OSError as exc:
        fail_scan('list', directory, exc)


def subdirs(directory: pathlib.Path, *, missing_ok: bool = True) -> list[pathlib.Path]:
    return [pathlib.Path(e.path) for e in scandir_sorted(directory, missing_ok=missing_ok)
            if e.is_dir(follow_symlinks=False)]


def jsonl_files(directory: pathlib.Path) -> list[pathlib.Path]:
    # Symlinks named *.jsonl are kept so a broken target fails closed at
    # stat/open instead of being silently omitted.
    return [pathlib.Path(e.path) for e in scandir_sorted(directory)
            if e.name.endswith('.jsonl') and (e.is_file(follow_symlinks=False) or e.is_symlink())]


def parse_instant(stamp) -> datetime.datetime | None:
    if not isinstance(stamp, str) or not stamp:
        return None
    try:
        instant = datetime.datetime.fromisoformat(stamp.replace('Z', '+00:00'))
    except ValueError:
        return None
    return instant if instant.tzinfo else instant.replace(tzinfo=UTC)


def head_start(path: pathlib.Path, pick, limit: int) -> datetime.datetime | None:
    """Session start from the first `limit` lines via `pick(entry) -> stamp`."""
    try:
        with path.open() as transcript:
            for index, line in enumerate(transcript):
                if index >= limit:
                    return None
                try:
                    entry = json.loads(line)
                except ValueError:
                    continue
                if not isinstance(entry, dict):
                    continue
                stamp = pick(entry)
                if stamp is not None:
                    return parse_instant(stamp)
    except OSError as exc:
        fail_scan('read', path, exc)
    return None


# ── Seat layouts: each returns candidate files and reads a start time ──────

def codex_files(root: pathlib.Path, last: datetime.date) -> list[pathlib.Path]:
    # Rollouts live under the UTC creation date YYYY/MM/DD. Every existing day
    # up to `last` is walked so a resumed session older than any window is
    # still found by mtime on a first run with no watermark.
    found = []
    for year in subdirs(root, missing_ok=False):
        if not (len(year.name) == 4 and year.name.isdigit()):
            continue
        for month in subdirs(year):
            if not (len(month.name) == 2 and month.name.isdigit()):
                continue
            for day in subdirs(month):
                if not (len(day.name) == 2 and day.name.isdigit()):
                    continue
                try:
                    utc_day = datetime.date.fromisoformat(f'{year.name}-{month.name}-{day.name}')
                except ValueError:
                    continue
                if utc_day <= last:
                    found.extend(jsonl_files(day))
    return found


def codex_start(entry: dict):
    if entry.get('type') != 'session_meta':
        return None
    payload = entry.get('payload') if isinstance(entry.get('payload'), dict) else {}
    return payload.get('timestamp') or entry.get('timestamp') or ''


def pi_files(root: pathlib.Path, _last) -> list[pathlib.Path]:
    # <root>/<cwd-slug>/<session>.jsonl. omp nests subagent runs one level
    # deeper (<session>/<Agent>.jsonl); those are delegated work, not the
    # user's sessions, and are not selected.
    return [p for d in subdirs(root, missing_ok=False) for p in jsonl_files(d)]


def pi_start(entry: dict):
    return entry.get('timestamp') or '' if entry.get('type') == 'session' else None


def claude_files(root: pathlib.Path, _last) -> list[pathlib.Path]:
    # Same exclusions as `transcripts ingest` discovery: subagent logs
    # (agent-*.jsonl under any `subagents` dir), workflow run artifacts, and
    # gbrain's own claude-cli scratch sessions (self-ingestion loop).
    found = []

    def walk(directory: pathlib.Path, depth: int, missing_ok: bool) -> None:
        for entry in scandir_sorted(directory, missing_ok=missing_ok):
            path = pathlib.Path(entry.path)
            if entry.is_dir(follow_symlinks=False):
                if depth < 6:
                    walk(path, depth + 1, True)
                continue
            if not entry.name.endswith('.jsonl'):
                continue
            parts = path.relative_to(root).parts
            if 'subagents' in parts[:-1] and entry.name.startswith('agent-'):
                continue
            last_sub = len(parts) - 1 - parts[::-1].index('subagents') if 'subagents' in parts else -1
            if last_sub >= 0 and len(parts) > last_sub + 2 and parts[last_sub + 1] == 'workflows':
                continue
            if CLAUDE_SELF_CWD in str(path):
                continue
            if entry.is_file(follow_symlinks=False) or entry.is_symlink():
                found.append(path)

    walk(root, 0, False)
    return found


def claude_start(entry: dict):
    stamp = entry.get('timestamp')
    return stamp if isinstance(stamp, str) and stamp else None


def cursor_files(root: pathlib.Path, _last) -> list[pathlib.Path]:
    # <root>/<project>/agent-transcripts/<uuid>/<uuid>.jsonl; `subagents/`
    # beside it holds delegated runs and is not selected.
    found = []
    for project in subdirs(root, missing_ok=False):
        for session in subdirs(project / 'agent-transcripts'):
            candidate = session / f'{session.name}.jsonl'
            if candidate.exists() or candidate.is_symlink():
                found.append(candidate)
    return found


SEATS = {
    'codex': (codex_files, codex_start, 10),
    'omp': (pi_files, pi_start, 10),
    'pi': (pi_files, pi_start, 10),
    'claude-code': (claude_files, claude_start, 50),
    # Cursor lines carry no timestamps: selection is by mtime alone.
    'cursor': (cursor_files, None, 0),
}


def select_files(seat, root, start, end, mtime_floor):
    list_files, pick, limit = SEATS[seat]
    last = (end - datetime.timedelta(microseconds=1)).date()
    selected = []
    for path in list_files(root, last):
        try:
            mtime = datetime.datetime.fromtimestamp(path.stat().st_mtime, UTC)
        except OSError as exc:
            fail_scan('stat', path, exc)
        started = head_start(path, pick, limit) if pick else None
        if (started is not None and start <= started < end) or (mtime_floor <= mtime < end):
            selected.append(path)
    return selected


def select_opencode(db: pathlib.Path, start, end, mtime_floor, export_dir: pathlib.Path):
    """Export changed top-level sessions from a read-only opencode.db.

    Direct read instead of `opencode export <id>`: that spawns the full CLI per
    session (~1.4s each, needs the binary on the launchd PATH, and opens the
    store read-write), while selection needs this query anyway. The written
    shape matches `opencode export`, so either source ingests identically.
    """
    to_ms = lambda dt: int(dt.timestamp() * 1000)
    try:
        con = sqlite3.connect(f'{db.resolve().as_uri()}?mode=ro', uri=True)
    except (sqlite3.Error, OSError) as exc:
        fail_scan('open', db, exc)
    selected = []
    try:
        sessions = con.execute(
            'SELECT id, title, directory, version, time_created, time_updated FROM session '
            'WHERE parent_id IS NULL '
            'AND ((time_created >= ? AND time_created < ?) OR (time_updated >= ? AND time_updated < ?)) '
            'ORDER BY id',
            (to_ms(start), to_ms(end), to_ms(mtime_floor), to_ms(end)),
        ).fetchall()
        for sid, title, directory, version, created, updated in sessions:
            messages = []
            rows = con.execute(
                'SELECT id, data FROM message WHERE session_id = ? ORDER BY time_created, id', (sid,))
            for mid, data in rows.fetchall():
                info = json.loads(data)
                info.update(id=mid, sessionID=sid)
                parts = []
                for pid, pdata in con.execute(
                        'SELECT id, data FROM part WHERE message_id = ? ORDER BY id', (mid,)).fetchall():
                    part = json.loads(pdata)
                    part.update(id=pid, messageID=mid, sessionID=sid)
                    parts.append(part)
                messages.append({'info': info, 'parts': parts})
            doc = {
                'info': {'id': sid, 'title': title, 'directory': directory, 'version': version,
                         'time': {'created': created, 'updated': updated}},
                'messages': messages,
            }
            out = export_dir / f'{sid}.json'
            out.write_text(json.dumps(doc, indent=2) + '\n')
            selected.append(out)
    except (sqlite3.Error, ValueError, OSError) as exc:
        fail_scan('read', db, exc)
    finally:
        con.close()
    return selected


def main(argv: list[str]) -> None:
    seat, root = argv[1], pathlib.Path(argv[2])
    if seat != 'opencode' and seat not in SEATS:
        print(f'daily-memory-seat-files: unknown seat {seat}', file=sys.stderr)
        raise SystemExit(2)
    day = datetime.date.fromisoformat(argv[3])
    try:
        zone = ZoneInfo(argv[4] if len(argv) > 4 else 'UTC')
    except Exception:
        zone = UTC
    start = datetime.datetime.combine(day, datetime.time(), zone).astimezone(UTC)
    # Next local midnight (not start+24h) so DST days stay exact.
    end = datetime.datetime.combine(day + datetime.timedelta(days=1), datetime.time(), zone).astimezone(UTC)
    mtime_floor = start
    watermark = parse_instant(argv[5].strip()) if len(argv) > 5 else None
    # Future stamps are ignored: a clock correction must not raise the floor.
    if watermark is not None and watermark <= datetime.datetime.now(UTC):
        mtime_floor = min(watermark.astimezone(UTC), start)

    if seat == 'opencode':
        if len(argv) < 7 or not argv[6]:
            print('daily-memory-seat-files: opencode needs EXPORT_DIR', file=sys.stderr)
            raise SystemExit(2)
        try:
            root.stat()
        except OSError as exc:
            fail_scan('stat', root, exc)
        selected = select_opencode(root, start, end, mtime_floor, pathlib.Path(argv[6]))
    else:
        selected = select_files(seat, root, start, end, mtime_floor)
        # A root that vanished mid-walk is not a clean empty scan.
        try:
            root.stat()
        except OSError as exc:
            fail_scan('stat', root, exc)

    for path in selected:
        sys.stdout.buffer.write(str(path).encode() + b'\0')


if __name__ == '__main__':
    main(sys.argv)
