#!/usr/bin/env bash
# verify.sh — checks the yggdrasil-harness plan-build deliverables.
# One PASS / FAIL / SKIP line per check; exit 0 iff no FAIL.
# SKIP = an optional check whose prerequisite is absent (no store, no node) — stated, never silent.
# Usage: bash docs/yggdrasil-harness/verify.sh   (from anywhere)
set -u
HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
ROOT="$(cd "$HERE/../.." && pwd)"
STORE="${OPENCODE_DB:-$HOME/.local/share/opencode/opencode.db}"
exec python3 - "$ROOT" "$STORE" <<'PY'
import os, re, sys, json, shutil, subprocess, tempfile
from html.parser import HTMLParser

root, store = sys.argv[1], sys.argv[2]
plan_p = os.path.join(root, 'docs/yggdrasil-harness/plan.md')
probe_p = os.path.join(root, 'docs/yggdrasil-harness/life-probe.py')
arts = {n: os.path.join(root, f'artifacts/yggdrasil-ux-{n}.html') for n in ('near', 'mid', 'far')}
fails = 0
def line(ok, name, detail=''):
    global fails
    tag = {True: 'PASS', False: 'FAIL', None: 'SKIP'}[ok]
    if ok is False: fails += 1
    print(f'{tag}  {name}' + (f' — {detail}' if detail else ''))

# ── files ──
for label, p in [('plan.md', plan_p), ('life-probe.py', probe_p), ('verify.sh', os.path.join(root, 'docs/yggdrasil-harness/verify.sh'))] + [(f'yggdrasil-ux-{n}.html', p) for n, p in arts.items()]:
    line(os.path.isfile(p) and os.path.getsize(p) > 0, f'file exists: {label}', os.path.relpath(p, root))

# ── plan.md ──
plan = open(plan_p, encoding='utf-8').read() if os.path.isfile(plan_p) else ''
ns = re.search(r'^## North star\n(.*?)\n---', plan, re.S | re.M)
nlines = len(re.findall(r'^\d\. ', ns.group(1), re.M)) if ns else 0
line(nlines == 5, 'plan: north star in 5 lines', f'{nlines} numbered lines')
m0 = re.search(r'^### H0 — M0.*?(?=^### )', plan, re.S | re.M)
m0ok = bool(m0) and all(k in m0.group(0) for k in ('**One file:**', '**One command:**', '**One verifiable output:**'))
line(m0ok, 'plan: Slice 0 = M0 (one file, one command, one verifiable output)')
slices = re.findall(r'^### (H[1-9]\d*) — (.*?)\n(.*?)(?=^### |^## |\Z)', plan, re.S | re.M)
line(len(slices) >= 3, 'plan: ≥3 slices after M0', f'{len(slices)} slices: ' + ' '.join(s[0] for s in slices))
no_verify = [s[0] for s in slices if not re.search(r'\*\*Verify \(hard\):\*\* `[^`]+`', s[2])]
line(bool(slices) and not no_verify, 'plan: every slice has a hard verify command', 'missing: ' + ' '.join(no_verify) if no_verify else 'all exit-code checkable')
no_files = [s[0] for s in slices if '**Files:**' not in s[2] and '**Mechanism:**' not in s[2]]
no_ev = [s[0] for s in slices if '**Evidence:**' not in s[2] and 'ab-verdict.json' not in s[2]]
line(not no_files and not no_ev, 'plan: every slice names files touched + evidence artifact', ' '.join(no_files + no_ev))
no_cite = [s[0] for s in slices if not re.search(r'\*\*Answers:\*\*.*?(P[1-7]|vision\.md)', s[2], re.S)]
line(bool(slices) and not no_cite, 'plan: every slice answers a cited friction (P1–P7) or vision.md', ' '.join(no_cite))
line('## 7. Open questions' in plan and len(re.findall(r'^\| Q\d+ \|', plan, re.M)) >= 3, 'plan: open questions section', f'{len(re.findall(r"^[|] Q[0-9]+ [|]", plan, re.M))} questions')
line(bool(re.search(r'^## .*[Ww]hat I could not do', plan, re.M)), 'plan: honesty section “what I could not do, and why”')
line('Rust' in plan and 'H5' in plan and 'evidence' in plan, 'plan: Rust evolution is evidence-triggered (H5 gate)')

# ── evidence ids in plan exist in the store (read-only) ──
ids = sorted(set(re.findall(r'\b(ses_[A-Za-z0-9]{20,}|msg_[A-Za-z0-9]{20,})\b', plan)))
if os.path.isfile(store):
    import sqlite3
    try:
        db = sqlite3.connect(f'file:{store}?mode=ro', uri=True)
        miss = [i for i in ids if not db.execute(f"select 1 from {'session' if i.startswith('ses_') else 'message'} where id=?", (i,)).fetchone()]
        line(not miss and len(ids) >= 20, 'plan: every cited store id exists (read-only lookup)', f'{len(ids)} ids, missing: {miss or "none"}')
    except Exception as e:
        line(None, 'plan: cited store ids exist', f'store unreadable: {e}')
    r = subprocess.run([sys.executable, probe_p, store], capture_output=True, text=True, timeout=120)
    ok = r.returncode == 0 and 'watchdog_band_kills_outside_project_or_ssh' in r.stdout
    line(ok, 'life-probe.py re-derives the store numbers', (r.stdout.strip().splitlines() or [''])[0] if ok else r.stderr.strip()[-200:])
else:
    line(None, 'plan: cited store ids exist', f'no store at {store}')
    line(None, 'life-probe.py runs', f'no store at {store}')

# ── artifacts ──
VOID = {'area', 'base', 'br', 'col', 'embed', 'hr', 'img', 'input', 'link', 'meta', 'source', 'track', 'wbr'}
class Strict(HTMLParser):
    def __init__(s):
        super().__init__(convert_charrefs=True); s.stack = []; s.err = []; s.scripts = []; s.attrs = []; s._in = False
    def handle_starttag(s, tag, attrs):
        s.attrs.append((tag, dict(attrs)))
        if tag == 'script': s._in = True; s.scripts.append('')
        if tag not in VOID: s.stack.append((tag, s.getpos()))
    def handle_startendtag(s, tag, attrs): s.attrs.append((tag, dict(attrs)))
    def handle_endtag(s, tag):
        if tag == 'script': s._in = False
        if tag in VOID: return
        if not s.stack or s.stack[-1][0] != tag:
            s.err.append(f'</{tag}> at {s.getpos()} (open: {s.stack[-1] if s.stack else None})')
            return
        s.stack.pop()
    def handle_data(s, d):
        if s._in: s.scripts[-1] += d

FR = ['en attente', 'arbre', 'terminé', 'réponse', 'maintenir', 'touche', 'toi']
EN = ['waiting', 'tree', 'done', 'hold']
node = shutil.which('node')
for n, p in arts.items():
    if not os.path.isfile(p):
        line(False, f'{n}: artifact present'); continue
    html = open(p, encoding='utf-8').read()
    ps = Strict()
    try:
        ps.feed(html); ps.close(); perr = ps.err + ([f'unclosed: {ps.stack}'] if ps.stack else [])
    except Exception as e:
        perr = [str(e)]
    line(not perr and html.lstrip().lower().startswith('<!doctype html>'), f'{n}: valid parseable HTML (html.parser, balanced tags)', '; '.join(perr[:3]))
    ext = [f'{t} {a}={v}' for t, at in ps.attrs for a, v in at.items() if a in ('src', 'href', 'action', 'data', 'poster') and v and re.match(r'\s*(https?:)?//', v)]
    ext += re.findall(r'url\(\s*[\'"]?(?:https?:)?//[^)]*\)', html) + re.findall(r'@import[^;]+;', html)
    ext += [k for k in ('fetch(', 'XMLHttpRequest', 'new WebSocket', 'EventSource', 'sendBeacon', '<link rel="stylesheet"', '<script src') if k in html]
    line(not ext, f'{n}: self-contained (no external src/href, url(), @import, network APIs)', '; '.join(ext[:4]))
    persist = [k for k in ('localStorage', 'sessionStorage', 'indexedDB', 'document.cookie', 'caches.open', 'serviceWorker') if k in html]
    line(not persist, f'{n}: re-runnable (no persisted state)', ', '.join(persist))
    fr_hits = [w for w in FR if w in html]; en_hits = [w for w in EN if w in html]
    langs = 'data-lang="en"' in html and 'data-lang="fr"' in html
    line(langs and len(fr_hits) >= 3 and len(en_hits) >= 3, f'{n}: EN + FR strings + language toggle', f'fr={len(fr_hits)} en={len(en_hits)} toggle={langs}')
    line('data-persona="woman"' in html and 'data-persona="man"' in html, f'{n}: woman/man persona toggle')
    line('id="phone"' in html and 'id="desk"' in html and 'name="viewport"' in html, f'{n}: phone frame + desktop frame + viewport meta')
    if node and ps.scripts:
        with tempfile.NamedTemporaryFile('w', suffix='.js', delete=False) as f:
            f.write('\n'.join(ps.scripts)); js = f.name
        r = subprocess.run([node, '--check', js], capture_output=True, text=True)
        os.unlink(js)
        line(r.returncode == 0, f'{n}: inline JS parses (node --check)', r.stderr.strip().splitlines()[0] if r.returncode else '')
    else:
        line(None, f'{n}: inline JS parses', 'node not found' if not node else 'no inline script')

print(('VERIFY PASS' if not fails else f'VERIFY FAIL — {fails} failed check(s)'))
sys.exit(1 if fails else 0)
PY
