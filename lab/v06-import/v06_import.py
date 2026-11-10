#!/usr/bin/env python3
"""v06-import — migrate ALL v0.6 sessions from the opencode store into the yggdrasil store.

LAWS (from mission + bifrost/AGENTS.md):
- Source (:4096 sqlite) is READ-ONLY: opened in URI ro-mode; never written, moved, vacuumed.
- MAIN session (ses_770b899884cf47718e054f6f2702630c) is NEVER touched.
- Pre-existing ses_*.json in the target store are NEVER overwritten (skip + record).
- Every v0.6 session gets a fresh ses_ id (deterministic from the old id), title
  prefixed "[V06] ", info.archived=true, info.v06id = original id.
- No service restarts. Nothing is dropped silently.

Modes:
  python3 v06_import.py            # import (idempotent; skips already-imported)
  python3 v06_import.py --dry-run  # count scope only, write nothing
  python3 v06_import.py --verify   # the gate: counts, spot-check, invariants
"""
import hashlib
import json
import os
import sqlite3
import sys
import tempfile
from datetime import datetime, timezone, timedelta

HOME = os.path.expanduser("~")
SRC_DB = f"{HOME}/.local/share/opencode/opencode.db"
TGT_DIR = f"{HOME}/.local/share/yggdrasil/session"
LAB = f"{HOME}/Work/bifrost/lab/v06-import"
MAP_PATH = f"{LAB}/map.json"

MAIN_ID = "ses_770b899884cf47718e054f6f2702630c"
TITLE_PREFIX = "[V06] "
# v0.6 scope: sessions created before 2026-10-28 00:00 local (CET, UTC+1) that are
# not subagent children. = exactly 221 sessions; 58 newer ones are v0.7-era.
CUTOVER_MS = int(datetime(2026, 10, 28, 0, 0, tzinfo=timezone(timedelta(hours=1))).timestamp() * 1000)


def open_src():
    con = sqlite3.connect(f"file:{SRC_DB}?mode=ro", uri=True)
    con.row_factory = sqlite3.Row
    return con


def scoped_sessions(con):
    """The v0.6 session set: non-child, created before cutover. Returns rows."""
    return con.execute(
        "SELECT * FROM session s WHERE s.parent_id IS NULL AND s.time_created < ? "
        "ORDER BY s.time_created, s.id",
        (CUTOVER_MS,),
    ).fetchall()


def mint_id(old_id: str) -> str:
    """Fresh, deterministic ses_ id (stable across reruns → idempotent skips)."""
    h = hashlib.sha256(f"v06-import:v1:{old_id}".encode()).hexdigest()[:32]
    return f"ses_{h}"


def load_parts(con, message_id):
    rows = con.execute(
        "SELECT data FROM part WHERE message_id=? ORDER BY time_created, id",
        (message_id,),
    ).fetchall()
    return [json.loads(r["data"]) for r in rows]


def convert_session(con, srow):
    """opencode session row → yggdrasil {info, messages[, todo]} document."""
    old_id = srow["id"]
    new_id = mint_id(old_id)
    messages = []
    mrows = con.execute(
        "SELECT * FROM message WHERE session_id=? ORDER BY time_created, id", (old_id,)
    ).fetchall()
    for m in mrows:
        data = json.loads(m["data"])
        info = {k: v for k, v in data.items() if k != "time"}
        t = dict(data.get("time") or {})
        t.setdefault("created", m["time_created"])  # guard; source always has it
        info["time"] = t
        messages.append({"info": info, "parts": load_parts(con, m["id"])})

    info = {
        "id": new_id,
        "title": TITLE_PREFIX + (srow["title"] or ""),
        "archived": True,
        "v06id": old_id,
        "time": {"created": srow["time_created"], "updated": srow["time_updated"]},
        "directory": srow["directory"],
        "v06meta": {k: srow[k] for k in srow.keys()},  # full original row — nothing lost
    }
    doc = {"info": info, "messages": messages}

    trows = con.execute(
        "SELECT content, status, priority, position FROM todo WHERE session_id=? ORDER BY position",
        (old_id,),
    ).fetchall()
    if trows:
        doc["todo"] = [
            {"id": str(r["position"]), "content": r["content"],
             "status": r["status"], "priority": r["priority"]}
            for r in trows
        ]
    return new_id, doc


def atomic_write_json(path, obj):
    d = os.path.dirname(path)
    fd, tmp = tempfile.mkstemp(dir=d, prefix=".v06tmp-")
    try:
        with os.fdopen(fd, "w") as f:
            json.dump(obj, f, ensure_ascii=False, separators=(",", ":"))
        os.replace(tmp, path)
    finally:
        if os.path.exists(tmp):
            os.unlink(tmp)


def sha256_file(p):
    h = hashlib.sha256()
    with open(p, "rb") as f:
        for chunk in iter(lambda: f.read(1 << 16), b""):
            h.update(chunk)
    return h.hexdigest()


def import_all():
    con = open_src()
    rows = scoped_sessions(con)
    existing = {f[:-5] for f in os.listdir(TGT_DIR) if f.startswith("ses_") and f.endswith(".json")}
    before_hashes = {sid: sha256_file(f"{TGT_DIR}/{sid}.json") for sid in existing}

    imported, skipped, records = 0, 0, []
    for srow in rows:
        old_id = srow["id"]
        assert old_id != MAIN_ID, "MAIN must never be a v06 import source"
        new_id, doc = convert_session(con, old_id and srow)
        assert new_id != MAIN_ID
        rec = {
            "old": old_id,
            "new": new_id,
            "title": doc["info"]["title"],
            "messages": len(doc["messages"]),
            "parts": sum(len(m["parts"]) for m in doc["messages"]),
            "todos": len(doc.get("todo", [])),
        }
        if old_id in existing:
            skipped += 1
            rec["skipped"] = True
        elif new_id in existing:
            skipped += 1
            rec["skipped"] = True
            rec["note"] = "minted id already exists in target"
        else:
            atomic_write_json(f"{TGT_DIR}/{new_id}.json", doc)
            imported += 1
        records.append(rec)

    flat = {r["old"]: r["new"] for r in records}
    payload = {
        "generated": datetime.now(timezone.utc).astimezone().isoformat(timespec="seconds"),
        "source_db": SRC_DB,
        "target_dir": TGT_DIR,
        "cutover_ms": CUTOVER_MS,
        "scope": "parent_id IS NULL AND time_created < cutover",
        "note": "new ids are deterministic sha256('v06-import:v1:'+old)[:32]; source ids preserved in v06id",
        "sessions": records,
        "map": flat,
    }
    os.makedirs(LAB, exist_ok=True)
    atomic_write_json(MAP_PATH, payload)

    # sacred-file check: every file that existed before must be byte-identical now
    tampered = [sid for sid, h in before_hashes.items()
                if not os.path.exists(f"{TGT_DIR}/{sid}.json")
                or sha256_file(f"{TGT_DIR}/{sid}.json") != h]
    print(f"scope={len(rows)} imported={imported} skipped={skipped} "
          f"preexisting={len(existing)} tampered={tampered or 'NONE'}")
    if tampered:
        print("FATAL: pre-existing store files changed — refusing to report success")
        sys.exit(1)


def verify():
    con = open_src()
    rows = scoped_sessions(con)
    m = json.load(open(MAP_PATH))
    flat = m["map"]
    stats = {r["old"]: r for r in m["sessions"]}

    mismatches = []
    n_msg_t = n_msg_s = 0
    for srow in rows:
        old_id = srow["id"]
        new_id = flat.get(old_id)
        if not new_id:
            mismatches.append((old_id, "missing from map"))
            continue
        path = f"{TGT_DIR}/{new_id}.json"
        if not os.path.exists(path):
            mismatches.append((old_id, "missing target file"))
            continue
        doc = json.load(open(path))
        info = doc["info"]
        src_msgs = con.execute("SELECT count(*) FROM message WHERE session_id=?",
                               (old_id,)).fetchone()[0]
        src_parts = con.execute("SELECT count(*) FROM part p JOIN message m ON m.id=p.message_id "
                                "WHERE m.session_id=?", (old_id,)).fetchone()[0]
        tgt_msgs = len(doc["messages"])
        tgt_parts = sum(len(x["parts"]) for x in doc["messages"])
        n_msg_s += src_msgs
        n_msg_t += tgt_msgs
        problems = []
        if info.get("v06id") != old_id:
            problems.append("v06id")
        if info.get("archived") is not True:
            problems.append("archived")
        if not info.get("title", "").startswith(TITLE_PREFIX):
            problems.append("title-prefix")
        if tgt_msgs != src_msgs:
            problems.append(f"msg-count {src_msgs}!={tgt_msgs}")
        if tgt_parts != src_parts:
            problems.append(f"part-count {src_parts}!={tgt_parts}")
        src_todos = con.execute("SELECT count(*) FROM todo WHERE session_id=?",
                                (old_id,)).fetchone()[0]
        if len(doc.get("todo", [])) != src_todos:
            problems.append(f"todo-count {src_todos}!={len(doc.get('todo', []))}")
        if problems:
            mismatches.append((old_id, "; ".join(problems)))
        if stats.get(old_id, {}).get("new") != new_id:
            mismatches.append((old_id, "map detail mismatch"))

    # spot-check: [WEBSITE] session first+last message text identical
    web_old = "ses_f2792deedffevKWJ1HExyUUOgG"
    web_new = flat.get(web_old)
    web_ok = False
    if web_new:
        def firstlast_text(sid, via_map):
            if via_map:
                doc = json.load(open(f"{TGT_DIR}/{flat[sid]}.json"))
                msgs = doc["messages"]
            else:
                mids = [r[0] for r in con.execute(
                    "SELECT id FROM message WHERE session_id=? ORDER BY time_created, id", (sid,))]
                msgs = []
                for mid in mids:
                    data = json.loads(con.execute(
                        "SELECT data FROM message WHERE id=?", (mid,)).fetchone()[0])
                    msgs.append({"parts": load_parts(con, mid), "_data": data})
            def text_of(msg):
                return "\n".join(p.get("text", "") for p in msg["parts"] if p.get("type") == "text")
            return text_of(msgs[0]), text_of(msgs[-1])
        s_first, s_last = firstlast_text(web_old, via_map=False)
        t_first, t_last = firstlast_text(web_old, via_map=True)
        web_ok = (s_first == t_first) and (s_last == t_last)
        if not web_ok:
            mismatches.append((web_old, "website first/last text mismatch"))

    files_now = [f for f in os.listdir(TGT_DIR) if f.startswith("ses_") and f.endswith(".json")]
    print(f"VERIFY sessions={len(rows)} msg src={n_msg_s} tgt={n_msg_t} "
          f"{'OK' if n_msg_s == n_msg_t else 'MISMATCH'}")
    print(f"VERIFY website({web_new}) first+last text identical: {web_ok}")
    print(f"VERIFY target files now: {len(files_now)} (pre-existing 130 + imported {len(flat)} expected={130 + len(flat)})")
    print(f"VERIFY mismatches: {len(mismatches)}")
    for x in mismatches[:20]:
        print("  MISMATCH:", x)
    return 0 if (not mismatches and n_msg_s == n_msg_t and web_ok) else 1


if __name__ == "__main__":
    mode = sys.argv[1] if len(sys.argv) > 1 else ""
    if "--dry-run" in mode:
        con = open_src()
        rows = scoped_sessions(con)
        withm = sum(1 for r in rows if con.execute(
            "SELECT 1 FROM message WHERE session_id=? LIMIT 1", (r["id"],)).fetchone())
        msgs = con.execute(
            "SELECT count(*) FROM message m JOIN session s ON s.id=m.session_id "
            "WHERE s.parent_id IS NULL AND s.time_created < ?", (CUTOVER_MS,)).fetchone()[0]
        print(f"DRY scope sessions={len(rows)} (with messages={withm}) messages={msgs}")
    elif "--verify" in mode:
        sys.exit(verify())
    else:
        import_all()
