# Evidence context delivery

Issue: DAV-6842. The implementation belongs to GBrain; Cockpit consumes the same package with its existing source-record store.

Touch: `packages/evidence-context`, the optional SQL host adapter, their tests and contract documentation. Cockpit integration touches queue assembly, situation evidence, native context reads and package delivery. Existing communications records keep bounded previews; context reads existing canonical source content without copying it into normalized records.

Leave: engine factories, connection pools, credentials, installed runtime, import schedules, canonical page writes, inbox ranking and existing action approvals. Stock GBrain engines do not contain Cockpit's source_records table. The shared package accepts an existing host reader; the SQL adapter is available only for hosts that already own that intake table. No new operation is registered on stock engines. No schema migration or duplicate source store is needed.

Done means every input has a current evidence packet or an explicit unavailable disposition, account collisions cannot join, source changes invalidate prepared context, continuation is scoped, Node installation has no lifecycle hooks, and both repositories pass their applicable checks and independent reviews. Deployment remains separate from code delivery.

Poteto checkpoints: two independent explorers inspected GBrain and Cockpit, followed by a distinct synthesis. Two designers compared current reads and persisted metadata. A distinct judge scored them 93 and 82 out of 100. Current reads are the base; dependency manifests and coverage are retained from the persisted design. Persisted pages are deferred because they require invalidation and reauthorization without recovering discarded source bodies.

Blocking checks are source identity, authorization, body completeness and package installation. GBrain assembly and Cockpit integration share a versioned contract; implementation proceeds in that dependency order. Isolated worktrees preserve existing changes. Source reads use existing injected connections. Tests use synthetic records and isolated databases.
