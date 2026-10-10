# Daily memory

Daily memory writes one index page per day, `daily-memory/YYYY-MM-DD`, in the
non-federated `dream` source. The page links the brain pages and source records
that belong to that day. A nightly launcher imports the day's agent sessions
first, so the index also covers them.

Daily memory replaces the Hermes dream cycle. That job ran
`dream_cycle_daily_cron.sh` and pushed `dream-cycle/raw/YYYY-MM-DD` pages. It
stopped on 2026-09-23 after repeated session-pool and missing-key failures and
is now removed from the Hermes scheduler. No new `dream-cycle/raw` pages are
written. Existing ones stay in the brain as history.

## Run it nightly

The launcher is `scripts/gbrain-daily-memory.sh`. On macOS a LaunchAgent named
`com.gbrain.daily-memory` runs an installed copy at 23:40 local time. The
launcher takes a kernel lock, so a second copy exits instead of racing the
first.

Each scheduled run does three things in order.

1. It imports the day's agent sessions with `gbrain transcripts ingest`. By
   default that is Codex only.
2. It runs `scripts/write-daily-memory.ts`, which writes today's index, the
   previous day's index and any days missed since the last run.
3. It extracts links once for every stale generated index, including indexes
   left over from earlier nights.

An explicit date argument, such as `gbrain-daily-memory.sh 2026-10-01`, skips
the transcript import and the lookback, so it writes that day's index plus any
days already queued by earlier imports. It still runs step 3.

## Choose which agents to import

Importing another agent's sessions is capture, so every seat beyond Codex is
opt-in. List the seats you want in `GBRAIN_DAILY_MEMORY_SEATS`, in the order to
import them. To import all six, set this in the LaunchAgent's environment:

```bash
GBRAIN_DAILY_MEMORY_SEATS="codex omp claude-code opencode pi cursor"
```

Leaving the variable unset imports Codex only. An unknown name is logged and
skipped. A seat whose directory is missing is skipped too. Each seat keeps its
own watermark, `daily-memory-<seat>-mtime` under `GBRAIN_DAILY_MEMORY_STATE`.
When one seat fails or imports only part of its sessions (`cleanScan` false),
the launcher holds that seat's watermark, imports the remaining seats, writes
the day, and then exits non-zero. Claude Code is read from
`$CLAUDE_CONFIG_DIR/projects` and OpenCode from
`$XDG_DATA_HOME/opencode/opencode.db` when those variables are set. Point a seat
at another directory with `GBRAIN_DAILY_MEMORY_<SEAT>_ROOT` (`CODEX`, `OMP`,
`CLAUDE_CODE`, `OPENCODE`, `PI`, `CURSOR`); that override always wins.

The launcher reads each session file whole up to 512 MB
(`GBRAIN_DAILY_MEMORY_MAX_BYTES`, any `--max-bytes` size such as `1gb`). A
larger file is read head and tail only, and a partly read file holds its seat's
watermark until a later run reads it whole.

## Keep the database on the session port

Every launcher command uses a pool of two connections on the Supabase session
pooler, port 5432. One connection deadlocks: a page write can need a second
connection inside its transaction. The launcher reads the database URL the way
every gbrain command does: the environment first, then `config.json` under
`GBRAIN_HOME`. When that URL is a Supabase pooler URL on port 6543, it moves it
to port 5432. It never retries on the transaction pooler. A full session pool
fails the run, and the next night retries.

## Drain queued days

Transcript imports queue rewrites of earlier days. The nightly writer works
through that queue for up to 30 minutes. Set `GBRAIN_DAILY_MEMORY_DRAIN_MS` to
change the budget. Each queued day has 10 minutes; a busy day's first write
takes about a minute on a hosted database. Days left when the budget ends stay
queued for the next run, and the run still extracts what it wrote.

## Size the extraction budget

Extraction setup reads every page reference in the brain. On a brain with
about 150,000 pages that takes a few minutes, so the writer pays it once per
run. The budget defaults to 30 minutes, including setup. Set
`GBRAIN_EXTRACT_TIME_BUDGET_MS` to change it.

When the budget runs out with work left, the writer exits non-zero with
`Daily memory extraction needs retry: N generated daily-index pages remain`.
The written indexes stay. The next run extracts the remainder.

## Catch up after an outage

Run the launcher once with a larger budget:

```bash
GBRAIN_EXTRACT_TIME_BUDGET_MS=7200000 ~/.local/bin/gbrain-daily-memory.sh "$(date +%F)"
```

The writer exits 0 only when no stale generated index remains, so a clean exit
is the backlog check. On the production brain, 263 stale indexes took about
14 minutes.

## Process queued fact jobs

Page writes queue `facts-absorb` jobs, which extract facts with a paid model.
Nothing processes them unless a worker runs. Set
`GBRAIN_DAILY_MEMORY_FACTS_MAX_USD` in the LaunchAgent's environment to let the
nightly run work through them after the day is written:

```bash
GBRAIN_DAILY_MEMORY_FACTS_MAX_USD=1
```

The step runs `scripts/run-facts-absorb.ts`, which claims only `facts-absorb`
jobs. It stops before its spend plus a worst-case cost for every job that could
still start would pass the cap, or after `GBRAIN_DAILY_MEMORY_FACTS_MAX_MINUTES`
(default 30). A full cap or a leftover backlog is normal; only a runner error
fails the night. Explicit-date runs skip this step.

To clear a large backlog once, run the same script by hand with a larger cap:

```bash
bun scripts/run-facts-absorb.ts --max-usd 70 --concurrency 4 --max-minutes 720
```

It prints one JSON line with the stop reason, jobs completed and failed, the
measured spend and the jobs still waiting.

## Read the logs

The launcher appends to `~/Library/Logs/gbrain-daily-memory.log` and redacts
database URLs. A healthy run ends with `daily-memory ok`. The LaunchAgent's own
stdout and stderr go to `~/Library/Logs/gbrain/daily-memory.{out,err}.log`.
