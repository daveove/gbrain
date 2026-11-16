### Fixed

- The conversation secret audit scans frontmatter keys on their own, so a credential used as a key is found when its value is null, an empty object or an empty list.
- A slug-bound stale extraction on a brain without managed persistence keeps its whole time budget. It no longer stops at half the budget when mention work is due, so the daily-memory writer can tell a spent budget from a finished sweep.
