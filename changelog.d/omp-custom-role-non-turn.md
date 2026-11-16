### Fixed

- Treat omp `custom` role messages (hidden harness context such as `eval-state-context`) as non-turn lines. One such line made the omp seat scan unclean, so the nightly daily-memory run held the omp watermark.
