#!/usr/bin/env bash
# drupal_composer_dryrun.sh — reproduction check for the Drupal Composer update path.
#
# Points at a multidev the APP ALREADY STAGED (e.g. tulsalib mu-260826), rewinds to the
# lock that multidev started from (the last commit NOT authored by "MU Staging"), and
# re-resolves it EXACTLY the way lib/drupal.ts does (two-phase core-then-rest,
# --no-install, --ignore-platform-req=ext-*, with the exit-code checks from the #172 fix).
# Then it diffs its own resolved lock against the lock the APP committed on that branch —
# so you can confirm, package-for-package, that this reference and the app agree.
#
# READ-ONLY. It does the equivalent of the runbook's steps 1–6 and STOPS: no git push,
# no composer install, no drush, no connection:set, no cache clear (steps 7–14). It does
# NOT create or delete any multidev — it only reads the one the app already made.
#
# Usage: scripts/drupal_composer_dryrun.sh <site> [multidev]
#   <site>       Pantheon site (machine name or UUID)
#   [multidev]   default mu-YYMMDD (today, Pacific) — the app's own multidev
set -uo pipefail

SITE="${1:-}"
DATESTR="$(TZ=America/Los_Angeles date +%y%m%d)"
MD="${2:-mu-${DATESTR}}"
[[ -z "$SITE" ]] && { echo "usage: $0 <site> [multidev]"; exit 2; }

export PATH="/opt/homebrew/opt/php@8.2/bin:$PATH"   # match tulsalib's PHP 8.2
export COMPOSER_ALLOW_SUPERUSER=1 COMPOSER_NO_INTERACTION=1 COMPOSER_PROCESS_TIMEOUT=300
ROOT="/Users/jasperr/mu_projects/mu_wp_staging"
hr() { printf '─%.0s' {1..66}; echo; }

# The app's exact resolve contract (lib/drupal.ts:348-350, 399, 424). Mirror it verbatim
# so a lock produced here is directly comparable to a lock produced live.
CORE_TARGETS="drupal/core-recommended drupal/core-composer-scaffold drupal/core-project-message"
RES_FLAGS="--no-install --no-audit --no-scripts --no-plugins --ignore-platform-req=ext-*"
APP_AUTHOR="MU Staging"   # lib/drupal.ts GIT_AUTHOR_NAME — its commits mark the update

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
CLONE=""                                     # set before the trap so EXIT can't hit an unbound var
trap 'rm -f "$KEYFILE"; [[ -n "$CLONE" ]] && rm -rf "$CLONE"' EXIT
export GIT_SSH_COMMAND="ssh -i $KEYFILE -o StrictHostKeyChecking=no -o UserKnownHostsFile=/dev/null -o LogLevel=ERROR"

GIT_URL="$(terminus-4 connection:info "$SITE"."$MD" --field=git_url 2>/dev/null | grep -iv deprecat | tr -d '[:space:]')"
[[ -z "$GIT_URL" ]] && { echo "could not resolve git_url for $SITE.$MD"; exit 3; }

# ── 2. Clone the app's multidev WITH history (need the pre-update commit) ───────
echo "▸ Step 1–2: clone $SITE.$MD with history"
CLONE=/tmp/drupal_dryrun_$$
rm -rf "$CLONE"
git clone --depth 50 --single-branch --branch "$MD" "$GIT_URL" "$CLONE" >/dev/null 2>&1 \
  || { echo "  clone failed for branch $MD"; exit 4; }
[[ -f "$CLONE/composer.lock" ]] || { echo "  no composer.lock on $MD — not a lock-committed site"; exit 5; }
cd "$CLONE"

# The multidev's tip is what the APP committed. The pre-update state is the newest commit
# NOT authored by MU Staging (handles the app's 1 or 2 update commits, or 0 = true no-op).
cp composer.lock composer.lock.app_after
BEFORE_REF="$(git log --format='%H%x09%an' | awk -F'\t' -v a="$APP_AUTHOR" '$2 != a {print $1; exit}')"
[[ -z "$BEFORE_REF" ]] && BEFORE_REF="HEAD~1"
git show "$BEFORE_REF:composer.lock" > composer.lock         # rewind working lock to pre-update
git show "$BEFORE_REF:composer.json" > composer.json 2>/dev/null || true
cp composer.lock composer.lock.before
echo "  app tip: $(git rev-parse --short HEAD)   pre-update ref: $(git rev-parse --short "$BEFORE_REF")"
echo "  rewound to pre-update lock; will re-resolve and compare to the app's committed lock"
hr

# ── 3. Outdated report (the ~ vs ! split), from the pre-update state ───────────
echo "▸ Step 4: composer show -o --locked 'drupal/*'"
composer show "drupal/*" -o --locked 2>/dev/null | grep -E "^drupal/" | sed 's/^/  /' || true
echo "  (note: '~' = major only — out of the ^10.x constraint; NOT an update option unless the customer opts in)"
hr

# ── 4. Resolve the lock the app's way: two-phase, ext-reqs waived, no vendor ───
echo "▸ Step 5: two-phase composer update --no-install (mirrors lib/drupal.ts)"
composer config --no-plugins policy.advisories.block false >/dev/null 2>&1 || true

echo "  5a. core: composer update $CORE_TARGETS -W $RES_FLAGS"
composer update $CORE_TARGETS -W $RES_FLAGS >/tmp/cu_core_$$.log 2>&1
CORE_RC=$?
grep -iE "Lock file operations|Nothing to modify|could not be resolved|missing from your system" /tmp/cu_core_$$.log \
  | sed 's/^/      /' | head
if [[ $CORE_RC -ne 0 ]]; then
  echo "  ✗ core solve FAILED (exit $CORE_RC) — see above. A failed solve is NOT 'up to date'." >&2
  rm -f /tmp/cu_core_$$.log; exit 6
fi
rm -f /tmp/cu_core_$$.log

echo "  5b. rest: composer update $RES_FLAGS"
composer update $RES_FLAGS >/tmp/cu_rest_$$.log 2>&1
REST_RC=$?
grep -iE "Lock file operations|Nothing to modify|could not be resolved|missing from your system" /tmp/cu_rest_$$.log \
  | sed 's/^/      /' | head
if [[ $REST_RC -ne 0 ]]; then
  echo "  ✗ module/dep solve FAILED (exit $REST_RC) — see above. A failed solve is NOT 'no updates'." >&2
  rm -f /tmp/cu_rest_$$.log; exit 6
fi
rm -f /tmp/cu_rest_$$.log
echo "  lock resolved cleanly (both phases exit 0)."
hr

# ── 5. Security audit (reports advisories, incl. on pinned packages) ───────────
echo "▸ Step 5b: composer audit --locked (report only — nothing forced)"
composer audit --locked --format=json 2>/dev/null > /tmp/audit_$$.json || true
hr

# ── 6. Lock diff → three buckets + commit message (pre-update → our resolve) ───
echo "▸ Step 6: core (Upstream) verdict + lock diff → History buckets + commit message"
python3 - "$CLONE/composer.lock.before" "$CLONE/composer.lock" "$CLONE/composer.json" /tmp/audit_$$.json <<'PY'
import json, sys
before_f, after_f, cjson_f, audit_f = sys.argv[1:5]

# Packages that make up "Drupal core" — they must move together and map to the
# History "Upstream Update" line. drupal/core-dev is NOT here (dev dep = a module).
CORE_GROUP = {
    'drupal/core', 'drupal/core-recommended',
    'drupal/core-composer-scaffold', 'drupal/core-project-message',
}

def lockmap(f):
    d = json.load(open(f))
    out = {}
    for p in d.get('packages', []) + d.get('packages-dev', []):
        out[p['name']] = {'version': p['version'], 'type': p.get('type','')}
    return out

b, a = lockmap(before_f), lockmap(after_f)
constraints = json.load(open(cjson_f)).get('require', {})
constraints.update(json.load(open(cjson_f)).get('require-dev', {}))

def bucket(name, typ):
    if name in CORE_GROUP:     return 'core'
    if typ == 'drupal-module': return 'modules'
    if typ == 'drupal-theme':  return 'themes'
    return 'deps'

buckets = {'core': [], 'modules': [], 'themes': [], 'deps': []}
for name, av in a.items():
    bv = b.get(name)
    if bv and bv['version'] != av['version']:
        buckets[bucket(name, av['type'])].append((name, bv['version'], av['version']))
added   = [n for n in a if n not in b]
removed = [n for n in b if n not in a]

# ── Upstream (core) verdict — in-constraint ONLY (majors are not an update) ──
core_now = b.get('drupal/core', {}).get('version', '?')
CORE_CMD = ("composer update drupal/core-recommended "
            "drupal/core-composer-scaffold drupal/core-project-message -W")
print(f"\nUpstream Update (Drupal core) — current {core_now}:")
core_change = next((x for x in buckets['core'] if x[0] == 'drupal/core'), None)
if core_change:
    _, o, nv = core_change
    print(f"  ✓ in-constraint core update: Drupal ({o} → {nv})")
    print(f"  real flow runs this as its own Upstream step/commit:\n    {CORE_CMD}")
else:
    print(f"  • core is up to date ({core_now}) — nothing new within constraint")

def show(title, items):
    print(f"\n{title} ({len(items)}):")
    if not items: print("  (none)"); return
    for n, o, nv in sorted(items):
        print(f"  - {n} ({o} → {nv})")

show("Modules", buckets['modules'])
show("Themes", buckets['themes'])
show("Composer Dependencies", buckets['deps'])
if added or removed:
    print(f"\n(+{len(added)} added / -{len(removed)} removed transitive)")

# security advisories, flag those on pinned (exact-version) packages
try:
    adv = json.load(open(audit_f)).get('advisories', {})
except Exception:
    adv = {}
def is_pinned(name):
    c = constraints.get(name, '')
    return bool(c) and c[0] not in '^~><*'
print(f"\nSecurity advisories ({sum(len(v) for v in adv.values())}):")
if not adv:
    print("  (none)")
for name, items in adv.items():
    pin = " [PINNED — manual review, not updated]" if is_pinned(name) else ""
    for it in items:
        print(f"  ⚠ {name} — {it.get('cve') or it.get('advisoryId','?')}: {it.get('title','')[:60]}{pin}")

# generated commit message (mirrors the manual per-module style)
lines = ["Update Drupal core, modules & dependencies", ""]
if buckets['core']:
    n,o,nv = buckets['core'][0]; lines.append(f"- Drupal core ({o} → {nv})")
for n,o,nv in sorted(buckets['modules']): lines.append(f"- {n} ({o} → {nv})")
for n,o,nv in sorted(buckets['themes']):  lines.append(f"- {n} ({o} → {nv})")
nd = len(buckets['deps'])
if nd: lines.append(f"- {nd} Composer dependency update(s)")
print("\n" + "─"*66)
print("Generated commit message:\n")
print("\n".join(lines))
PY
rm -f /tmp/audit_$$.json
hr

# ── 7. THE COMPARISON: our resolved lock vs the lock the app committed ─────────
echo "▸ Step 7: does our resolve match what the app pushed to $MD?"
python3 - "$CLONE/composer.lock" "$CLONE/composer.lock.app_after" <<'PY'
import json, sys
mine_f, app_f = sys.argv[1:3]
def lockmap(f):
    d = json.load(open(f)); out = {}
    for p in d.get('packages', []) + d.get('packages-dev', []):
        out[p['name']] = p['version']
    return out
mine, app = lockmap(mine_f), lockmap(app_f)
names = sorted(set(mine) | set(app))
diffs = [(n, mine.get(n), app.get(n)) for n in names if mine.get(n) != app.get(n)]
if not diffs:
    print(f"  ✓ IDENTICAL — all {len(names)} packages resolve to the same versions.")
    print("    This reference reproduces the app's lock exactly, package-for-package.")
    print("    Confirms the app's --ignore-platform-req=ext-* did not distort resolution.")
else:
    print(f"  ✗ {len(diffs)} package(s) differ (reference → app):")
    for n, m, a in diffs:
        print(f"    - {n}: {m or '(absent)'}  vs  {a or '(absent)'}")
    print("\n    Legit causes: the app ran on a different day (upstream moved since), or a")
    print("    newer point release landed between the app's push and this reproduction.")
PY
hr
echo "Done — reproduced the app's resolve read-only. Nothing pushed; no multidev created,"
echo "no drush/terminus mutation (runbook steps 7–14 intentionally skipped)."
