#!/usr/bin/env python3
"""gate — is the LIVE bifrost stack in its declared, stable state?

Read-only checks, one receipt line each. Exit 0 = GREEN (every MUST passed),
1 = RED. Run it before and after ANY change to the live stack;
scripts/promote.sh runs it for you and rolls back on RED.

Born 10-06 (the multi-instance night): the live stack ran from the dev
worktree, three branch lines served at once, agents restarted units and
kill -9'd processes by hand, and nothing said "this is the state that works".
The gate is that statement. Live = lk-pwa + lk-agent, served from a frozen
release (~/.local/share/bifrost/live), never from a worktree.

  scripts/gate.py              live checks + voice dispatch probe
  scripts/gate.py --no-probe   skip the probe (creates+deletes one LiveKit room)
  scripts/gate.py --full       + the Playwright e2e suite against :8080 (~4 min)
  scripts/gate.py --manifest DIR   print the source manifest hash of a release dir
"""
import concurrent.futures
import hashlib
import json
import os
import pathlib
import re
import subprocess
import sys
import time
import urllib.request

HOME = pathlib.Path.home()
BIF = HOME / ".local/share/bifrost"
LIVE = BIF / "live"
DEV = HOME / "Work/bifrost"
ENV_DIR = HOME / ".config/bifrost/env"
RECEIPTS = HOME / ".local/state/bifrost/gate"
LIVE_UNITS = ("lk-pwa", "lk-agent")
LAB_UNITS = ("lk-yggdrasil", "bifrost-sandbox", "lk-agent-ygg", "bifrost-bridge", "lk-pwa-lan")
BRAIN = "http://127.0.0.1:4096"  # default; a release's env/live-pwa.env OPENCODE_URL wins


def release_env(name):
    """The env the live release declares (env/ inside it since v0.6.1), else the draft dir."""
    f = LIVE / "env" / name
    return dotenv(f) if f.exists() else dotenv(ENV_DIR / name)


def brain():
    return (release_env("live-pwa.env").get("OPENCODE_URL") or BRAIN).rstrip("/")
# source tree hashed into the release manifest (build outputs and state excluded)
MANIFEST_SKIP = {"node_modules", ".next", ".venv", "__pycache__", "test-results",
                 "playwright-report", ".diag"}

results = []  # (level, check, receipt)


def mark(level, check, msg):
    results.append((level, check, msg))


def sh(cmd, timeout=20, env=None):
    try:
        return subprocess.run(cmd, shell=isinstance(cmd, str), capture_output=True,
                              text=True, timeout=timeout, env=env).stdout
    except Exception:
        return ""


def http(url, timeout=5):
    try:
        with urllib.request.urlopen(url, timeout=timeout) as r:
            return r.status, r.read().decode(errors="replace")
    except urllib.error.HTTPError as e:
        return e.code, ""
    except Exception:
        return 0, ""


def unit(name, prop):
    return sh(["systemctl", "--user", "show", f"{name}.service", "-p", prop, "--value"]).strip()


def proc_env(pid):
    try:
        raw = pathlib.Path(f"/proc/{pid}/environ").read_bytes()
        return dict(kv.split("=", 1) for kv in raw.decode(errors="replace").split("\0") if "=" in kv)
    except Exception:
        return {}


def proc_cwd(pid):
    try:
        return os.readlink(f"/proc/{pid}/cwd")
    except Exception:
        return ""


def proc_cgroup(pid):
    try:
        return pathlib.Path(f"/proc/{pid}/cgroup").read_text().strip().rsplit("/", 1)[-1]
    except Exception:
        return ""


def proc_cmd(pid):
    try:
        return pathlib.Path(f"/proc/{pid}/cmdline").read_bytes().replace(b"\0", b" ").decode().strip()
    except Exception:
        return ""


def dotenv(path):
    out = {}
    try:
        for line in pathlib.Path(path).read_text().splitlines():
            line = line.strip()
            if line and not line.startswith("#") and "=" in line:
                k, v = line.split("=", 1)
                out[k.strip()] = v.strip().strip("'\"")
    except Exception:
        pass
    return out


def manifest_hash(root):
    """sha256 over (path, content-hash) of the release source — any edit after promote shows."""
    root = pathlib.Path(root)
    h = hashlib.sha256()
    for top in ("pwa", "agent", "scripts"):
        base = root / top
        if not base.is_dir():
            continue
        for dirpath, dirnames, filenames in os.walk(base):
            dirnames[:] = sorted(d for d in dirnames if d not in MANIFEST_SKIP)
            for f in sorted(filenames):
                p = pathlib.Path(dirpath) / f
                if p.is_symlink():  # state links (.push-subs.json, …) are not source
                    continue
                rel = p.relative_to(root).as_posix()
                h.update(rel.encode() + b"\0" + hashlib.sha256(p.read_bytes()).hexdigest().encode() + b"\n")
    return h.hexdigest()


def agent_workers():
    """Every livekit-agents worker main process on the box: pid, cwd, unit, effective name."""
    out = []
    for p in pathlib.Path("/proc").iterdir():
        if not p.name.isdigit():
            continue
        cmd = proc_cmd(p.name)
        if not re.search(r"(^|/)python3? agent\.py (start|dev|console)", cmd):
            continue
        pid = int(p.name)
        env = proc_env(pid)
        cwd = proc_cwd(pid)
        name = env.get("AGENT_NAME") or dotenv(os.path.join(cwd, ".env")).get("AGENT_NAME") or "bifrost"
        out.append({"pid": pid, "cwd": cwd, "unit": proc_cgroup(pid), "name": name})
    return out


# --- checks ---------------------------------------------------------------------

def check_release():
    if not LIVE.is_symlink():
        mark("FAIL", "release", f"{LIVE} missing — live is not a frozen release (served from a worktree?)")
        return None, {}
    rel = LIVE.resolve()
    try:
        meta = json.loads((rel / "RELEASE.json").read_text())
    except Exception as e:
        mark("FAIL", "release", f"{rel}: RELEASE.json unreadable ({e})")
        return rel, {}
    cur = manifest_hash(rel)
    if cur == meta.get("manifest_sha256"):
        mark("PASS", "release.frozen", f"{meta.get('label')} · {rel.name} · source {meta.get('source')} · manifest {cur[:12]}")
    else:
        mark("FAIL", "release.frozen", f"{rel.name}: source edited after promote (manifest {cur[:12]} != {str(meta.get('manifest_sha256'))[:12]})")
    disk_id = (rel / "pwa/.next/BUILD_ID").read_text().strip() if (rel / "pwa/.next/BUILD_ID").exists() else ""
    if disk_id and disk_id == meta.get("build_id"):
        mark("PASS", "release.build", f".next BUILD_ID {disk_id} = the promoted build")
    else:
        mark("FAIL", "release.build", f".next BUILD_ID {disk_id or '-'} != promoted {meta.get('build_id')} (rebuilt in place?)")
    st, body = http("http://127.0.0.1:8080/api/build")
    served = ""
    try:
        served = json.loads(body).get("id", "")
    except Exception:
        pass
    if served and served == disk_id:
        mark("PASS", "release.served", f":8080 serves build {served}")
    else:
        mark("FAIL", "release.served", f":8080 serves build {served or f'? (HTTP {st})'}, release has {disk_id or '-'}")
    for u in LIVE_UNITS:
        pid = unit(u, "MainPID")
        cwd = proc_cwd(pid) if pid and pid != "0" else ""
        if cwd and pathlib.Path(cwd).resolve().is_relative_to(rel):
            mark("PASS", f"unit.{u}", f"active, pid {pid}, runs from the release")
        else:
            mark("FAIL", f"unit.{u}", f"state={unit(u, 'ActiveState')} pid={pid} cwd={cwd or '-'} — not the live release")
    return rel, meta


def check_singletons():
    ss = sh(["ss", "-ltnpH"])
    for port, owner in ((8080, "lk-pwa"), (4096, "opencode-serve")):
        pids = set(re.findall(rf"\S+:{port}\s.*?pid=(\d+)", ss))
        lines = [l for l in ss.splitlines() if re.search(rf":{port}\s", l.split()[3] + " ")]
        want = unit(owner, "MainPID")
        if len(lines) == 1 and pids == {want}:
            mark("PASS", f"port.{port}", f"one listener, {owner} pid {want}")
        else:
            mark("FAIL", f"port.{port}", f"{len(lines)} listener(s) pids={sorted(pids) or '?'} expected {owner} pid {want}")
    st, _ = http("http://127.0.0.1:7880")
    mark("PASS" if st == 200 else "FAIL", "port.7880", f"LiveKit HTTP {st}")

    workers = agent_workers()
    live = [w for w in workers if w["unit"] == "lk-agent.service"]
    if len(live) != 1:
        mark("FAIL", "agent.single", f"{len(live)} lk-agent worker processes (want 1): {live}")
        return None
    name = live[0]["name"]
    clash = [w for w in workers if w["name"] == name and w["pid"] != live[0]["pid"]]
    if clash:
        mark("FAIL", "agent.single", f"name '{name}' also registered by {[(w['pid'], w['unit'], w['cwd']) for w in clash]} — LiveKit splits dispatches")
    else:
        others = ", ".join(f"{w['name']}@{w['unit'] or w['pid']}" for w in workers if w is not live[0]) or "none"
        mark("PASS", "agent.single", f"one worker named '{name}' (pid {live[0]['pid']}); other workers: {others}")
    return live[0]


def check_coherence(worker):
    pwa_pid = unit("lk-pwa", "MainPID")
    penv = proc_env(pwa_pid)
    rel = LIVE.resolve() if LIVE.is_symlink() else DEV
    pfile = dotenv(rel / "pwa/.env.local")
    p_name = penv.get("AGENT_NAME") or pfile.get("AGENT_NAME")
    p_brain = penv.get("OPENCODE_URL") or pfile.get("OPENCODE_URL")
    # the agent's effective env = its .env (load_dotenv, no override) under the process env
    a_env = {**dotenv(os.path.join(worker["cwd"], ".env")), **proc_env(worker["pid"])} if worker else {}
    a_brain = a_env.get("OPENCODE_URL")
    a_name = worker["name"] if worker else None
    if p_name and p_name == a_name:
        mark("PASS", "env.agent-name", f"pwa dispatches '{p_name}' = worker registers '{a_name}'")
    else:
        mark("FAIL", "env.agent-name", f"pwa dispatches '{p_name or '(code default)'}' but worker registers '{a_name}' — voice gets no agent")
    want = brain()
    if p_brain == want and a_brain == want:
        mark("PASS", "env.brain", f"pwa + agent both on {want}")
    else:
        mark("FAIL", "env.brain", f"pwa={p_brain} agent={a_brain} (want both {want}, the release's brain) — split brain")
    # the units must run the env the live release carries (switch/rollback swap it)
    if (LIVE / "env").is_dir():
        r_pwa, r_agent = release_env("live-pwa.env"), release_env("live-agent.env")
        drift = [k for k in ("AGENT_NAME", "OPENCODE_URL") if r_pwa.get(k) and penv.get(k) != r_pwa.get(k)]
        drift += [f"agent:{k}" for k in ("AGENT_NAME", "OPENCODE_URL", "SPEACHES_URL")
                  if r_agent.get(k) and a_env.get(k) != r_agent.get(k)]
        if drift:
            mark("FAIL", "release.env", f"units run a different env than the release's env/ ({', '.join(drift)}) — restart via promote.sh")
        else:
            mark("PASS", "release.env", "units run the release's own env/ (switch/rollback carry it)")
    else:
        mark("WARN", "release.env", "live release has no env/ (pre-v0.6.1) — run scripts/promote.sh --list to backfill")
    since = unit("lk-agent", "ActiveEnterTimestamp")
    reg = sh(["journalctl", "--user", "-u", "lk-agent", "--since", since or "-1h", "-o", "cat", "--no-pager"], timeout=30)
    names = re.findall(r'"message": "registered worker".*?"agent_name": "([^"]*)"', reg)
    if names and names[-1] == a_name:
        mark("PASS", "agent.registered", f"LiveKit accepted worker '{names[-1]}' (since {since})")
    else:
        mark("FAIL", "agent.registered", f"no 'registered worker {a_name}' in the journal since {since} (saw {names[-3:]})")
    return p_name, a_env


def check_health(a_env):
    st, body = http("http://127.0.0.1:8080/")
    css = re.search(r'href="([^"]+\.css[^"]*)"', body or "")
    cst = http("http://127.0.0.1:8080" + css.group(1))[0] if css else 0
    if st == 200 and (not css or cst == 200):
        mark("PASS", "health.pwa", f"/ 200, chunk {css.group(1).rsplit('/', 1)[-1] if css else '-'} {cst or '-'}")
    else:
        mark("FAIL", "health.pwa", f"/ {st}, css chunk {cst} (ChunkLoadError class)")
    t = time.time()
    b = brain()
    st, _ = http(f"{b}/session/status", timeout=5)
    mark("PASS" if st == 200 else "FAIL", "health.brain", f"brain {b} {st} in {int((time.time() - t) * 1000)}ms")
    sp = (a_env.get("SPEACHES_URL") or "").rstrip("/")
    root = re.sub(r"(https?://[^/]+).*", r"\1", sp)
    # speaches answers /v1/models; the Mac MLX server only /health (its /v1/models is 404)
    if sp and (http(sp + "/models", timeout=4)[0] == 200 or http(root + "/health", timeout=4)[0] == 200):
        mark("PASS", "health.speech", f"primary {sp} up")
    elif http("http://127.0.0.1:8000/v1/models", timeout=4)[0] == 200:
        mark("WARN", "health.speech", f"primary {sp or '-'} DOWN — running on the CPU fallback (speaches :8000)")
    else:
        mark("FAIL", "health.speech", f"primary {sp or '-'} and fallback :8000 both down — voice is dead")


def check_exposure():
    """No unauthenticated brain on any LAN address (the tailnet is v0.6's only boundary)."""
    lan = []
    for line in sh(["ip", "-4", "-o", "addr", "show", "scope", "global"]).splitlines():
        f = line.split()
        if not re.match(r"(tailscale|docker|br-|veth)", f[1]):
            lan.append(f[3].split("/")[0])
    ports = set()
    for line in sh(["ss", "-ltnH"]).splitlines():
        local = line.split()[3]
        host, port = local.rsplit(":", 1)
        if host.strip("[]") not in ("127.0.0.1", "::1") and not host.startswith("127.") and not host.startswith("100.") and "fd7a" not in host:
            ports.add(int(port))

    def probe(target):
        ip, port = target
        st, body = http(f"http://{ip}:{port}/api/session", timeout=1.5)
        return ip, port, st, body[:1] == "["

    with concurrent.futures.ThreadPoolExecutor(16) as ex:
        hits = [r for r in ex.map(probe, [(ip, p) for ip in lan for p in sorted(ports)]) if r[2] == 200 and r[3]]
    if hits:
        mark("FAIL", "exposure.lan", "UNAUTHENTICATED session list (brain with bash) on " + ", ".join(f"{ip}:{p}" for ip, p, _, _ in hits))
    else:
        mark("PASS", "exposure.lan", f"no unauthenticated /api/session on {','.join(lan)} ({len(ports)} non-loopback ports probed)")
    wide = sorted(p for p in ports if p in (8081, 18082))
    if wide:
        mark("WARN", "exposure.agent-http", f"agent worker HTTP on 0.0.0.0:{wide} (health only; should be loopback)")


def check_strays():
    rel = LIVE.resolve() if LIVE.is_symlink() else None
    pat = re.compile(r"(next-server|next start|agent\.py (start|dev)|/yggdrasil( |$)|bifrost-net |server\.mjs|voice_server)")
    strays = []
    for p in pathlib.Path("/proc").iterdir():
        try:
            if not p.name.isdigit() or p.stat().st_uid != os.getuid():
                continue
        except OSError:  # exited mid-scan
            continue
        cmd = proc_cmd(p.name)
        if not pat.search(cmd):
            continue
        cg = proc_cgroup(p.name)
        if cg.endswith(".service") and cg != "opencode-serve.service":
            continue
        strays.append(f"pid {p.name} [{cg or '?'}] {cmd[:80]} (cwd {proc_cwd(p.name)})")
    if strays:
        mark("WARN", "strays", f"{len(strays)} unsupervised bifrost process(es): " + " | ".join(strays[:5]))
    else:
        mark("PASS", "strays", "every bifrost process belongs to a systemd unit (no detached spawns)")
    if rel and sh(["pgrep", "-f", f"claude .*-p .*{rel}"]).strip():
        mark("WARN", "autonomy.release", "a claude -p process references the live release dir")


def check_autonomy():
    timer = unit_timer = sh(["systemctl", "--user", "is-active", "fleet-watchdog.timer"]).strip()
    mark("WARN" if unit_timer == "active" else "PASS", "autonomy.watchdog",
         f"fleet-watchdog.timer {timer} ({'re-prompts dead turns every 5 min' if timer == 'active' else 'no automatic re-prompting'})")
    drv = sh(["pgrep", "-fa", "ygg-driver.sh"]).strip()
    mark("WARN" if drv else "PASS", "autonomy.driver", f"ygg-driver loop {'RUNNING: ' + drv[:60] if drv else 'off'}")
    st, body = http(f"{BRAIN}/session/status")
    busy = []
    try:
        busy = [k for k, v in json.loads(body).items() if (v or {}).get("type") == "busy"]
    except Exception:
        pass
    mark("INFO", "autonomy.busy", f"{len(busy)} opencode session(s) busy: {', '.join(busy) or 'none'}")


def check_labs(live_name):
    for u in LAB_UNITS:
        state = unit(u, "ActiveState")
        if state != "active":
            mark("INFO", f"lab.{u}", state or "absent")
            continue
        pid = unit(u, "MainPID")
        mark("INFO", f"lab.{u}", f"active, cwd {proc_cwd(pid) or unit(u, 'WorkingDirectory')}")
    for w in agent_workers():
        if w["unit"] != "lk-agent.service" and w["name"] == live_name:
            mark("FAIL", "lab.agent-name", f"lab worker pid {w['pid']} ({w['unit']}) uses the LIVE name '{live_name}'")
    sim = sh(["docker", "ps", "--filter", "name=ygg-sim", "--format", "{{.Status}}"]).strip()
    mark("INFO", "lab.ygg-sim", f"container {sim or 'not running'}")


def probe_voice(agent_name):
    """The failure class of 10-06: a dispatch nobody answers. Room is created and deleted."""
    envf = release_env("live-agent.env") or dotenv(DEV / "agent/.env")
    rel = LIVE.resolve() if LIVE.is_symlink() else DEV
    py = rel / "agent/.venv/bin/python"
    if not py.exists():
        py = DEV / "agent/.venv/bin/python"
    code = r'''
import asyncio, json, os, time
from livekit import api
async def main():
    url = os.environ["LIVEKIT_URL"].replace("ws://", "http://").replace("wss://", "https://")
    lk = api.LiveKitAPI(url, os.environ["LIVEKIT_API_KEY"], os.environ["LIVEKIT_API_SECRET"])
    room = "gate-probe-%d" % int(time.time())
    out = {"room": room}
    try:
        await lk.room.create_room(api.CreateRoomRequest(name=room, empty_timeout=30))
        t = time.time()
        await lk.agent_dispatch.create_dispatch(api.CreateAgentDispatchRequest(agent_name=os.environ["PROBE_AGENT"], room=room))
        while time.time() - t < 20:
            ps = (await lk.room.list_participants(api.ListParticipantsRequest(room=room))).participants
            ag = [p.identity for p in ps if p.kind == api.ParticipantInfo.Kind.AGENT]
            if ag:
                out.update(joined_ms=int((time.time() - t) * 1000), agents=ag)
                break
            await asyncio.sleep(0.25)
    except Exception as e:
        out["error"] = repr(e)
    finally:
        try:
            await lk.room.delete_room(api.DeleteRoomRequest(room=room))
        except Exception:
            pass
        await lk.aclose()
    print(json.dumps(out))
asyncio.run(main())
'''
    env = dict(os.environ, **{k: envf.get(k, "") for k in ("LIVEKIT_URL", "LIVEKIT_API_KEY", "LIVEKIT_API_SECRET")}, PROBE_AGENT=agent_name)
    raw = sh([str(py), "-c", code], timeout=40, env=env)
    try:
        r = json.loads(raw.strip().splitlines()[-1])
    except Exception:
        mark("FAIL", "voice.dispatch", f"probe crashed: {raw[-200:] or '(no output)'}")
        return
    if r.get("joined_ms") is not None and len(r.get("agents", [])) == 1:
        mark("PASS", "voice.dispatch", f"dispatch '{agent_name}' → agent in room {r['room']} after {r['joined_ms']}ms (room deleted)")
    elif r.get("agents"):
        mark("FAIL", "voice.dispatch", f"{len(r['agents'])} agents joined one dispatch: {r['agents']}")
    else:
        mark("FAIL", "voice.dispatch", f"no agent joined {r['room']} within 20s {r.get('error', '')}")


def run_e2e():
    t = time.time()
    p = subprocess.run(["npx", "playwright", "test", "--reporter=line"], cwd=DEV / "pwa",
                       capture_output=True, text=True, timeout=1200)
    tail = (p.stdout + p.stderr).strip().splitlines()[-3:]
    mark("PASS" if p.returncode == 0 else "FAIL", "e2e", f"{int(time.time() - t)}s · " + " / ".join(tail))


def main():
    args = sys.argv[1:]
    if args[:1] == ["--manifest"]:
        print(manifest_hash(args[1]))
        return 0
    started = time.strftime("%Y-%m-%d %H:%M:%S")
    check_release()
    worker = check_singletons()
    live_name, a_env = check_coherence(worker) if worker else (None, {})
    check_health(a_env)
    check_exposure()
    check_strays()
    check_autonomy()
    check_labs(worker["name"] if worker else None)
    if "--no-probe" not in args and worker:
        probe_voice(worker["name"])
    if "--full" in args:
        run_e2e()

    fails = [c for lvl, c, _ in results if lvl == "FAIL"]
    warns = [c for lvl, c, _ in results if lvl == "WARN"]
    lines = [f"bifrost gate · {started}"] + [f"  {lvl:4}  {c:20} {m}" for lvl, c, m in results]
    verdict = (f"GATE RED — {len(fails)} failed: {', '.join(fails)}" if fails
               else f"GATE GREEN — {sum(1 for r in results if r[0] == 'PASS')} pass, {len(warns)} warn")
    lines.append(verdict)
    print("\n".join(lines))
    RECEIPTS.mkdir(parents=True, exist_ok=True)
    (RECEIPTS / f"{time.strftime('%Y%m%dT%H%M%S')}.txt").write_text("\n".join(lines) + "\n")
    return 1 if fails else 0


if __name__ == "__main__":
    sys.exit(main())
