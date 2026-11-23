### Added

- DAV-7417: the nightly launcher writes private `digests/agent-day/<date>/<role>` pages after a clean scheduled capture. Each page copies asks, shipped links, user action requests, and failures from captured sessions. The launcher refreshes previous and recovery days. The generator skips personal meeting content and calls no model. A digest failure leaves the capture exit code unchanged.
