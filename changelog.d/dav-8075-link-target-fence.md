### Security

- Prevent cross-source links into sources with `federated=false`, even when `link_resolution.cross_source=true`. Keep same-source links and explicit outbound access unchanged. Exclude blocked target text from wanted pages, reconciliation results, mention edges, and meeting timelines. Hide old forbidden edges from link and backlink reads.
- Exclude isolated attendees without blocking a meeting's other links. Remove excluded references from the context stored on allowed edges.
