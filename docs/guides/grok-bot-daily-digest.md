# Grok Bot daily digest over HTTP MCP

A Grok Bot routine can write one digest page per day into your brain through
`gbrain serve --http`. This guide defines that write contract, shows how to
verify it on loopback, and lists what publishing it beyond your computer would
take. The publication step is not part of the verified local setup.

**Say to your agent:** *"Give my Grok Bot a daily digest page in my brain"*
(on the brain host, the agent runs `gbrain mcp grant` with
`--bound-slug-prefixes digests/grok-bot/`). *"Save today's digest to my
brain"* (inside the Bot, the agent runs `gbrain put digests/grok-bot/<date>
--force --request-id <uuid>`).

The contract uses only existing pieces: the `memory-writer` grant profile, a
`--bound-slug-prefixes` write fence, and the `put_page` operation's
`request_id` and `force` parameters. No digest-specific server code exists.

## Host setup (loopback only)

Start the server bound to loopback with an owner credential from a private
file. Give every path its symlink-free real path. On macOS, `/tmp` is a
symlink to `/private/tmp`. The admin token file, the credential handoff, and
the server's `GBRAIN_HOME` reject symlinked paths.

```bash
umask 077
openssl rand -hex 32 > /absolute/private/admin-token
GBRAIN_ADMIN_BOOTSTRAP_TOKEN=$(cat /absolute/private/admin-token) \
  gbrain serve --http --bind 127.0.0.1 --port 3131
```

Grant the routine a fenced `memory-writer` client through the running server:

```bash
gbrain mcp grant grok-bot-digest --harness grok-bot --profile memory-writer --source default \
  --bound-slug-prefixes digests/grok-bot/ \
  --url http://127.0.0.1:3131/mcp \
  --admin-token-file /absolute/private/admin-token \
  --credentials-out /absolute/private/grok-bot-digest.json --json
```

The receipt reports `boundSlugPrefixes: ["digests/grok-bot/"]`, scopes
`read write skills_member_self`, and surface `full`. The handoff file holds
`client_id`, `client_secret`, an initial `access_token`, `mcp_url`, and
`issuer_url`. Keep it private and never paste it into chat.

The fence confines writes only. The grant can still read every page in its
read sources (`federatedRead`, which defaults to `[default]`).

## The write contract

### One page per day

| Field | Value |
| --- | --- |
| Operation | `put_page` |
| Slug | `digests/grok-bot/YYYY-MM-DD`, using the routine's own calendar date |
| `content` | Complete Markdown with YAML frontmatter. It replaces the whole page. |
| `force` | `true` |
| `request_id` | A new lowercase UUID for each run. Reuse it only to retry that same run. |

`put_page` with `force: true` creates the page when it is absent and replaces it
when it exists. A second run on the same date therefore updates the one page.
It does not create a duplicate.

Remote clients cannot write `daily-memory/` pages. The nightly
`daily-memory/YYYY-MM-DD` index belongs to the host, so the routine writes under
its own fenced prefix.

Example content:

```markdown
---
type: note
title: Grok Bot digest 2026-10-06
digest_date: 2026-10-06
---

# Grok Bot digest 2026-10-06

- Decided: ship the acme-example pilot.
- alice-example confirmed the review slot.
```

### Each run

1. Mint a token. Access tokens last 3600 seconds, so a daily routine always
   needs a fresh one.

   ```bash
   curl -s -X POST http://127.0.0.1:3131/token -d grant_type=client_credentials \
     -d client_id=$CLIENT_ID -d client_secret=$CLIENT_SECRET
   ```

   ```json
   {"access_token":"<token>","token_type":"bearer","expires_in":3600,"scope":"read write skills_member_self"}
   ```

2. Generate `REQUEST_ID` (a UUID) and write the page:

   ```bash
   curl -s -X POST http://127.0.0.1:3131/mcp \
     -H "Authorization: Bearer $TOKEN" -H 'Content-Type: application/json' \
     -H 'Accept: application/json, text/event-stream' \
     -d '{"jsonrpc":"2.0","id":1,"method":"tools/call","params":{"name":"put_page","arguments":{
           "slug":"digests/grok-bot/2026-10-06","content":"---\ntype: note\n...","force":true,
           "request_id":"<REQUEST_ID>"}}}'
   ```

   The response is a server-sent `event: message` whose `data:` line holds the
   JSON-RPC result. `result.content[0].text` is the receipt:

   ```json
   {
     "request_id": "<REQUEST_ID>",
     "state": "committed",
     "retry_after_ms": null,
     "slug": "digests/grok-bot/2026-10-06",
     "revision": "<page-revision-uuid>",
     "status": "created_or_updated",
     "source_id": "default",
     "noop": false,
     "embedding_state": "queued",
     "daily_memory_affected_dates": ["2026-10-06"]
   }
   ```

3. The run succeeded only if `result.isError` is absent, `state` is
   `committed`, `request_id` equals the one sent, and `slug` equals the
   requested slug. Record `revision`. `noop: true` means the content was
   already identical. The receipt also carries `persistence` and
   `write_through`. On a database-only source, `write_through.written` is
   `false` and no Markdown file is created.

4. Optionally read the page back:

   ```json
   {"jsonrpc":"2.0","id":2,"method":"tools/call","params":{"name":"get_page",
     "arguments":{"slug":"digests/grok-bot/2026-10-06","include_content":true}}}
   ```

   The result's `revision` equals the receipt's revision.

### Failures the routine must handle

Tool errors arrive as HTTP 200 with `result.isError: true`. Their text is JSON
with `error` (the code) and `message`.

| Signal | Meaning | Routine action |
| --- | --- | --- |
| HTTP 401 `invalid_token` | Missing, wrong, or expired token | Mint a new token once, then retry the identical call |
| `/token` returns `invalid_client` | The client was revoked or deleted | Stop and report. Do not retry. |
| `permission_denied` | The slug is outside `digests/grok-bot/`, or the operation is not granted | Stop and report. Fix the slug. |
| `write_pending` | Accepted but not yet committed. `write_request.state` is `queued` or `running`, and `retry_after_ms` is set. | Wait `retry_after_ms`, then repeat the identical call with the same `request_id`, or call `get_write_request` with `{"request_id": ...}` |
| Transport failure, no response | Outcome unknown | Repeat the identical call with the same `request_id`. A committed write replays its original receipt. |
| `idempotency_conflict` | This `request_id` was already used with different arguments | A routine bug. Use a new UUID for new content. |
| `invalid_params` | `request_id` is not a UUID, or both `force` and `expected_revision` were sent | Fix the call |
| `storage_error`, `writer_busy`, `owner_unavailable`, `queue_capacity` | Host-side trouble | Check the request with `get_write_request`. While its `state` is `queued`, `running` or `recovering`, or the lookup returns `not_found` because nothing was accepted, retry later with the same `request_id`. A `failed` or `conflict` state is terminal: replaying that `request_id` returns the same failure. Report it, and after the host is fixed send the run again with a new `request_id`. |
| `page_not_found` from `get_page` | No digest exists for that date yet | Expected before the first write |

### Why `put_page` with `force`

- `capture` derives its default slug from the content hash, so each run would
  create a new page. With an explicit slug it is the same `put_page` write
  plus frontmatter stamping.
- Conditional writes (`get_page` first, then `put_page` with
  `expected_revision`) also work. They cost an extra round trip and fail with
  `revision_conflict` whenever anything else touched the page. The digest is
  regenerated whole and owned by one routine, so last-writer-wins is the
  intended result.

## Thin CLI form inside the Bot

When the Bot uses the installed launcher from the
[Grok Bot guide](grok-bot.md), the same write is:

```bash
/workspace/gbrain/bin/gbrain put digests/grok-bot/2026-10-06 --force --request-id "$REQUEST_ID" < digest.md
/workspace/gbrain/bin/gbrain get digests/grok-bot/2026-10-06
```

The launcher authenticates from its stored handoff. Do not pass `--json` to
`put`. The thin client forwards it to the server as a `json` tool argument.
Under the default `mcp.strict_params` mode, adding or removing it on a retry
changes the request intent, and the server answers `idempotency_conflict`.
Under `mcp.strict_params=reject`, every `put --json` fails with
`invalid_params` before the write is admitted. When retrying, repeat the exact
command. `gbrain call` is not available in the thin client.

## Verify locally

Run the steps above against a throwaway brain. Do not use the production
brain.

```bash
unset GBRAIN_HOME GBRAIN_DATABASE_URL DATABASE_URL GBRAIN_DIRECT_DATABASE_URL
dir=$(mktemp -d "${TMPDIR:-/tmp}/digest-check.XXXX") && GBRAIN_HOME=$(cd "$dir" && pwd -P) && export GBRAIN_HOME
[ -n "$GBRAIN_HOME" ] && gbrain init --pglite --no-embedding --non-interactive --db-only
# start serve --http --bind 127.0.0.1 and run gbrain mcp grant as above
```

Then check each of these:

- `tools/list` without `Authorization` returns HTTP 401 `invalid_token`.
- `tools/list` with the token lists no operation outside the grant's
  `allowedOperations`. Publish-gated `advisor` stays hidden unless enabled.
  Admin and unfenceable operations such as `purge_deleted_pages`,
  `submit_agent`, `sync_brain`, and `file_upload` are absent.
- Two runs for the same date commit two revisions of one page.
  `list_pages` with `slug_prefix: "digests/grok-bot/"` returns one slug.
- A retry with the same `request_id` and arguments returns the same revision.
- `put_page` to `notes/...` returns `permission_denied`.
- `get_page` returns the second run's content and revision.

`test/put-page-persistence.test.ts` pins the re-run rules for a fenced remote
client: forced re-runs converge on one page, a retry replays its receipt, and
a reused `request_id` is refused. `test/client-slug-fence.test.ts` and
`test/e2e/qm-provisioning.test.ts` cover the prefix fence.

## What exposing beyond this computer would take

> **Not done. Waiting for the owner's go-ahead.** Nothing below has been run. The
> verified setup listens only on `127.0.0.1`.

Grok Bot runs in xAI's cloud, so it needs a public HTTPS endpoint. The
supported path is Tailscale Funnel:

```bash
# 0. Stop the manually started loopback server first. expose installs its own
#    service on port 3131 and refuses with foreign_listener while anything listens there.

# 1. Publish serve --http as a user service on the machine's MagicDNS name (consent prompt).
gbrain mcp expose --funnel
gbrain mcp expose --status

# 2. Grant the routine against the public URL. Use a new client name: the
#    loopback client from "Host setup" still exists, and its handoff is bound
#    to the loopback URL. Revoke that loopback client once this one verifies.
gbrain mcp grant grok-bot-digest-public --harness grok-bot --profile memory-writer --source default \
  --bound-slug-prefixes digests/grok-bot/ \
  --url https://your-machine.your-tailnet.ts.net/mcp \
  --admin-token-file ~/.gbrain/serve/admin-token \
  --credentials-out /private/grok-bot-digest-public.json --json

# 3. Move the handoff file to the Bot's computer privately, then inside the Bot:
gbrain connect https://your-machine.your-tailnet.ts.net/mcp --harness grok-bot \
  --credentials-file /private/grok-bot-digest-public.json --install --root /workspace/gbrain
/workspace/gbrain/bin/gbrain mcp verify --client CLIENT_ID --harness grok-bot \
  --url https://your-machine.your-tailnet.ts.net/mcp --credentials-file /private/grok-bot-digest-public.json
```

To revoke the client or roll back the exposure:

```bash
# Preview, then apply with the revision the preview shows.
gbrain mcp admin revoke CLIENT_ID --url https://your-machine.your-tailnet.ts.net/mcp \
  --admin-token-file ~/.gbrain/serve/admin-token --json
gbrain mcp admin revoke CLIENT_ID --yes --if-version REVISION \
  --url https://your-machine.your-tailnet.ts.net/mcp --admin-token-file ~/.gbrain/serve/admin-token --json

# Remove the Funnel handler and the service. This does not revoke clients, so revoke first.
gbrain mcp expose --remove --yes
```

After revocation, `/token` returns `invalid_client` and existing access tokens
get HTTP 401. Both were verified on loopback.

Risks to weigh before saying go:

- **Public endpoint.** Funnel makes `/mcp`, `/token`, and `/admin` reachable
  from the internet. Bearer auth and grants are the only gate.
- **Reads are source-wide.** The fence limits writes to `digests/grok-bot/`,
  but a `--source default` grant can read the whole `default` source. A
  dedicated source confines reads too. Create it with
  `gbrain sources add grok-digests --path <empty dir> --no-federated --force`, then
  grant with `--source grok-digests --federated-read grok-digests`. On a
  loopback test brain that grant wrote the digest into `grok-digests` and
  could not see a `default` page through `get_page`, `search`, `query` or
  `list_pages`, or write into `default`; the `--source default` grant saw it
  through all four.
- **Shared Bot computer.** Grok documents one account-wide computer. Every
  Bot and routine on that account can use the handoff file and launcher.
- **Broad tool surface.** `memory-writer` for the `grok-bot` adapter
  exposes about 90 tools. Inside the prefix, these include `delete_page` and
  `revert_version`. The grant command has no flag for a narrower operation
  list.
- **No real Bot test.** No Grok Bot account has run this contract. The Bot's
  native routine scheduling, time zone, and skill activation remain
  unverified.
