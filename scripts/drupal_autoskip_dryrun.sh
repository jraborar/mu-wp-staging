#!/usr/bin/env bash
# drupal_autoskip_dryrun.sh — dry-run test for the auto-skip Phase B logic in lib/drupal.ts.
#
# Mirrors the two-phase composer strategy from drupal.ts but wraps Phase B in the same
# auto-skip loop that will be shipped in the app: when a full `composer update` fails,
# the script identifies which root-required packages have no Drupal-major-compatible
# release, strips them from composer.json, retries, and patches their original lock
# entries back after a clean solve.
#
# READ-ONLY — no git push, no drush, no multidev mutations. Produces a local lock so
# you can validate the final state before the logic goes live in the app.
#
# Usage: scripts/drupal_autoskip_dryrun.sh <site> [multidev]
#   <site>       Pantheon site machine name or UUID
#   [multidev]   defaults to mu-YYMMDD (today, Pacific)
set -uo pipefail

SITE="${1:-}"
DATESTR="$(TZ=America/Los_Angeles date +%y%m%d)"
MD="${2:-mu-${DATESTR}}"
[[ -z "$SITE" ]] && { echo "usage: $0 <site> [multidev]"; exit 2; }

export PATH="/opt/homebrew/opt/php@8.2/bin:/opt/homebrew/bin:$HOME/bin:$PATH"
export COMPOSER_ALLOW_SUPERUSER=1 COMPOSER_NO_INTERACTION=1 COMPOSER_PROCESS_TIMEOUT=300
ROOT="/Users/jasperr/mu_projects/mu_wp_staging"
hr() { printf '─%.0s' {1..66}; echo; }

# dev environment's git branch is "master", not the env name
GIT_BRANCH="$MD"
[[ "$MD" == "dev" ]] && GIT_BRANCH="master"

CORE_TARGETS="drupal/core-recommended drupal/core-composer-scaffold drupal/core-project-message"
RES_FLAGS="--no-install --no-audit --no-scripts --no-plugins --ignore-platform-req=ext-*"
APP_AUTHOR="MU Staging"

# ── 1. SSH key ─────────────────────────────────────────────────────────────────
KEYFILE="$(mktemp /tmp/pantheon_key.XXXXXX)"
python3 - "$ROOT/.env.local" "$KEYFILE" <<'PY'
import base64, sys
env, out = sys.argv[1], sys.argv[2]
for line in open(env):
    if line.startswith('PANTHEON_SSH_KEY'):
        v = line.split('=',1)[1].strip().strip('"').strip("'")
        open(out,'wb').write(base64.b64decode(v)); break
PY
chmod 600 "$KEYFILE"
CLONE=""
trap 'rm -f "$KEYFILE"; [[ -n "$CLONE" ]] && rm -rf "$CLONE"' EXIT
export GIT_SSH_COMMAND="ssh -i $KEYFILE -o StrictHostKeyChecking=no -o UserKnownHostsFile=/dev/null -o LogLevel=ERROR"

GIT_URL="$(terminus connection:info "$SITE"."$MD" --field=git_url 2>/dev/null | grep -iv deprecat | tr -d '[:space:]')"
[[ -z "$GIT_URL" ]] && { echo "could not resolve git_url for $SITE.$MD"; exit 3; }

# ── 2. Clone ────────────────────────────────────────────────────────────────────
echo "▸ Clone $SITE.$MD (branch: $GIT_BRANCH)"
CLONE=/tmp/drupal_autoskip_dryrun_$$
rm -rf "$CLONE"
git clone --depth 50 --single-branch --branch "$GIT_BRANCH" "$GIT_URL" "$CLONE" >/dev/null 2>&1 \
  || { echo "  clone failed for branch $MD"; exit 4; }
[[ -f "$CLONE/composer.lock" ]] || { echo "  no composer.lock — not a lock-committed site"; exit 5; }
cd "$CLONE"

# For sites that have MU Staging commits, rewind to the pre-update state.
# If there are none (e.g. test-mode run with nothing to update), HEAD is the baseline.
BEFORE_REF="$(git log --format='%H %an' | awk -v a="$APP_AUTHOR" '$0 !~ a {print $1; exit}')"
[[ -z "$BEFORE_REF" ]] && BEFORE_REF="HEAD"
cp composer.lock composer.lock.app_after
git show "${BEFORE_REF}:composer.lock" > composer.lock 2>/dev/null || cp composer.lock.app_after composer.lock
git show "${BEFORE_REF}:composer.json" > composer.json 2>/dev/null || true
cp composer.lock composer.lock.original
cp composer.json composer.json.original

CORE_VERSION="$(python3 -c "
import json
lock = json.load(open('composer.lock'))
for p in lock.get('packages', []):
    if p['name'] == 'drupal/core':
        print(p['version']); break
" 2>/dev/null || echo '?')"

echo "  branch tip: $(git rev-parse --short HEAD)  |  pre-update ref: $(git rev-parse --short "$BEFORE_REF")"
echo "  Drupal core (pre-update): $CORE_VERSION"
hr

# ── 3. Phase A — core ──────────────────────────────────────────────────────────
echo "▸ Phase A: Drupal core update"
composer config --no-plugins policy.advisories.block false >/dev/null 2>&1 || true
composer update $CORE_TARGETS -W $RES_FLAGS 2>&1 | grep -E "Lock file operations|Nothing to modify|could not be resolved" | sed 's/^/  /'
CORE_A_RC=${PIPESTATUS[0]}
if [[ $CORE_A_RC -ne 0 ]]; then
  echo "  ✗ core solve FAILED — check log above"
  exit 6
fi
CORE_AFTER="$(python3 -c "
import json
lock = json.load(open('composer.lock'))
for p in lock.get('packages', []):
    if p['name'] == 'drupal/core':
        print(p['version']); break
" 2>/dev/null || echo '?')"
if [[ "$CORE_AFTER" != "$CORE_VERSION" ]]; then
  echo "  ✓ drupal/core $CORE_VERSION → $CORE_AFTER"
else
  echo "  • drupal/core up to date ($CORE_VERSION)"
fi
hr

# ── 4. Phase B — modules/deps with auto-skip loop ─────────────────────────────
echo "▸ Phase B: module / theme / dependency updates (auto-skip enabled)"
echo

declare -a SKIPPED_PKGS=()
declare -a SKIPPED_REASONS=()

for skip_round in $(seq 0 9); do
  PHASE_B_LOG="$(mktemp /tmp/phase_b_$$.log)"
  composer update $RES_FLAGS > "$PHASE_B_LOG" 2>&1
  B_RC=$?
  cat "$PHASE_B_LOG" | grep -E "^  - |Lock file operations|Nothing to modify|Your requirements" | sed 's/^/  /'
  if [[ $B_RC -eq 0 ]]; then
    rm -f "$PHASE_B_LOG"
    break
  fi

  # Parse which root-required packages are blocking the solve
  BLOCKERS="$(python3 - "$PHASE_B_LOG" <<'PY'
import re, sys
seen = set()
for line in open(sys.argv[1]):
    m = re.search(r'Root composer\.json requires ([\w.\-/]+)', line, re.I)
    if m and m.group(1) not in seen:
        seen.add(m.group(1))
        print(m.group(1))
PY
)"
  rm -f "$PHASE_B_LOG"

  if [[ -z "$BLOCKERS" ]]; then
    echo
    echo "  ✗ Phase B failed and no blockers could be parsed from the output — manual fix required"
    exit 7
  fi

  # Strip blockers from composer.json and record as skipped
  NEWLY_SKIPPED="$(python3 - composer.json composer.lock.original "$BLOCKERS" <<'PY'
import json, sys
cjson_path, origlock_path, blocker_str = sys.argv[1], sys.argv[2], sys.argv[3]
blockers = [b.strip() for b in blocker_str.strip().splitlines() if b.strip()]

cjson = json.load(open(cjson_path))
origlock = json.load(open(origlock_path))

lock_versions = {}
for p in origlock.get('packages', []) + origlock.get('packages-dev', []):
    lock_versions[p['name']] = p.get('version', 'current')

stripped = []
for section in ('require', 'require-dev'):
    for pkg in blockers:
        if cjson.get(section, {}).get(pkg):
            ver = lock_versions.get(pkg, 'current')
            del cjson[section][pkg]
            stripped.append(f"{pkg}\t{ver}")

if stripped:
    json.dump(cjson, open(cjson_path, 'w'), indent=4)

for s in stripped:
    print(s)
PY
)"

  if [[ -z "$NEWLY_SKIPPED" ]]; then
    echo
    echo "  ✗ Blockers were identified but none found in composer.json (transitive deps?) — cannot auto-skip"
    exit 8
  fi

  while IFS=$'\t' read -r pkg ver; do
    [[ -z "$pkg" ]] && continue
    SKIPPED_PKGS+=("$pkg")
    SKIPPED_REASONS+=("held at $ver — no compatible release for current Drupal major")
    echo "  ⚠ Skipping $pkg (held at $ver): no compatible release — retrying without it"
  done <<< "$NEWLY_SKIPPED"
  echo

  if [[ $skip_round -eq 9 ]]; then
    echo "  ✗ Phase B still failing after 10 skip rounds — too many incompatible packages"
    exit 9
  fi
done

hr

# ── 5. Patch skipped packages back into the resolved lock ─────────────────────
if [[ ${#SKIPPED_PKGS[@]} -gt 0 ]]; then
  echo "▸ Patching ${#SKIPPED_PKGS[@]} skipped package(s) back into lock from original"
  python3 - composer.lock composer.lock.original "${SKIPPED_PKGS[@]}" <<'PY'
import json, sys
new_lock_path, orig_lock_path = sys.argv[1], sys.argv[2]
skipped = sys.argv[3:]

new_lock  = json.load(open(new_lock_path))
orig_lock = json.load(open(orig_lock_path))

orig_by_name = {}
for section in ('packages', 'packages-dev'):
    for p in orig_lock.get(section, []):
        orig_by_name[p['name']] = (section, p)

for pkg in skipped:
    if pkg not in orig_by_name:
        print(f"  warn: {pkg} not found in original lock — skipping patch")
        continue
    section, entry = orig_by_name[pkg]
    existing = [p['name'] for p in new_lock.get(section, [])]
    if pkg not in existing:
        new_lock.setdefault(section, []).append(entry)
        print(f"  + patched {pkg} ({entry.get('version','?')}) back into {section}")
    else:
        print(f"  • {pkg} already present in new lock")

json.dump(new_lock, open(new_lock_path, 'w'), indent=4)
PY

  # Restore original composer.json so the lock's content-hash stays valid
  cp composer.json.original composer.json
  echo
  echo "▸ Refreshing lock content-hash (composer update --lock)"
  composer update --lock $RES_FLAGS 2>&1 | grep -v "^$" | sed 's/^/  /' | head -10
  HASH_RC=${PIPESTATUS[0]}
  if [[ $HASH_RC -ne 0 ]]; then
    echo "  warn: content-hash refresh failed — lock may show as outdated on Pantheon (non-blocking)"
  else
    echo "  ✓ content-hash updated"
  fi
  hr
fi

# ── 6. Summary ─────────────────────────────────────────────────────────────────
echo "▸ Results"
echo
python3 - composer.lock.original composer.lock composer.json.original <<'PY'
import json, sys
before_f, after_f, cjson_f = sys.argv[1], sys.argv[2], sys.argv[3]

CORE_GROUP = {'drupal/core','drupal/core-recommended','drupal/core-composer-scaffold','drupal/core-project-message'}

def lockmap(f):
    d = json.load(open(f))
    return {p['name']: {'version': p['version'], 'type': p.get('type','')} for p in d.get('packages',[])+d.get('packages-dev',[])}

before, after = lockmap(before_f), lockmap(after_f)

core_upd, modules, themes, deps = [], [], [], []
for name, av in after.items():
    bv = before.get(name)
    if bv and bv['version'] != av['version']:
        row = f"  {name}  ({bv['version']} → {av['version']})"
        if name in CORE_GROUP: core_upd.append(row)
        elif av['type'] == 'drupal-module': modules.append(row)
        elif av['type'] == 'drupal-theme': themes.append(row)
        else: deps.append(row)

def show(title, items):
    print(f"{title} ({len(items)}):")
    if not items: print("  (none)")
    else:
        for r in sorted(items): print(r)
    print()

show("Core", core_upd)
show("Modules", modules)
show("Themes", themes)
show(f"Composer deps", deps)
PY

if [[ ${#SKIPPED_PKGS[@]} -gt 0 ]]; then
  echo "Skipped — no compatible release for current Drupal major (${#SKIPPED_PKGS[@]}):"
  for i in "${!SKIPPED_PKGS[@]}"; do
    echo "  ⚠ ${SKIPPED_PKGS[$i]}  —  ${SKIPPED_REASONS[$i]}"
  done
  echo
fi

# ── 7. Lock comparison vs what the app committed ──────────────────────────────
hr
echo "▸ Comparison: our resolved lock vs app-committed lock on $MD"
python3 - composer.lock composer.lock.app_after <<'PY'
import json, sys
mine_f, app_f = sys.argv[1], sys.argv[2]
def lockmap(f):
    d = json.load(open(f))
    return {p['name']: p['version'] for p in d.get('packages',[])+d.get('packages-dev',[])}
mine, app = lockmap(mine_f), lockmap(app_f)
names = sorted(set(mine)|set(app))
diffs = [(n, mine.get(n), app.get(n)) for n in names if mine.get(n) != app.get(n)]
if not diffs:
    print(f"  ✓ IDENTICAL — all {len(names)} packages resolve to the same versions.")
else:
    print(f"  {len(diffs)} package(s) differ (our resolve → app's committed lock):")
    for n,m,a in diffs:
        print(f"    {n}: {m or '(absent)'}  vs  {a or '(absent)'}  [app]")
PY
hr
echo "Done. No git push; no drush; no multidev mutations."
