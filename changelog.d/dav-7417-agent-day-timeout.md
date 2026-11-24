### Fixed

- DAV-7417: Agent day writes use a 360-second timeout and retry one pending or timed-out write with the same request identifier.
- Agent day digests read local primary and flat OMP sessions in memory, redact secrets, and retain meeting exclusions.
- Primary folder identifiers map to digest roles. Local and captured sessions merge by session identifier.
- Dry runs print counts only. The capture scan stays unchanged; raw primary transcripts never enter conversation pages through this generator.
- Local OMP reads require the nightly seat opt-in and honor its root override. The launcher exports both settings to the digest generator.
