# Performance contract

This contract separates deterministic structural checks from runtime Electron measurements. The Node model is a regression gate; it is not evidence of renderer, GPU, or private memory.

## Scale fixture

1. Generate outside the repository: `node scripts/perf/generate-performance-vault.mjs --output /tmp/notebook-navigator-performance-vault`.
2. Defaults: 22,844 Markdown files, 1,132 PNG files, 128 folders, fixed seed 1337.
3. Never point the generator at an existing vault. It refuses to overwrite any existing path.

## Deterministic gate

Run `npm run perf:model`. Compare its JSON with `docs/performance/baseline-3.3.3.json` and the budgets below.

1. Mounted rows, including overscan and manual sort: at most 250.
2. Concurrent decoded source pixels per plugin runtime: at most 100,000,000.
3. Visible thumbnail candidates admitted together: at most 64.
4. Exactly one indexing/content runtime per plugin instance.
5. Closing the final view or disabling the plugin drains active and queued work within 250 ms.

## In-Obsidian capture sequence

Use a copied fixture vault. Enable benchmark mode with vault-scoped local storage key `notebook-navigator-benchmark-mode-enabled = true`, restart Obsidian, and capture each state separately:

1. Plugin disabled.
2. Plugin enabled with all Navigator views closed.
3. Navigator opened until the first usable list paint.
4. Indexing idle.
5. Manual sort opened at the vault root.
6. Five complete scroll passes.
7. Navigator closed.
8. Plugin disabled.

For every state record wall time, phase p50/p95/max, long tasks, mounted rows, provider and Blob queue high-water marks, live object URLs, active decoded pixels, active PDF renders, runtime instance count, JS heap, Electron renderer private bytes, GPU process private bytes, and total application private bytes. IndexedDB size on disk is recorded separately and must not be called runtime memory.

## Runtime budgets

1. First usable list paint: at most 2 seconds on the scale fixture.
2. Manual-sort open: at most 250 ms.
3. No main-thread task above 100 ms; p95 below 50 ms during startup/indexing.
4. p95 frame time at most 16.7 ms while scrolling.
5. Manual-sort delta at most 300 MiB private memory and 150 MiB JS heap.
6. No monotonic heap/private-memory growth after five scroll passes.
7. Repeated CPU captures vary by at most 10%; use at least five runs and report the median.
8. Encoded feature-image Blob LRU stays at or below 128 MiB desktop and 32 MiB mobile; decoded/native image memory is reported separately.

## Baseline limitations

The checked-in 3.3.3 baseline contains deterministic structural facts and the user-observed approximately 17 GiB application-memory symptom. A controlled Electron process breakdown was not available when the baseline was created; missing runtime measurements remain `null` rather than being fabricated. They must be filled by the capture sequence before claiming measured end-to-end speedup.
