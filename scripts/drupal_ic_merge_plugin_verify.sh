#!/usr/bin/env bash
# drupal_ic_merge_plugin_verify.sh — verifies the FIXED Integrated Composer resolve for
# Drupal sites that pull extra requires via wikimedia/composer-merge-plugin (e.g.
# Webform's optional JS libraries in web/modules/contrib/webform/composer.libraries.json).
#
# It reproduces EXACTLY what lib/drupal.ts composerStrategy now does for these sites —
# `composer install` the module tree first (so the plugin's include files exist), then the
# two-phase `composer update` WITH plugins on — and reports the resulting lock composition
# so you can confirm the merge-plugin asset packages STAY in the lock. The bug this guards
# against (PR #175) dropped 17 of them under the old --no-install --no-plugins resolve,
# producing a lock Pantheon's own build rejects ("Required package X is not present…").
#
# It rewinds composer.{json,lock} to the last commit NOT authored by "MU Staging" (the
# live baseline a fresh multidev is built from), so it works whether or not the app has
# already run on the branch. READ-ONLY against Pantheon: git clone (read) + local
# resolution only. Nothing is pushed; no composer.json commit, no drush/terminus mutation.
#
# Usage: scripts/drupal_ic_merge_plugin_verify.sh <site> [multidev-branch]
#   <site>            Pantheon site UUID or machine name
#   [multidev-branch] defaults to mu-<Pacific YYMMDD> (the app's naming)
set -uo pipefail

SITE="${1:-}"
DATESTR="$(TZ=America/Los_Angeles date +%y%m%d)"
MD="${2:-mu-${DATESTR}}"
[[ -z "$SITE" ]] && { echo "usage: $0 <site> [multidev-branch]"; exit 2; }

export PATH="/opt/homebrew/opt/php@8.2/bin:$PATH"   # merge-plugin IC sites run PHP 8.2+
export COMPOSER_ALLOW_SUPERUSER=1 COMPOSER_NO_INTERACTION=1 COMPOSER_PROCESS_TIMEOUT=600
ROOT="/Users/jasperr/mu_projects/mu_wp_staging"
APP_AUTHOR="MU Staging"
hr() { printf '─%.0s' {1..66}; echo; }

# ── 1. Decode the deploy key exactly as production does ────────────────────────
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
CLONE=""                                    # set before the trap so EXIT can't hit an unbound var
trap 'rm -f "$KEYFILE"; [[ -n "$CLONE" ]] && rm -rf "$CLONE"' EXIT
export GIT_SSH_COMMAND="ssh -i $KEYFILE -o StrictHostKeyChecking=no -o UserKnownHostsFile=/dev/null -o LogLevel=ERROR"

# git_url is keyed on an ENV, not a branch. For a multidev the two names match; for the
# canonical `master` branch the env is dev/test/live — resolve via dev in that case.
GIT_ENV="$MD"; [[ "$MD" == "master" ]] && GIT_ENV="dev"
GIT_URL="$(terminus-4 connection:info "$SITE"."$GIT_ENV" --field=git_url 2>/dev/null | grep -iv deprecat | tr -d '[:space:]')"
[[ -z "$GIT_URL" ]] && { echo "could not resolve git_url for $SITE.$GIT_ENV"; exit 3; }

# ── 2. Clone + rewind composer.{json,lock} to the live baseline ────────────────
echo "▸ clone $SITE.$MD and rewind composer.{json,lock} to the live baseline"
CLONE=/tmp/drupal_ic_verify_$$
rm -rf "$CLONE"
# --depth 50: deep enough to reach past any "MU Staging" commits back to the baseline.
git clone --depth 50 --single-branch --branch "$MD" "$GIT_URL" "$CLONE" >/dev/null 2>&1 \
  || { echo "  clone failed for branch $MD"; exit 4; }
cd "$CLONE"
[[ -f composer.json ]] || { echo "  no composer.json — not a Composer-managed site"; exit 5; }
BEFORE_REF="$(git log --format='%H%x09%an' | awk -F'\t' -v a="$APP_AUTHOR" '$2 != a {print $1; exit}')"
[[ -z "$BEFORE_REF" ]] && { echo "  could not find a non-\"$APP_AUTHOR\" baseline commit"; exit 6; }
git show "${BEFORE_REF}:composer.lock" > composer.lock
git show "${BEFORE_REF}:composer.json" > composer.json
cp composer.lock composer.lock.before
echo "  baseline ${BEFORE_REF:0:12}; composer.{json,lock} restored"

if ! python3 -c "import json,sys; sys.exit(0 if json.load(open('composer.json')).get('extra',{}).get('merge-plugin') else 1)"; then
  echo "  NOTE: $SITE has no extra.merge-plugin — this harness targets merge-plugin sites."
  echo "        Use scripts/drupal_composer_dryrun.sh for non-merge-plugin sites."
fi
hr

# ── 3. Reproduce the FIXED resolve: install (plugins) → two-phase update (plugins) ──
echo "▸ install the module tree, then two-phase update WITH plugins (advisory-block off)"
composer config allow-plugins true            >/dev/null 2>&1 || true
composer config policy.advisories.block false >/dev/null 2>&1 || true
rm -rf vendor web
# install materializes web/modules/contrib so merge-plugin's include files exist; it reads
# the committed lock only, and rejects --no-audit, so only --no-scripts + ext-ignore here.
echo -n "  install ... "; composer install --no-scripts '--ignore-platform-req=ext-*' >/tmp/ic_i_$$.log 2>&1; echo "exit $?"
echo -n "  core    ... "; composer update drupal/core-recommended drupal/core-composer-scaffold drupal/core-project-message -W --no-scripts --no-audit '--ignore-platform-req=ext-*' >/tmp/ic_a_$$.log 2>&1; echo "exit $? : $(grep -iE 'Lock file operations' /tmp/ic_a_$$.log | head -1)"
echo -n "  rest    ... "; composer update --no-scripts --no-audit '--ignore-platform-req=ext-*' >/tmp/ic_b_$$.log 2>&1; echo "exit $? : $(grep -iE 'Lock file operations' /tmp/ic_b_$$.log | head -1)"
rm -f /tmp/ic_i_$$.log /tmp/ic_a_$$.log /tmp/ic_b_$$.log
hr

# ── 4. Report: totals + merge-plugin asset retention + module/theme/dep diff ────
echo "▸ resolved lock: totals + merge-plugin asset retention + module/dep diff"
python3 - composer.lock.before composer.lock <<'PY'
import json, sys
def m(f):
    d = json.load(open(f)); o = {}
    for p in d.get('packages', []) + d.get('packages-dev', []):
        o[p['name']] = {'v': p['version'], 't': p.get('type', '')}
    return o
b, a = m(sys.argv[1]), m(sys.argv[2])
# npm-asset / bower-asset library packages merge-plugin injects (Webform's optional libs)
def is_asset(n):
    return any(s in n for s in ('choices', 'codemirror', 'chosen', 'hotkeys',
        'image-picker', 'inputmask', 'intl-tel', 'rateit', 'select2', 'textcounter',
        'timepicker', 'popper', 'progress-tracker', 'signature', 'svg-pan', 'tabby', 'tippy'))
assets_before = sorted(n for n in b if is_asset(n))
assets_after  = sorted(n for n in a if is_asset(n))
print(f"  packages:            before={len(b)}  after={len(a)}")
print(f"  merge-plugin assets: before={len(assets_before)}  after={len(assets_after)}")
dropped = [n for n in assets_before if n not in a]
if dropped:
    print(f"  ✗ FAIL — {len(dropped)} asset package(s) DROPPED from the lock (Pantheon build will reject):")
    for n in dropped: print(f"      - {n}")
else:
    print(f"  ✓ all {len(assets_after)} merge-plugin asset package(s) retained")
chg = [(n, b[n]['v'], a[n]['v']) for n in a if n in b and b[n]['v'] != a[n]['v']]
mods   = [c for c in chg if a[c[0]]['t'] == 'drupal-module']
themes = [c for c in chg if a[c[0]]['t'] == 'drupal-theme']
deps   = [c for c in chg if a[c[0]]['t'] not in ('drupal-module', 'drupal-theme')]
print(f"  modules changed: {len(mods)}")
for n, o, v in sorted(mods): print(f"      - {n} ({o} → {v})")
print(f"  themes changed:  {len(themes)}")
for n, o, v in sorted(themes): print(f"      - {n} ({o} → {v})")
print(f"  deps changed:    {len(deps)}")
rem = [n for n in b if n not in a]; add = [n for n in a if n not in b]
print(f"  transitive:      +{len(add)} added / -{len(rem)} removed")
PY
hr
echo "Done — nothing pushed, no drush/terminus mutation. (Verifies the PR #175 fix.)"
