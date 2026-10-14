# Grok Bot daily digest over HTTP MCP

A Grok Bot routine can write one digest page per day into your brain through
`gbrain serve --http`. This guide defines that write contract, shows how to
verify it on loopback, and shows how to publish only the endpoints the Bot
needs over Tailscale Funnel.

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
  `revision_conflict` whenever anything else touched the page. With a single
  routine the digest is regenerated whole, so last-writer-wins is the intended
  result. Several bots sharing one page must not use `force`: see the next
  section.

### Several bots on one page

When more than one bot writes the same day's digest, each bot owns one section
of `digests/grok-bot/YYYY-MM-DD` and changes only that section. A `force`
write would replace the other bots' sections, so the shared page uses
conditional writes instead.

Each bot uses a fixed, unique `BOT` name (lowercase, letters, digits and
hyphens). Its section sits between two marker lines:

```markdown
<!-- grok-digest:BOT:start -->
## BOT

- Decided: ship the acme-example pilot.
<!-- grok-digest:BOT:end -->
```

The page ends with `<!-- grok-digest:end -->`, and new sections go directly
above it:

```markdown
---
type: note
title: Grok Bot digest 2026-10-06
digest_date: 2026-10-06
---

# Grok Bot digest 2026-10-06

<!-- grok-digest:research-bot:start -->
## research-bot

- alice-example confirmed the review slot.
<!-- grok-digest:research-bot:end -->

<!-- grok-digest:end -->
```

Each run:

1. Read the page with `get_page` and `include_content: true`. Keep its
   `revision` and `content`.
2. If it returns `page_not_found`, create the page with `put_page`: the
   frontmatter, the title, this bot's section and the end marker. Send no
   `force` and no `expected_revision`, so the call only creates. If another
   bot created the page first, the call fails with `revision_required` or
   `revision_conflict`. Go back to step 1.
3. If the page exists, build the new content from the `content` you read:
   - if the page predates this protocol and has no terminal
     `<!-- grok-digest:end -->` marker, preserve all existing content and
     append a newline followed by that marker on its own line first;
   - when this bot's markers are present, replace the text from its start
     marker to its end marker inclusive with the new section;
   - otherwise insert the new section and a blank line directly above
     `<!-- grok-digest:end -->` (including the marker just appended).

   Leave every other line unchanged. Send it with `put_page`, no `force`, and
   `expected_revision` set to the revision from step 1. Avoid `edit_page`
   here: on a brain where any write worker lacks its handler, the write fails
   with `unsupported_mutation_protocol` (observed 2026-10-12), while
   `put_page` is handled by every worker version.
4. On `revision_conflict`, another bot wrote in between. Go back to step 1
   with a new `request_id`; stop after 5 attempts and report.
5. `write_pending` and transport failures are handled as in the table above:
   repeat the identical call with the same `request_id`.

Never touch another bot's markers or text. Before switching an existing
single-bot digest to this shared protocol, stop that bot's `force` writes
and switch every writer to conditional writes. Running the bots a few
minutes apart keeps conflicts rare, but correctness does not depend on
the spacing.

## Thin CLI form inside the Bot

When the Bot uses the installed launcher from the
[Grok Bot guide](grok-bot.md), the **single-bot-only** write is:

```bash
/workspace/gbrain/bin/gbrain put digests/grok-bot/2026-10-06 --force --request-id "$REQUEST_ID" < digest.md
/workspace/gbrain/bin/gbrain get digests/grok-bot/2026-10-06
```

For a shared page, first read the content and revision:

```bash
/workspace/gbrain/bin/gbrain get digests/grok-bot/2026-10-06 --include-content --json
```

Build `merged.md` using the [shared-page protocol](#several-bots-on-one-page),
preserving all other content, and set `EXPECTED_REVISION` to the revision
returned by that read. Submit the complete merged Markdown conditionally:

```bash
REQUEST_ID=$(uuidgen | tr '[:upper:]' '[:lower:]')
/workspace/gbrain/bin/gbrain put digests/grok-bot/2026-10-06 \
  --expected-revision "$EXPECTED_REVISION" --request-id "$REQUEST_ID" < merged.md
```

If the read returned `page_not_found`, create the shared page with no
`--force` and no `--expected-revision`:

```bash
REQUEST_ID=$(uuidgen | tr '[:upper:]' '[:lower:]')
/workspace/gbrain/bin/gbrain put digests/grok-bot/2026-10-06 --request-id "$REQUEST_ID" < merged.md
```

On `revision_conflict` or a concurrent-create failure, reread and merge again
with a new request ID; for pending or transport retries reuse the same
request ID, revision and content.

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
`test/qm-provisioning.test.ts` cover the prefix fence. The latter is the
ungated PGLite provisioning/HTTP suite moved from the E2E directory into
the unit lane; its over-the-wire fence coverage is unchanged.

## Publish the endpoint over Tailscale Funnel

Grok Bot runs in the vendor's cloud, so it needs a public HTTPS endpoint.
Grok rejects `localhost` and private addresses for custom MCP servers and
suggests a tunnel
([Custom MCP Server Tunneling](https://docs.x.ai/grok/connectors/custom-mcp-tunneling)).
Its private-network options are an Enterprise-only Team Setup script or
routing the Bot's traffic through a desktop that must stay online
([Connect to private networks](https://docs.x.ai/grok-bot/private-networks)),
so neither suits an unattended daily routine. Tailscale Funnel gives the
brain host a stable `https://<machine>.<tailnet>.ts.net` name with a
Tailscale-managed certificate and no inbound port on your router.

`gbrain mcp expose --funnel` publishes the whole server at `/`, including
`/admin`. The steps below publish only the four paths the digest client
uses and keep the server on loopback.

### 1. Enable HTTPS and Funnel for the tailnet

Before any `funnel` command, inspect the existing configuration:

```bash
tailscale serve status --json
```

If the command fails or its output cannot be inspected, stop. Check
`:443` handlers in `Web` and any `Foreground` sessions. If `/mcp`, `/token`,
`/.well-known/oauth-authorization-server` or
`/.well-known/oauth-protected-resource` is already mounted, stop rather
than overwrite it; preserve that service and choose a different node.
Also stop if `:443` has a root `/` handler or raw TCP forwarding, since
this guide cannot then guarantee its unpublished paths stay private.
Funnel enables public access for the whole port, so do not proceed if an
unrelated handler on `:443` is meant to remain tailnet-only.

Only after this inspection, enable the features on a free `/mcp` mount:

```bash
tailscale funnel --bg --set-path=/mcp http://127.0.0.1:3131/mcp
```

On a tailnet without these features, the command prints
`https://login.tailscale.com/f/funnel?node=...` and waits. Open that URL as a
tailnet admin. It turns on HTTPS certificates and adds a Funnel `nodeAttrs`
entry for `autogroup:member` to the policy file. Narrow that target in the
policy file if other members should not run Funnel. Re-run the command
afterwards. `tailscale cert <machine>.<tailnet>.ts.net` fails with
`your Tailscale account does not support getting TLS certs` until HTTPS is on.

### 2. Grant the routine before starting the server

Before starting `gbrain serve`, create a dedicated database-only source so
the grant can read only its own digests. On PGLite, a running server holds
the single-writer lock and a tokenless local grant returns
`pglite_live_serve`. If the server is already running, stop it (and prevent
its supervisor from restarting it) for this provisioning step, then
restart it with the configuration in step 3.

```bash
unset GBRAIN_ADMIN_BOOTSTRAP_TOKEN
gbrain sources add grok-digests --federated
gbrain mcp grant grok-bot-digest-public --harness grok-bot --profile memory-writer \
  --source grok-digests --federated-read grok-digests \
  --bound-slug-prefixes digests/grok-bot/ \
  --url https://your-machine.your-tailnet.ts.net/mcp \
  --credentials-out /absolute/private/grok-bot-digest-public.json --json
```

Run this on the brain host without `--admin-token-file` and with
`GBRAIN_ADMIN_BOOTSTRAP_TOKEN` unset. The grant is then written through the
local database connection, and the handoff is bound to the public URL.
With an admin credential, `gbrain mcp grant` instead sends the grant to
`/admin/api/grants` on the `--url` host, which Funnel does not publish.

### 3. Run the server on loopback

Run the command below under a supervisor configured to restart after
crashes. A macOS launchd **LaunchAgent runs only while the user is logged
in**; an always-logged-in Mac with auto-login can use that arrangement,
but the agent stops at logout. Running across logout requires a
system-level **LaunchDaemon**, configured to run as the brain owner with
the correct `GBRAIN_HOME`, executable paths and private credential access.
The standard GBrain user-service installer creates a LaunchAgent, not a
LaunchDaemon.

On Linux, use a systemd user unit with `Restart=always` and enable
lingering (`sudo loginctl enable-linger "$USER"`) to keep the user manager
running after logout. Without lingering the user service stops at logout.
Either arrangement still requires the host to remain awake and online.
The foreground command alone does not install a service:

```bash
umask 077
openssl rand -hex 32 > /absolute/private/admin-token
GBRAIN_ADMIN_BOOTSTRAP_TOKEN=$(cat /absolute/private/admin-token) \
  gbrain serve --http --bind 127.0.0.1 --port 3131 \
  --public-url https://your-machine.your-tailnet.ts.net --suppress-bootstrap-token
```

`--public-url` makes the OAuth issuer and the protected-resource metadata
name the public host. On a Postgres brain behind a session-mode pooler, each
resident process holds its own sessions. Set `GBRAIN_POOL_SIZE=2` and
`GBRAIN_DISABLE_DIRECT_POOL=1` in the service environment when the pooler's
client limit is shared with imports or embedding runs. The server then holds
at most two sessions.

### 4. Publish only the client paths

Re-read `tailscale serve status --json` immediately before the loop. Stop
if the read fails, a selected path now belongs to another service, or the
root/TCP/private-handler conflicts from step 1 appeared. Each selected
path must be absent or still be the handler this guide created; do not
take over another service even if it uses the same local port.

```bash
for p in /mcp /token /.well-known/oauth-authorization-server /.well-known/oauth-protected-resource; do
  tailscale funnel --bg --https=443 --set-path="$p" "http://127.0.0.1:3131$p"
done
tailscale funnel status
```

The thin client discovers the issuer at
`/.well-known/oauth-authorization-server`, mints tokens at `/token`, and calls
`/mcp`. MCP clients also read `/.well-known/oauth-protected-resource/mcp`,
which the last handler covers. Every other path, including `/admin`,
`/authorize`, `/register`, `/revoke`, `/ingest`, `/health` and `/metrics`,
gets Funnel's `404 page not found`. These paths stay reachable on
`http://127.0.0.1:3131` for the host owner.

### 5. Verify from outside the tailnet

On the brain host, MagicDNS can answer with the tailnet address. Pin the
public Funnel address so the checks take the internet path:

```bash
host=your-machine.your-tailnet.ts.net
ip=$(dig +short @1.1.1.1 "$host" A | head -1)
curl -s -o /dev/null -w '%{http_code}\n' --resolve "$host:443:$ip" -X POST "https://$host/mcp" \
  -H 'Content-Type: application/json' -H 'Accept: application/json, text/event-stream' \
  -d '{"jsonrpc":"2.0","id":1,"method":"tools/list"}'                              # 401
curl -s -o /dev/null -w '%{http_code}\n' --resolve "$host:443:$ip" "https://$host/admin"   # 404
```

Then mint a token at `https://$host/token` with the handoff's `client_id` and
`client_secret` and run the [write contract](#each-run) against
`https://$host/mcp`. A correct grant gives these results:

- `put_page` on `digests/grok-bot/<date>` commits with `source_id: grok-digests`.
- `put_page` on `notes/...` returns `permission_denied`.
- `put_page` with `source_id: default` returns `permission_denied` with the
  message that the source is outside the current write grant.
- `get_page` on a `default` page returns `page_not_found`. With
  `source_id: default` it returns `permission_denied`.
- `list_pages` lists only `grok-digests` pages.

### 6. Connect the Bot

Move the handoff file to the Bot's computer privately, then inside the Bot:

```bash
gbrain connect https://your-machine.your-tailnet.ts.net/mcp --harness grok-bot \
  --credentials-file /private/grok-bot-digest-public.json --install --root /workspace/gbrain
/workspace/gbrain/bin/gbrain mcp verify --client CLIENT_ID --harness grok-bot \
  --url https://your-machine.your-tailnet.ts.net/mcp --credentials-file /private/grok-bot-digest-public.json
```

### Revoke or roll back

The admin API is on loopback only, so run these on the brain host:

```bash
# Preview, then apply with the revision the preview shows.
gbrain mcp admin revoke CLIENT_ID --url http://127.0.0.1:3131/mcp \
  --admin-token-file /absolute/private/admin-token --json
gbrain mcp admin revoke CLIENT_ID --yes --if-version REVISION \
  --url http://127.0.0.1:3131/mcp --admin-token-file /absolute/private/admin-token --json

# Remove only the four digest mounts. This does not revoke clients, so revoke first.
for p in /mcp /token /.well-known/oauth-authorization-server /.well-known/oauth-protected-resource; do
  tailscale funnel --https=443 --set-path="$p" off
done
```

Keep `--set-path` on every removal: omitting it removes all handlers on
`:443`, including unrelated services. Do not use `tailscale funnel reset`
or `tailscale serve reset` for this rollback.

After revocation, `/token` returns `invalid_client` and existing access tokens
get HTTP 401. Both were verified on loopback.

### Reporting back to you

Grok automations accept inbound webhooks: an external service can start an
automation with a signed POST
([Webhook Triggers](https://docs.x.ai/grok/automations/webhooks)). Grok Bot
routines run on a schedule or start from Slack or GitHub events
([Skills and routines](https://docs.x.ai/grok-bot/skills-routines-and-automations)).
Neither documents an outbound webhook that could deliver a Bot's results to
the brain, so `put_page` remains the write path. The routine reports to you in
its own conversation, and each run's receipt (`revision`, `request_id`)
identifies the committed page.

### Risks

- **Public endpoint.** `/mcp` and `/token` are reachable from the internet.
  Bearer auth and grants are the only gate. `gbrain mcp expose --funnel`
  would add `/admin` and the other server paths.
- **Reads follow the grant's read list.** The fence limits writes to
  `digests/grok-bot/`. A `--source default` grant can still read the whole
  `default` source. The `grok-digests` grant in step 2 confines reads too:
  the grant's read list, not the source's federation, is what confines the
  Bot. The source is federated so your own unqualified searches still
  include the digests.
- **Shared Bot computer.** Grok documents one account-wide computer. Every
  Bot and routine on that account can use the handoff file and launcher.
- **Broad tool surface.** `memory-writer` for the `grok-bot` adapter
  exposes about 90 tools. Inside the prefix, these include `delete_page` and
  `revert_version`. The grant command has no flag for a narrower operation
  list.
- **No real Bot test.** No Grok Bot account has run this contract. The Bot's
  native routine scheduling, time zone, and skill activation remain
  unverified.
