#!/usr/bin/env python3
"""life-probe — re-derive every store number plan.md cites (Rule 10-02 / 10-08 evidence).

Read-only (sqlite URI mode=ro); never writes to the store. Usage:
    python3 docs/yggdrasil-harness/life-probe.py [path/to/opencode.db]
Prints one `key = value` line per measurement. The store only grows, so later
runs show larger counts; the CLASSES and their ranking are what must hold.
"""
import collections
import json
import os
import re
import sqlite3
import sys

DB = sys.argv[1] if len(sys.argv) > 1 else os.path.expanduser('~/.local/share/opencode/opencode.db')
db = sqlite3.connect(f'file:{DB}?mode=ro', uri=True)
c = db.cursor()


def out(k, v):
    print(f'{k} = {v}')


out('sessions', c.execute('select count(*) from session').fetchone()[0])
out('messages', c.execute('select count(*) from message').fetchone()[0])
out('parts', c.execute('select count(*) from part').fetchone()[0])

roles, errs = collections.Counter(), collections.Counter()
zombies = 0
for (d,) in c.execute('select data from message'):
    j = json.loads(d)
    roles[j.get('role')] += 1
    if j.get('error'):
        errs[j['error'].get('name')] += 1
    if j.get('role') == 'assistant' and not j.get('time', {}).get('completed') and not j.get('error'):
        zombies += 1
out('roles', dict(roles))
out('message_errors', dict(errs))
out('zombie_turns_never_completed', zombies)

# P1 — tool calls in flight when a turn was aborted, by elapsed band
band = collections.Counter()
outside = 0
for mid, d in c.execute("select id, data from message where json_extract(data,'$.error.name')='MessageAbortedError'").fetchall():
    co = json.loads(d)['time'].get('completed')
    for (pd,) in c.execute("select data from part where message_id=? and json_extract(data,'$.type')='tool'", (mid,)):
        s = json.loads(pd).get('state', {})
        if s.get('status') == 'running' or 'abort' in str(s.get('error', '')).lower():
            st, en = s.get('time', {}).get('start'), s.get('time', {}).get('end') or co
            if st and en:
                el = (en - st) / 1000
                k = '<570s' if el < 570 else '570-660s(watchdog)' if el < 660 else '>660s'
                band[k] += 1
                if k.startswith('570') and re.search(r'~/\.|/home/[^/]+/\.|Applications|ssh ', json.dumps(s.get('input', {}))):
                    outside += 1
out('aborted_tool_elapsed_bands', dict(band))
out('watchdog_band_kills_outside_project_or_ssh', outside)

# P2 — the question tool (asks the phone cannot render)
q = collections.Counter(json.loads(d)['state']['status'] for (d,) in c.execute(
    "select data from part where json_extract(data,'$.tool')='question'"))
out('question_tool_status', dict(q))

# tool status + bash duration bands (yggdrasil default bash timeout = 120 s)
dur = collections.Counter()
pat = {
    'curl_own_api': r'(127\.0\.0\.1|localhost):4096/session',
    'ssh_other_tree': r'\bssh\b.*\b(mac|studio|veraldar)\b',
    'detach_nohup_setsid': r'\b(nohup|setsid|disown)\b',
    'poll_sleep_30s_plus': r'\bsleep\s+([3-9]\d|\d{3,})\b',
    'claude_p_delegation': r'claude\s+-p|agi-run\.sh',
}
hits, hsess = collections.Counter(), collections.defaultdict(set)
for sid, d in c.execute("select session_id, data from part where json_extract(data,'$.tool')='bash'"):
    s = json.loads(d)['state']
    t = s.get('time', {})
    if t.get('start') and t.get('end'):
        x = (t['end'] - t['start']) / 1000
        dur['<120s' if x < 120 else '120-600s' if x < 600 else '>600s'] += 1
    cmd = str(s.get('input', {}).get('command', ''))
    for k, p in pat.items():
        if re.search(p, cmd):
            hits[k] += 1
            hsess[k].add(sid)
out('bash_duration_bands', dict(dur))
for k in pat:
    out(f'bash_{k}', f'{hits[k]} calls / {len(hsess[k])} sessions')

# P3/P4 — user prompts: status polls, driver injections, revives
polls = inj = rev = 0
for (d,) in c.execute("""select p.data from message m join part p on p.message_id=m.id
        where json_extract(m.data,'$.role')='user' and json_extract(p.data,'$.type')='text'"""):
    tx = json.loads(d).get('text', '')
    if re.match(r'^\s*(so\s*\??|done\??|\?+|status\??|.*\b(he|it) done\b.*)\s*$', tx, re.I):
        polls += 1
    if re.match(r'^(DRIVER|DIRECTIVE|BUDGET NOTICE|ALIGNMENT|MISSION ARRIVED|REFINEMENT|USER ORDER|EXECUTE NOW)', tx):
        inj += 1
    if re.match(r'^watchdog revive|your turn died', tx, re.I):
        rev += 1
out('user_status_polls', polls)
out('user_driver_injections', inj)
out('user_watchdog_revives', rev)

# turn duration (user prompt -> last completed assistant step before the next prompt)
turns = []
for (sid,) in c.execute('select id from session').fetchall():
    cur = last = None
    for (d,) in c.execute('select data from message where session_id=? order by time_created, id', (sid,)):
        j = json.loads(d)
        if j['role'] == 'user':
            if cur and last:
                turns.append((last - cur) / 1000)
            cur, last = j['time']['created'], None
        else:
            last = j['time'].get('completed') or last
    if cur and last:
        turns.append((last - cur) / 1000)
turns.sort()
out('turns', len(turns))
out('turn_median_s', round(turns[len(turns) // 2]))
out('turn_p90_s', round(turns[int(.9 * len(turns))]))
out('turns_over_10min', sum(1 for x in turns if x > 600))

# P6 — the marathon: largest context and compaction usage
top = c.execute("""select s.id, s.title, count(m.id) from session s join message m on m.session_id=s.id
        group by s.id order by 3 desc limit 1""").fetchone()
mx = 0
for (d,) in c.execute("select data from message where session_id=? and json_extract(data,'$.role')='assistant'", (top[0],)):
    tk = json.loads(d).get('tokens', {})
    mx = max(mx, (tk.get('input') or 0) + ((tk.get('cache') or {}).get('read') or 0))
out('deepest_session', f'{top[0]} "{top[1].strip()}" {top[2]} msgs, max context {mx} tokens')
out('sessions_ever_compacted', c.execute('select count(*) from session where time_compacting is not null').fetchone()[0])

# never used
out('shared', c.execute('select count(*) from session where share_url is not null').fetchone()[0])
out('reverted', c.execute('select count(*) from session where revert is not null').fetchone()[0])
out('archived', c.execute('select count(*) from session where time_archived is not null').fetchone()[0])
agents = collections.Counter(json.loads(d).get('mode') for (d,) in c.execute(
    "select data from message where json_extract(data,'$.role')='assistant'"))
out('assistant_steps_by_agent', dict(agents))
