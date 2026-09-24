# DAV-6220 — graph usefulness progress (COS review)

This directory holds **immutable receipts** for bounded graph-reconnection work on the post-import corpus. COS and Dave review these artifacts; agents must not quarantine, purge, or bulk-rewrite without separate approval.

## Commands (gbrain)

**Say to your agent:** *"Measure how connected my brain graph is after import"* — *"Run the DAV-6220 retrieval proof pack and save the receipt under docs/progress/DAV-6220/"*

`gbrain graph <slug>` still runs **graph traversal** (`traverse_graph`). DAV-6220 subcommands are explicit: `measure`, `relations`, `retrieval-proof`.

```bash
# Read-only baseline (pages, links, zero-degree count, junk-slug samples)
gbrain graph measure --json

# Verify a sealed relation manifest (no writes)
gbrain graph relations verify /path/to/relation-manifest.json --json

# Dry-run by default; bounded apply requires --apply --yes
gbrain graph relations apply /path/to/relation-manifest.json \
  --receipt-out docs/progress/DAV-6220/mutation-receipt-<id>.json

# Ten-question (or smaller) retrieval proof — read-only
gbrain graph retrieval-proof run /path/to/retrieval-proof.json \
  --out docs/progress/DAV-6220/retrieval-proof-live/independent-verification.json
```

## Manifest contracts

- **Relation manifest** (`manifest_version: 1`): each row carries pre-sealed `guards` (`exact_endpoint_match`, `source_relation_current`, `no_incident_edge`, `readwise_clear`). Every guard must be a JSON boolean. Apply re-checks them and writes a link only when each one is literal `true`. The no-edge recheck and the insert share one transaction that locks the endpoint pages. A concurrent edge is left as it is and is not counted as applied.
- **Retrieval proof** (`proof_version: 2`): scored question list; output includes `checks.scores` and `checks.cited_readwise_pages` (the number of Readwise hits, not the number of questions that cited any; must stay `0` for Readwise-cleared corpora). Each question's `top_k` must be a positive integer. Slug and page expectation fields must be arrays. Source-qualified page expectations must name an active source. `passed` is false when the before/after graph fingerprint differs, including a content, chunk, or embedding rewrite that leaves page and link identities in place, and `checks.production_mutations` is then non-zero. `measure` and `retrieval-proof` reject an unknown `--source` instead of scoring an empty corpus.

## Mutation receipt fields

Receipts written by `gbrain graph relations apply` include:

- `manifest_sha256` — binds to the exact manifest bytes
- `before` / `after` — `GraphFingerprint` (page/link counts + `sha256`)
- `outcomes[]` — per-row `applied` | `dry_run` | `skipped_*`
- `counts.planned` / `applied` / `skipped`

Store production receipts here after COS review. Example fixture manifests live in `test/fixtures/graph-usefulness/`.
