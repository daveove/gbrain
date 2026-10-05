# Source evidence and context

This package assembles current records from GBrain's existing `source_records` boundary. A host supplies its existing reader and authorization policy. The package has no database connection, provider dependency, install hook or write path.

Every input receives a packet, including missing, denied and unsupported records. Packets contain exact references, revisions, content capability, bounded conversation evidence and coverage. Source text is untrusted evidence. Account and thread identity must match before conversation expansion. Unknown accounts allow authorized exact reads only.

`queryExhausted` describes the bounded stored-record query, never complete provider history. Provider freshness remains unknown without a producer receipt. Callers should display these gaps and reassemble before preparing work. Use `revision` to invalidate prepared context when dependencies or coverage change.

Only explicitly business-tagged records are included. The checked host must authorize every record; page-source grants do not grant access to raw account records. Missing or conflicting identity never authorizes a join. Complete body status requires an explicit producer claim. Old previews stay partial.

Conversation candidates use the existing store's millisecond keyset ordering. Cursors bind the account, network, thread, source and contract. Reads are current reads, not an immutable database snapshot. Resume each returned continuation until the query is exhausted; do not infer completeness from a display limit.

Run `npm test` from this directory. Publish this directory as a package-only commit in the owned repository, and pin consumers to that immutable commit. Do not install the root GBrain package in a Node application.

After committing reviewed changes, run `bash scripts/package-evidence-context.sh` from the repository to produce the package commit. `--push` publishes that commit to the package branch after checking the owned destination. There are no install scripts, binaries or engine dependencies in the package root. Ordinary `npm ci` verifies the pinned dependency from its lockfile.
