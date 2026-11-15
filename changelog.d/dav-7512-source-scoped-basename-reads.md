### Fixed

- Bare link-name lookups, attendance lookups and the source slug index now read inside the source's row-level security scope. With scope binding on, a non-owner role no longer gets an empty answer that stops links from resolving. A new engine method, `executeRawInSource`, carries these reads.
