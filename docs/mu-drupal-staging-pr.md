# PR: Add Drupal Support to Staging

## Status

Proposal — the first Drupal sample has now been profiled locally. Implementation
should remain supervised until the Drupal-specific normalization and update
commands are verified against this site.

## First profiled sample

The registered sample is Tulsa Library:

- Pantheon machine name: `tulsalib`
- Registry platform: `drupal`
- Drupal: `10.6.15`
- PHP: `8.2.32`
- Drush: `12.5.3`
- Upstream: `pantheon-upstreams/drupal-composer-managed`
- Drupal root: `/code/web`
- Config sync: `../config/sync`
- Dev URL: `https://dev-tulsalib.pantheonsite.io`
- VRT: enabled

Read-only discovery was run successfully through Terminus and Drush. The
registry record had no machine name before discovery; it should be backfilled
to `tulsalib` before any multidev operation relies on that record.

The current staging lifecycle recognizes Drupal as a non-WordPress upstream,
but then continues into WordPress readiness and plugin/theme update steps.
The Drupal implementation must add an explicit platform branch before those
steps, rather than relying on upstream detection alone.

## Goal

Extend the existing staging workflow so a Drupal site can be safely staged,
normalized to its Pantheon multidev URL, updated according to its upstream
model, checked with VRT, and handed to an operator with enough evidence to
approve, investigate, or roll back the run.

The first Drupal site is intentionally a discovery input. Drupal 7, legacy
Drupal 8/9, and Composer-managed Drupal 9/10/11 projects do not have the same
update, configuration, or Drush behavior. We should not hard-code one of those
paths before inspecting the actual site.

## Scope

- Register Drupal sites with `platform = 'drupal'`.
- Detect and record the site's Drupal major version, PHP version, Drush
  availability/version, Composer/upstream model, and Pantheon environment
  capabilities.
- Create a backup before any database or configuration normalization.
- Create or recreate a staging multidev using the existing lifecycle.
- Normalize absolute host references to the multidev URL using the site's
  supported Drupal/Drush mechanism.
- Run the correct upstream update path for the discovered project model.
- Capture VRT after normalization and after updates, when VRT is enabled.
- Preserve backup identifiers, commands/results, update outcomes, and
  actionable failure reasons in staging history.
- Provide a documented rollback path and operator approval boundaries.

For the profiled sample, the first implementation should target Drupal 10,
Drush 12, and the Pantheon Composer-managed upstream contract. Broader Drupal
support remains a follow-up after this path is verified.

## Out of scope for the first PR

- Supporting every Drupal upstream model through automatic detection alone.
- Generic SQL search-and-replace across every Drupal table.
- Automatic conversion between Drupal major versions.
- Application-specific content migrations, custom deployment scripts, or
  contrib-module configuration changes without site-specific evidence.
- Treating a successful Drupal update as a successful production deployment;
  deployment remains a separate status and approval flow.

## Proposed staging flow

1. **Preflight and discovery**
   - Load the registered site and require `platform = 'drupal'`.
   - Inspect the target environment with Terminus/Drush and the repository,
     where available.
   - Record a small capability profile rather than inferring behavior from the
     platform label alone:
     - Drupal major version and `core.extension`/status information
     - Drush version and supported commands
     - Composer-managed versus legacy/non-Composer project
     - Pantheon upstream and update mechanism
     - PHP version and required PHP extensions
     - database/config synchronization model
     - files/private-files requirements and cache behavior
   - For the first sample, require the discovered profile to match Drupal 10,
     Drush 12, Composer-managed code, and the `/code/web` project root before
     enabling any mutation.
   - Fail closed with a clear `unsupported_drupal_profile` result when the
     profile cannot be determined safely.

2. **Create the staging environment**
   - Reuse the existing multidev creation/readiness checks.
   - Compute the canonical multidev URL from the machine name and multidev
     name; do not derive it from user-provided text.
   - Confirm the environment responds before running Drupal commands.

3. **Back up before mutation**
   - Request a database backup through the supported Pantheon mechanism,
     preferring the Platform API where credentials and the verified endpoint
     are available.
   - Fall back only to an explicitly supported Terminus backup command.
   - Poll for completion and persist the backup ID, environment, and status in
     staging history before continuing.
   - If a backup cannot be confirmed, stop before normalization or updates.

  The sample's backup command and restore behavior still need a supervised
  verification; read-only Drush discovery does not establish rollback safety.

4. **Normalize for the multidev**
   - Select a site-specific normalization adapter from the discovered profile.
   - Prefer Drupal-aware operations such as Drush configuration commands,
     config import/export, or the project's documented deployment command.
   - Use targeted SQL only when the site's schema and serialized value format
     are known and the operation has a dry-run or verification step.
   - Update trusted host/base URL settings and relevant contrib-module config;
     do not rewrite content or file metadata speculatively.
   - Clear Drupal/Pantheon caches and run a health check after normalization.
   - Record the normalized URL, adapter/profile, change counts, and warnings.
   - For `tulsalib`, first test the exact config source and environment-specific
     settings in a dry run. Do not assume that replacing values in `key_value`
     is sufficient for Drupal 10 config or contrib-module settings.

5. **Baseline, update, and compare**
   - Start the VRT baseline only after normalization succeeds.
   - Apply the discovered upstream update path:
     - Composer-managed projects: use the repository/upstream workflow and
       the project's lock-file/deployment conventions.
     - Pantheon-managed legacy upstreams: use the verified Terminus/Platform
       operation for that upstream.
     - Unknown or custom workflows: produce a dry-run/report and require
       explicit operator handling.
   - Run database updates only when the project profile and upstream command
     explicitly require them.
   - Capture the candidate and compare it with the baseline.

6. **Finish and retain evidence**
   - Keep the normalized multidev available for review according to the normal
     staging lifecycle.
   - Report Drupal profile, backup, normalization, update, VRT, and rollback
     metadata in History and Slack.
   - Distinguish staging success, update skips, VRT findings, approval expiry,
     and deployment outcomes.

## Code changes

Likely integration points, subject to the discovery result:

- `lib/staging.ts`: add a Drupal branch around preflight, backup,
  normalization, update, and VRT sequencing without changing WordPress behavior.
- `lib/terminus.ts`: add narrowly scoped command helpers and structured output
  parsing where existing wrappers are insufficient.
- `lib/sites.ts` and the sites schema: store Drupal capability/profile fields
  only after their shape is confirmed by the first site.
- `lib/vrt.ts`: ensure the normalized multidev URL is passed as the capture
  base, with Drupal-specific paths supplied by the site's VRT configuration.
- `app/api/sites` and the site UI: expose platform/profile state and safe
  operator controls; do not expose arbitrary SQL or shell commands.
- `staging_history` migration: persist backup ID, Drupal profile, normalization
  summary, and stable failure codes if existing columns cannot represent them.
- `docs/`: add the discovered site's runbook and rollback instructions after
  the first successful supervised run.

The first code change should also bypass WordPress-only operations for Drupal:
`wp core is-installed`, WP-CLI plugin/theme discovery, and WordPress plugin or
theme commits must not run for the sample.

## Safety requirements

- Drupal staging is opt-in by registry platform and capability profile.
- Backups are required before database/config mutation.
- Apply operations are authenticated, logged, and separated from dry-run or
  discovery operations.
- Commands use structured argument escaping; no user-entered site values are
  interpolated into unescaped shell or SQL.
- Unsupported or ambiguous upstreams stop before mutation.
- Rollback uses the recorded backup and documented project-specific steps; it
  is never implemented as an unverified inverse SQL replacement.
- Secrets, tokens, and raw command output containing credentials are sanitized
  before persistence or Slack notification.

## Acceptance criteria

- A registered Drupal site reports a capability profile before any mutation.
- The `tulsalib` sample is resolved to its machine name before multidev creation.
- An unsupported or incomplete profile stops with a stable, actionable reason.
- A confirmed backup exists and its ID is visible in the staging record before
  normalization begins.
- The staging multidev serves the expected Drupal site URL after normalization.
- The chosen normalization path is verified with a health check and does not
  perform a broad unreviewed database replacement.
- The update command matches the site's discovered upstream model and records
  changed, skipped, and failed work separately.
- VRT baseline/candidate captures use the normalized multidev URL when enabled.
- A failed run provides a sanitized failure code/message and a backup-based
  rollback reference.
- Existing WordPress and WordPress Multisite staging behavior remains
  unchanged.
- A Drupal run does not invoke WP-CLI readiness, plugin, or theme commands.

## Discovery checklist for the first Drupal site

Before implementation is finalized, collect:

- Pantheon site UUID, machine name, upstream name, and target environment.
- Drupal major/minor version and PHP version.
- Drush version and the output of the relevant status/config commands.
- Whether the project is Composer-managed and where updates are committed.
- The project's expected database update/config import sequence.
- Base URL, trusted host, reverse-proxy, CDN, and multisite/domain settings.
- Public/private files and required cache rebuilds.
- Representative VRT paths and any authenticated pages.
- A tested backup/restore procedure and the people approving the first run.

## Delivery phases

### Phase 0 — profile the site

Register the Drupal site, run read-only discovery, verify backup capability, and
produce a capability report. No normalization or updates are automatic in this
phase.

Completed locally for `tulsalib`: Terminus site/environment discovery and
Drush status discovery succeed, returning the profile listed above. Backup,
normalization, and update behavior remain untested and must not be inferred
from this read-only result.

### Phase 1 — supervised staging

Implement the matched adapter, backup persistence, normalization verification,
health checks, and a dry-run/supervised update path. Run against the first site
with operator approval at each mutation boundary.

### Phase 2 — VRT and operational reporting

Add Drupal VRT paths, baseline/candidate comparison, History/Slack summaries,
and stable failure/rollback reporting.

### Phase 3 — hardening

Test repeat runs, failed backups, unavailable Drush, cache failures, upstream
conflicts, restore procedures, and behavior across the site's supported PHP and
Drupal versions. Only then consider enabling unattended cadence runs.

## Open decisions after site registration

- Which Pantheon upstream and Drupal major version are in use?
- Is the project Composer-managed, and does the upstream update code or only
  deploy repository changes?
- Which config is environment-specific and must not be copied into a multidev?
- Does normalization require Drush config operations, a deployment script, or
  a narrowly scoped data transformation?
- Are private files, domain aliases, CDN behavior, or authentication needed for
  meaningful VRT?
- Which backup API/Terminus operation is verified for this account?

## Related design

- `docs/wpms-drupal-nextjs-integration.md` — shared normalization and VRT
  design, including the Drupal-specific starting point.
- `docs/mu-wp-staging-history-retention-pr.md` — history retention and failure
  evidence requirements.
