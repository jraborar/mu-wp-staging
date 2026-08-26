#!/usr/bin/env bash
# drupal_stage_poc.sh — Phase-1 proof-of-concept for staging a Composer-managed
# Drupal site on Pantheon, mirroring the Drupal branch we will add to
# lib/staging.ts. Safe by default: everything is READ-ONLY unless you pass
# --apply, and even then each mutation is announced before it runs.
#
# Profiled sample: tulsalib (Drupal 10.6.15, Drush 12.5.3, PHP 8.2, composer-managed).
#
# Usage:
#   scripts/drupal_stage_poc.sh <site> [multidev]            # discovery + dry-run only
#   scripts/drupal_stage_poc.sh --apply <site> [multidev]    # actually create/backup/normalize
#
# Stages (see docs/mu-drupal-staging-pr.md):
#   1. Discover + fail-closed profile gate   (read-only)
#   2. Create staging multidev from live     (mutation — --apply)
#   3. Backup before mutation                (mutation — --apply)
#   4. Normalize: drush cr + health check    (mutation — --apply; read-only health probe otherwise)
#   5. Update plan (composer, DRY-RUN)       (read-only report; real apply is a later phase)

set -uo pipefail

APPLY=false
[[ "${1:-}" == "--apply" ]] && { APPLY=true; shift; }

SITE="${1:-}"
DATESTR="$(TZ=America/Los_Angeles date +%y%m%d)"
MD="${2:-mu-${DATESTR}-d}"   # -d suffix keeps Drupal PoC runs distinct from mu-YYMMDD

[[ -z "$SITE" ]] && { echo "usage: $0 [--apply] <site> [multidev]"; exit 2; }

# Pin PHP 8.2 + terminus-4 so output is clean (mirrors the app's per-command MU_TERMINUS_PHP).
export PATH="/opt/homebrew/opt/php@8.2/bin:$PATH"
T() { terminus-4 "$@" 2>/dev/null; }

# Extract the first balanced JSON object/array from noisy terminus stdout.
json() { python3 -c "import sys,json;s=sys.stdin.read();i=min([x for x in (s.find('{'),s.find('[')) if x>=0]+[len(s)]);d=json.loads(s[i:] if i<len(s) else '{}');print(json.dumps(d))"; }
jget() { python3 -c "import sys,json;d=json.load(sys.stdin);print(d.get('$1',''))"; }

hr() { printf '─%.0s' {1..64}; echo; }
say() { echo "▸ $*"; }
mutate() {  # announce, then run only under --apply
  if $APPLY; then echo "+ $*"; "$@"; else echo "DRY-RUN (mutation, needs --apply): $*"; fi
}

echo "Drupal staging PoC — site=$SITE multidev=$MD apply=$APPLY"
hr

# ── 1. Discover + profile gate ────────────────────────────────────────────────
say "Stage 1: discovery (read-only)"
INFO="$(T site:info "$SITE" --format=json | json)"
FRAMEWORK="$(echo "$INFO" | jget framework)"
UP_LABEL="$(echo "$INFO"  | jget upstream_label)"
LABEL="$(echo "$INFO"     | jget label)"
echo "  label:     $LABEL"
echo "  framework: $FRAMEWORK"
echo "  upstream:  $UP_LABEL"

case "$FRAMEWORK" in
  drupal*) : ;;
  *) echo "  ✗ unsupported_drupal_profile: framework '$FRAMEWORK' is not Drupal"; exit 1 ;;
esac

STATUS="$(T drush "$SITE".dev -- status --format=json | json)"
DV="$(echo "$STATUS"   | jget drupal-version)"
DRUSH="$(echo "$STATUS"| jget drush-version)"
ROOT="$(echo "$STATUS" | jget root)"
PHP="$(echo "$STATUS"  | jget php-version)"
echo "  drupal:    $DV"
echo "  drush:     $DRUSH"
echo "  php:       $PHP"
echo "  root:      $ROOT"

# Fail-closed gate for the first supported profile: D10 + Drush 12 + composer-managed + /code/web
ok=true
[[ "$DV"   == 10.* ]]                 || { echo "  ✗ Drupal major not 10 ($DV)";        ok=false; }
[[ "$DRUSH" == 12.* ]]                || { echo "  ✗ Drush major not 12 ($DRUSH)";       ok=false; }
[[ "$UP_LABEL" == *"Composer"* ]]     || { echo "  ✗ upstream not Composer-managed";     ok=false; }
[[ "$ROOT" == "/code/web" ]]          || { echo "  ✗ project root not /code/web ($ROOT)"; ok=false; }
$ok || { echo "  ✗ unsupported_drupal_profile — stopping before any mutation"; exit 1; }
echo "  ✓ profile supported (D10 / Drush12 / composer-managed / /code/web)"
hr

# ── 2. Create staging multidev from live ──────────────────────────────────────
say "Stage 2: staging multidev"
EXISTS="$(T multidev:list "$SITE" --field=id | grep -Fx "$MD" || true)"
if [[ -n "$EXISTS" ]]; then
  echo "  $MD already exists — reusing (real flow deletes with --delete-branch first)"
else
  mutate terminus-4 multidev:create "$SITE".live "$MD"
fi
hr

# ── 3. Backup before mutation ─────────────────────────────────────────────────
say "Stage 3: backup before mutation"
mutate terminus-4 backup:create "$SITE"."$MD" --element=database
hr

# ── 4. Normalize + health check ───────────────────────────────────────────────
say "Stage 4: normalize (drush cr) + health check"
mutate terminus-4 drush "$SITE"."$MD" -- cr
URL="https://${MD}-${SITE}.pantheonsite.io"
if [[ -n "$EXISTS" || $APPLY == true ]]; then
  code="$(curl -s -o /dev/null -w '%{http_code}' --max-time 20 "$URL" || echo 000)"
  echo "  health probe $URL → HTTP $code"
  BOOT="$(T drush "$SITE"."$MD" -- status --field=bootstrap 2>/dev/null | grep -iv deprecat | tr -d '[:space:]')"
  echo "  drush bootstrap: ${BOOT:-unknown}"
else
  echo "  (multidev not created in dry-run — skipping live health probe)"
fi
hr

# ── 5. Update plan (composer, DRY-RUN) ────────────────────────────────────────
say "Stage 5: update plan — composer-managed (report only)"
echo "  Composer-managed Drupal updates are NOT applied here. The real path:"
echo "    1. git clone the ${MD} repo over SSH (terminus connection:info --field=git_url)"
echo "    2. composer update 'drupal/core-*' --with-all-dependencies   (or targeted contrib)"
echo "    3. commit composer.json + composer.lock, push origin"
echo "    4. drush updb -y && drush cim -y && drush cr   (DB + config import + cache)"
echo "  upstream:updates:list (scaffold only, rarely core/contrib):"
T upstream:updates:list "$SITE"."${EXISTS:+$MD}" --format=list 2>/dev/null | grep -iv deprecat | sed 's/^/    /' | head -5 || echo "    (none)"
hr
echo "Done. Re-run with --apply to perform Stages 2–4 against a real -d multidev."
