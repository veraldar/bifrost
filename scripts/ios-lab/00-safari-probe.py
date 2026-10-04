#!/usr/bin/env python3
"""ios-lab probe A — Mac Safari shared-layer validation for the bifrost PWA.

Drives safaridriver (WebDriver) on the Mac over SSH-stdin and checks the
layer every PWA install sits on: HTTPS secure context, web app manifest
(parse + icon sizes — the android-lab install blocker was <192px), service
worker support + registration. Runs ON the Mac (the tailnet member).

Usage (from the box):  ssh mac 'python3 -' < scripts/ios-lab/00-safari-probe.py
Env: PWA_URL (default the tailscale serve URL from deploy docs).
"""
import json, subprocess, sys, time, urllib.request

PWA_URL = "https://omarchy.tail5435b1.ts.net/"

def wd(method, path, body=None, port=4519):
    req = urllib.request.Request(
        f"http://127.0.0.1:{port}{path}", method=method,
        data=json.dumps(body).encode() if body is not None else None,
        headers={"Content-Type": "application/json"})
    return json.load(urllib.request.urlopen(req, timeout=30))

def main():
    drv = subprocess.Popen(["safaridriver", "-p", str(4519)],
                           stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
    time.sleep(2)
    try:
        caps = {"capabilities": {"alwaysMatch": {"browserName": "safari"}}}
        sid = wd("POST", "/session", caps)["value"]["sessionId"]
        wd("POST", f"/session/{sid}/url", {"url": PWA_URL})
        time.sleep(4)  # SW registration is async after load
        checks = wd("POST", f"/session/{sid}/execute/sync", {"script": """
            const [cb] = arguments;
            (async () => {
              const out = {};
              out.url = location.href;
              out.secureContext = window.isSecureContext;
              out.serviceWorker = 'serviceWorker' in navigator;
              try {
                const reg = await navigator.serviceWorker.getRegistration();
                out.swRegistered = !!reg;
              } catch (e) { out.swRegistered = 'error: ' + e.message; }
              const link = document.querySelector('link[rel="manifest"]');
              out.manifestHref = link ? link.href : null;
              if (link) {
                const m = await (await fetch(link.href)).json();
                out.manifestName = m.name || m.short_name;
                out.iconSizes = (m.icons || []).map(i => i.sizes).sort();
                out.has192 = (m.icons || []).some(i => /(^|\\s)192/.test(i.sizes));
                out.has512 = (m.icons || []).some(i => /(^|\\s)512/.test(i.sizes));
              }
              out.standalone = 'standalone' in navigator;
              cb(JSON.stringify(out));
            })().catch(e => cb(JSON.stringify({fatal: e.message})));
        """, "args": []})["value"]
        r = json.loads(checks)
        print(json.dumps(r, indent=2))
        ok = (r.get("secureContext") and r.get("swRegistered") is True
              and r.get("has192") and r.get("has512"))
        print("PROBE-A:", "PASS" if ok else "FAIL — fix the false fields above")
        wd("DELETE", f"/session/{sid}")
    finally:
        drv.terminate()

if __name__ == "__main__":
    main()
