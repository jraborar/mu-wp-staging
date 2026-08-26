# WP Multisite / Drupal / Next.js Integration Design

Status: Draft — deep technical wireframe for integrating multisite normalization and VRT-friendly staging into mu-wp-staging, mu-vrt, and mu-deployment.

Goal
----
Provide a safe, configurable workflow to support WordPress Multisite (WPMS), Drupal, and Next.js sites on the Pantheon + MU tooling stack, ensuring accurate Visual Regression Testing (VRT) baselines and recoverability while minimizing operator friction. Target: readiness for phased rollout before October.

Assumptions
-----------
- Existing staging flow: `lib/staging.ts` creates a `multidev`, runs updates, and optionally calls `lib/vrt.ts` `startBaseline()`/`finishCompare()`.
- `sites` registry (`lib/sites.ts`) contains `platform` and `vrt_paths` metadata.
- mu-vrt consumes simple manifests like `pantheon/mu/mu-vrt-local/sites/<site>/paths.js`.
- Access to `terminus`, `wp` and `drush` via the `terminus` CLI wrapper exists in the staging host.
- Deploy cadence/anchor semantics must remain compatible (multidev-only sites handled specially).

Executive Summary
-----------------
1. Detect platform at staging start (WPMS / Drupal / Next.js).
2. Create safe snapshot(s) (DB + optional files) on multidev immediately after creation.
3. Perform normalization: replace live host/URL references in DB and config with the multidev host so baseline/candidate captures are consistent.
4. Capture VRT baseline using mu-vrt against the normalized multidev.
5. Apply updates and capture candidate; compare.
6. Keep normalization in place for client review (recommended). Provide documented revert path using the snapshot.

Architecture Overview
---------------------
- `lib/staging.ts` orchestrates staging lifecycle. Add a hook `multidevNormalize()` invoked after multidev creation and before `startBaseline()`.
- Normalization implementation varies by platform:
  - WPMS: `terminus wp <site>.dev -- search-replace ...` per subsite
  - Drupal: `terminus drush` SQL operations and config updates
  - Next.js: environment variable + build-time config adjustments
- `lib/vrt.ts` remains the VRT client; ensure mu-vrt receives correct `site` key and `base` host (multidev host).
- Add optional per-site flags in `sites` registry: `auto_multisite_replace`, `backup_before_replace`, `vrt_capture_mode`.

Detection & Metadata
--------------------
- Use `lib/sites.ts` `platform` field: `wp-single`, `wp-multisite`, `drupal`, `nextjs` (add `nextjs` enum). If unknown, fallback to dynamic detection via `terminus`:
  - WPMS detection: `terminus wp <site>.dev -- site list --format=json` — if length>1 → multisite.
  - Drupal detection: `terminus drush` or read `composer.json` clues or Pantheon upstream.
  - Next.js detection: repository/buildpack indicators or explicit registry flag.
- New optional site fields (db schema changes):
  - `auto_multisite_replace: boolean` default false
  - `backup_before_replace: boolean` default true
  - `vrt_capture_mode: 'multidev-normalized' | 'raw'` default `multidev-normalized`
  - `multisite_config?: JSON` (advanced mapping of subsites/custom domains)

Detailed Normalization Flow — WordPress Multisite
-------------------------------------------------
When `platform === 'wp-multisite'` and `auto_multisite_replace` is true (or operator opts-in):

1. Snapshot DB & files
   - Recommended: `terminus env:backup:create <site>.<env> --note='pre-normalize-<multidev>'` and record backup id.
   - Alternative lightweight: `terminus wp <site>.dev -- db export /tmp/pre-replace-<multidev>.sql`
   - Save snapshot id in staging_history row (for revert).

2. Enumerate subsites
   - `terminus wp <site>.dev -- site list --format=json`
   - Response contains `domain`, `path`, `blog_id` for each subsite.

3. Compute replacements
   - Live base(s): Use `registry.site.site_name` or `referenceBase` from mu-vrt manifest if present, or derive from `site list` rows (domain+path)
   - Target base: `multidevUrl(machine, multidev)` (see `lib/vrt.ts`) — for path-based subsites append the subsite path; for subdomain maps, map to multidev host and preserve subdomain mapping where possible (complex)

4. Dry-run replacements (optional but recommended for large networks)
   - `terminus wp <site>.dev -- search-replace '<live>' '<target>' --url='<subsite>' --skip-columns=guid --precise --recurse-objects --report` (if supported) or run with `--dry-run` if available
   - Collect counts and diff sample values to audit.

5. Apply replacements
   - Same command without dry-run flag.
   - For each subsite run search-replace scoped to that subsite `--url` flag so serialized values are handled properly.

6. Post-replace housekeeping
   - Clear caches: `terminus wp <site>.dev -- cache flush` or relevant plugin cache commands.
   - Fix `upload_path` / media URLs if custom and not host-relative.

7. Proceed with `startBaseline()` once normalized.

Why per-subsite search-replace? WPMS stores site-specific options in per-site option tables, and some themes/plugins embed absolute URLs per subsite. Running `search-replace` with `--url` ensures the correct table scope and serialized-safe replacement.

Implementation notes & pseudocode (for `lib/staging.ts`)
------------------------------------------------------
Pseudocode (TypeScript-style):

async function multidevNormalizeMultisite(job) {
  const site = await getSite(job.site)
  if (site.platform !== 'wp-multisite') return
  if (!site.auto_multisite_replace) return

  // 1. snapshot
  const backupId = await createBackup(job.site, job.multidev)
  await recordBackup(job.id, backupId)

  // 2. enumerate subsites
  const subsites = JSON.parse(await run(`terminus wp ${env(job)} -- site list --format=json 2>&1`))

  // 3. for each subsite: compute replacement and run wp search-replace
  const machine = site.machine_name
  const targetBase = multidevUrl(machine, job.multidev)
  for (const s of subsites) {
    const liveBase = determineLiveBase(s, site)
    const urlFlag = s.path === '/' ? targetBase : `${targetBase.replace(/\/$/, '')}${s.path}`
    // dry-run first if enabled
    if (DRY_RUN) {
      await run(`terminus wp ${env(job)} -- search-replace '${liveBase}' '${urlFlag}' --url='${s.domain}${s.path}' --skip-columns=guid --precise --recurse-objects --dry-run`)
    }
    await run(`terminus wp ${env(job)} -- search-replace '${liveBase}' '${urlFlag}' --url='${s.domain}${s.path}' --skip-columns=guid --precise --recurse-objects`)
  }
}

Where `env(job)` returns the `<site>.dev` string, and `run()` is `lib/terminus` wrapper.

Edge cases & complexity
-----------------------
- Subdomains mapped to custom domains: replacement may require mapping multiple hostnames → single multidev host, or creating local host aliases. For many custom-domain multisites this is complex and requires per-site mapping data in registry.
- Serialized option values: `wp search-replace` handles serialized values if `--recurse-objects` and `--precise` are used, but test on small subset first.
- Plugins/themes that rewrite URLs on the fly (e.g., domain mapping plugins) may require special handling.
- If `upload_path` contains absolute paths or S3-like URLs, additional logic is needed to remap or rewrite assets.

Rollback
--------
- Restore DB from backup id via `terminus backup:restore <site>.<env> <backupId>` or `terminus wp <site>.dev -- db import /tmp/pre-replace.sql`.
- Store backup metadata in `staging_history` so UI/ops can revert from console.

VRT Integration
---------------
- mu-vrt receives `site` key (registry key), `multidev` and `base` URL.
- Ensure `lib/vrt.ts` `startBaseline()` is called after normalization so captured baseline reflects normalized host and paths.
- mu-vrt manifest (`paths.js`) is fine for multisite if entries reference subsite paths. Options:
  - Allow `paths.js` pages to include host (full URL) when per-subsite hosts are needed.
  - Extend `pantheon/mu/mu-vrt-local/sites/*/paths.js` format to optionally include `sitePath` or `subsite` metadata.
- Increase `BASELINE_MS_PER_PATH` for large multisite path counts; allow per-site override via site registry `vrt_timeout_per_path_ms`.

Drupal Normalization
--------------------
- Drupal often stores base URLs in `system.site` config or in contrib module configs. Use `drush` and `terminus drush`:
  - Snapshot: `terminus env:backup:create <site>.<env>`
  - Replace: `terminus drush <site>.dev -- sql-query "UPDATE key_value SET value = REPLACE(value, 'https://live.example', 'https://<multidev>-<machine>.pantheonsite.io') WHERE collection IN ('system.site', 'some.module')"`
- For config-driven replacements, the `config:set` or config export/import flow may be safer.
- For complex serializations (rare), script targeted updates and run config rebuild.
- Integrate `multidevNormalizeDrupal()` similarly before VRT baseline.

Next.js Normalization
---------------------
- Next.js apps typically rely on environment variables and build-time configuration.
- For staging multidev, ensure runtime env and API endpoints point to multidev or mocks. Options:
  - Inject `NEXT_PUBLIC_BASE_URL` and `NEXT_PUBLIC_API_URL` at runtime build step.
  - For SSG: trigger a rebuild on the multidev after normalization if needed.
- Hook: `multidevNormalizeNextjs()` runs after multidev creation; update env vars and trigger `npm run build` (if the multidev supports it) or set runtime overrides.
- VRT: capture final rendered pages at `multidevUrl()`.

UI & API Changes
----------------
- Add site-level toggles in the app UI (`app/page.tsx`) for the new site flags. Use `lib/sites.ts` `updateSite()` to persist.
- Add endpoints for `dry-run` replace and `revert` operations used by operators.

Testing Strategy
----------------
- Unit tests: mock `run()` and `terminus` outputs; test command generation and parsing.
- Integration tests (local): use `pantheon/mu/mu-vrt-local` copies `niacc` and `tstc-multisite`:
  1. Create a local multidev (or a test site) and run normalization in dry-run.
  2. Verify counts of replacements and inspect sample options.
  3. Run `startBaseline()` and `finishCompare()`, ensuring mu-vrt captures both baseline and candidate.
- Canary tests: pick one or two low-risk multisites from production to run with operator supervision.

Monitoring & Metrics
--------------------
- Metrics to collect per-run:
  - number_of_replacements
  - time_taken_for_replacements
  - baseline_capture_time
  - compare_time
  - vrt_flagged_count
  - backup_size + backup_id
- Surface in staging history UI and Slack notifications.

Rollout Plan & Timeline (target: before Oct)
--------------------------------------------
Phase 0 (1 week):
- Finalize doc and config schema
- Add site registry flags and UI fields (read/write)
Phase 1 (2–3 weeks):
- Implement `multidevNormalizeMultisite()` with DB backup + dry-run + apply
- Add unit tests + integration test harness (local mu-vrt-local)
- Test with `niacc` and `tstc-multisite` locally
Phase 2 (2 weeks):
- Add Drupal normalization support
- Add Next.js normalization support (runtime config)
Phase 3 (2 weeks):
- Hardening: `spire-network` dry-runs, stress tests (increase mu-vrt budgets), UI revert buttons
- Documentation + on-call runbook
Phase 4 (1 week):
- Canary production runs, iterate on edge cases
Total: 6–8 weeks depending on availability and Pantheon access — fits before October if started immediately.

Security & Safety
-----------------
- Only run normalization when `auto_multisite_replace` is enabled.
- Require backups and record backup ids in `staging_history`.
- Protect endpoints that trigger apply (non-dry-run) behind auth and audit logs.
- For large networks require manual approval toggle in UI.

Appendix: Useful Commands
-------------------------
- WP subsites: `terminus wp <site>.dev -- site list --format=json`
- Backup: `terminus env:backup:create <site>.<env> --note='pre-normalize-<multidev>'`
- WP dry-run replace (example):
  `terminus wp <site>.dev -- search-replace 'https://live.example' 'https://mu-260821-machine.pantheonsite.io' --url='sub.example' --skip-columns=guid --precise --recurse-objects --dry-run`
- WP apply replace (example):
  `terminus wp <site>.dev -- search-replace 'https://live.example' 'https://mu-260821-machine.pantheonsite.io' --url='sub.example' --skip-columns=guid --precise --recurse-objects`
- Drush SQL update example:
  `terminus drush <site>.dev -- sql-query "UPDATE key_value SET value = REPLACE(value, 'https://live.example', 'https://mu-260821-machine.pantheonsite.io') WHERE collection='system.site'"`

Appendix: Suggested Code Changes (files)
----------------------------------------
- `lib/staging.ts`: add `await multidevNormalize(job)` before `startBaseline()`
- `lib/sites.ts`: add fields `auto_multisite_replace`, `backup_before_replace`, `vrt_capture_mode`, and `nextjs` platform enum
- `lib/vrt.ts`: add per-site `baselineTimeoutMs` and pass base URL explicitly for multisite captures
- UI: `app/page.tsx` update site edit modal to expose the new flags

Open questions / Decisions
-------------------------
- Should normalization be the default for `platform === 'wp-multisite'` or opt-in per-site? (Recommendation: opt-in until well-tested.)
- How to handle custom-domain subsites at scale (spire-network)? (Recommendation: per-site mapping table in registry.)
- Baseline capture policy: normalized or raw? (Recommendation: normalized for consistent diffs.)

Contact / Owner
---------------
- Author: (you) / engineering lead
- Suggested reviewers: devops (Pantheon), QA (VRT owner), platform engineer (Next.js), and the person owning `spire-network`.


---
Generated on: 2026-08-22
