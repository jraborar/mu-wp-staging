#!/usr/bin/env bash
# drupal_composer_dryrun.sh — proves the Drupal Composer update path (steps 1–6 of
# the manual runbook) WITHOUT pushing anything. Clones the multidev branch, resolves
# the lock within the committed constraints (composer update --no-install: rewrites
# composer.lock, downloads no vendor, pushes nothing), diffs the lock into the three
# History buckets, runs composer audit, and prints the commit message we would use.
#
# READ-ONLY against Pantheon: git clone (read) + local lock resolution. No git push,
# no composer install, no drush, no terminus mutation.
#
# Usage: scripts/drupal_composer_dryrun.sh <site> [multidev-branch]
set -uo pipefail

SITE="${1:-}"
DATESTR="$(TZ=America/Los_Angeles date +%y%m%d)"
MD="${2:-mu-${DATESTR}-d}"
[[ -z "$SITE" ]] && { echo "usage: $0 <site> [multidev-branch]"; exit 2; }

export PATH="/opt/homebrew/opt/php@8.2/bin:$PATH"   # match tulsalib's PHP 8.2
export COMPOSER_ALLOW_SUPERUSER=1 COMPOSER_NO_INTERACTION=1 COMPOSER_PROCESS_TIMEOUT=300
ROOT="/Users/jasperr/mu_projects/mu_wp_staging"
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

# ── 2. Clone the multidev branch ──────────────────────────────────────────────
echo "▸ Step 1–2: clone $SITE.$MD (branch: $MD)"
CLONE=/tmp/drupal_dryrun_$$
rm -rf "$CLONE"
git clone --depth 1 --single-branch --branch "$MD" "$GIT_URL" "$CLONE" >/dev/null 2>&1 \
  || { echo "  clone failed for branch $MD"; exit 4; }
[[ -f "$CLONE/composer.lock" ]] || { echo "  no composer.lock on $MD — not a lock-committed site"; exit 5; }
cp "$CLONE/composer.lock" "$CLONE/composer.lock.before"
echo "  cloned; composer.lock present"
hr

cd "$CLONE"

# ── 3. Outdated report (the ~ vs ! split) ─────────────────────────────────────
echo "▸ Step 4: composer show -o --locked 'drupal/*'"
composer show "drupal/*" -o --locked 2>/dev/null | grep -E "^drupal/" | sed 's/^/  /' || true
echo "  (note: '~' = major only — out of the ^10.x constraint; NOT an update option unless the customer opts in)"
hr

# ── 4. Resolve the lock within constraints (no vendor, no push) ────────────────
echo "▸ Step 5: composer update --no-install (advisory block off; pinned stay pinned)"
composer config --no-plugins policy.advisories.block false >/dev/null 2>&1 || true
composer update --no-install --no-audit --no-scripts --no-plugins >/tmp/cu_$$.log 2>&1
echo "  lock resolved (exit $?). Key lines:"
grep -iE "Lock file operations|Nothing to modify|Writing lock" /tmp/cu_$$.log | sed 's/^/    /' | head
rm -f /tmp/cu_$$.log
hr

# ── 5. Security audit (reports advisories, incl. on pinned packages) ───────────
echo "▸ Step 5b: composer audit --locked (report only — nothing forced)"
composer audit --locked --format=json 2>/dev/null > /tmp/audit_$$.json || true
hr

# ── 6. Lock diff → three buckets + commit message ─────────────────────────────
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
rm -f /tmp/audit_$$.json /tmp/core_$$.txt
hr
echo "Done — nothing was pushed, no vendor installed, no drush/terminus mutation."
