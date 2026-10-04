# Runbook — tonight's lambda test: pairing + hands-free on a real iPhone

**The test:** she (first-time user, her own iPhone) pairs with one scan, lands on MAIN, and
talks to the box hands-free — the answers come back out loud. You run the box, and you check
hands-free on your own phone too. About 20 minutes. The contract behind this page is
`docs/spec-pairing.md`; what is proven and what is not is in `RELEASE-REPORT.md`.

**The box:** omarchy. Wi-Fi address **192.168.1.89**, so her address is
`http://192.168.1.89:8080`. The router hands out that address and it can change: re-check
with `ip -4 addr show wlp3s0`. Use the Wi-Fi address, never the wired one (that cable only
goes to the Mac Studio). Lines marked **[VERIFY AT DEPLOY]** depend on setup that is not
live yet.

## Know these two things first

1. **The word "over" sends.** Going quiet sends nothing. She talks, then ends with the word
   **"over"**, or taps the moving bars. The phone thinks, says the answer out loud, then
   listens again. **"over and out"** sends and stops hands-free; that last answer is shown,
   not spoken. The keyword is the English word "over", whatever language she speaks. Tell her
   before she starts. The screen says it too: *hands-free · say “over” or tap the bars to send*.
2. **The mic only opens on an https page.** iPhone Safari blocks the microphone on plain
   `http://` pages, and https on the home network isn't built yet (RELEASE-REPORT, "Skipped
   or partial" #3). On `http://192.168.1.89:8080` she can pair and type, but she can't talk.
   To talk, her phone uses the https address your phone already uses (the tailnet one):

| route | her iPhone needs | pair | type | talk |
|---|---|---|---|---|
| **A** home Wi-Fi only (new, no Tailscale) | nothing | yes | yes | **no** |
| **B** Tailscale app, joined to your tailnet | the app, switched on | not needed tonight | yes | **yes** |

**Plan:** do A first. It takes 2 minutes and is the first pairing on a real iPhone (the
release only tested an emulated one). Then do B for hands-free. Short on time? Do B only:
hands-free is the point of tonight.

## Before she arrives (at the box, ~10 min)

1. **Running:** `systemctl --user is-active lk-pwa lk-agent yggdrasil` → `active` three
   times. Bridge: `systemctl --user status bifrost-bridge` → active **[VERIFY AT DEPLOY]**.
   It isn't installed yet. Without it, pairing still works, `/pair` shows "bridge
   unreachable — HTTP pairing only", and nothing tonight needs the bridge.
2. **One brain for typing and talking:**
   `grep OPENCODE_URL ~/Work/bifrost/pwa/.env.local ~/Work/bifrost/agent/.env` → both say
   `http://127.0.0.1:4100` (yggdrasil → zai) **[VERIFY AT DEPLOY]**. Today the app says
   `:4096` and the voice agent says `:4100`. Then what she says goes to one brain while her
   screen reads the other, and she sees "no reply". Fix both lines, then
   `systemctl --user restart lk-pwa lk-agent`.
3. **Mode + pairing:** `BIFROST_AUTH=tailnet` **[VERIFY AT DEPLOY]** in `pwa/.env.local`,
   with the pairing endpoints live. Don't switch to `devices` tonight: in devices mode this
   build refuses voice (`/api/token`). Check:
   `curl -s -X POST http://127.0.0.1:8080/api/pair/code | jq -r .url` → it should start with
   `http://192.168.1.89:8080/pair#v=1&code=bfnp-`.
   - Shows `127.0.0.1`? Set `BIFROST_PUBLIC_URL=http://192.168.1.89:8080` in
     `pwa/.env.local` **[VERIFY AT DEPLOY]** and restart lk-pwa.
   - Error or blank? lk-pwa is down, or the deployed build has no pairing yet.

   The check mints a spare code, which expires unused after 5 minutes.
4. **Route A: let the home Wi-Fi in [VERIFY AT DEPLOY].** Today lk-pwa only answers the box
   itself (`next start -H 127.0.0.1`), and the firewall drops everything coming in from the
   Wi-Fi (only LocalSend is let in).
   - In `~/.config/systemd/user/lk-pwa.service`, change `-H 127.0.0.1` to `-H 0.0.0.0`.
     Then run `systemctl --user daemon-reload && systemctl --user restart lk-pwa`.
     `ss -tln | grep ':8080 '` should now show `0.0.0.0:8080`.
   - Open the firewall: `sudo ufw allow from 192.168.1.0/24 to any port 8080 proto tcp`.
   - Proof: on your phone, with Tailscale off and on the same Wi-Fi,
     `http://192.168.1.89:8080` loads.
5. **Route B: her phone joins [VERIFY AT DEPLOY].** Install the Tailscale app on her
   iPhone. In the Tailscale admin page, open Machines → omarchy → Share and send her the
   invite; she accepts it in the app. Proof: your box's https address loads on her phone.
6. **Voice chain:** on your phone, in your usual conversation, do one round of the hands-free
   steps below ("say hello in one sentence, over"). If you hear the answer, LiveKit, the speech
   models, yggdrasil and zai are all up.

## Pair her phone (route A)

1. Box: open `http://192.168.1.89:8080/pair`. A QR appears: one use, five minutes, and it
   renews itself.
2. Her iPhone, on the home Wi-Fi: open Camera, point it at the QR, tap the yellow link.
3. Safari shows "pairing…", then "paired as iPhone — opening MAIN". She's in MAIN without
   typing anything.
4. Box: `http://192.168.1.89:8080/devices` lists "iPhone".
5. Keep her in Safari. No "Add to Home Screen" tonight: the home-screen app keeps its own
   cookies, and nobody has tested whether the pairing carries over.

## Talk hands-free (route B; the same steps on your phone, in YOUR conversation)

1. Send her the box's https address (AirDrop or a message). She opens it in Safari and taps
   **main**, or starts a new conversation. Turn the volume up and keep the screen on: a
   locked phone stops listening.
2. Tap the mic at the bottom right, once and quickly. Holding it does push-to-talk instead.
3. First time only: Safari asks for the microphone → **Allow**.
4. The bottom bar turns into moving bars and a timer: *hands-free · say “over” or tap the
   bars to send*.
5. She asks a question and ends with **"over"**. The screen shows *working on it · mic
   paused*, then the answer plays (*speaking · mic returns when it ends*). When the bars come
   back, she can ask the next one.
6. To stop: while it's listening, tap the **red square** next to the bars, or say **"over
   and out"** at any time. While hands-free is on, the bars take the mic button's place.
   Tapping the bars sends; it doesn't stop.
7. Typing works too. In keyboard mode, tap the message box, type, and tap send.

Never have two phones hands-free in the same conversation: they knock each other out.

## If something goes wrong

| what you see | fix |
|---|---|
| Phone: "this code was already used" (or "expired") | Reload `/pair` on the box to get a fresh QR, and scan again. One QR = one phone, once. |
| Box `/pair`: "pairing codes come from the box itself" | Open `http://127.0.0.1:8080/pair` on the box instead. The QR still carries the Wi-Fi address. |
| Page won't load, or a "region" message | Her phone left the home Wi-Fi (mobile data, guest network). Join the home Wi-Fi and reload. "Region" means which network, not where she is. A network change usually signs her back in by itself; if not, scan a fresh QR. |
| Mic tap fails or snaps back to the keyboard | She's on the `http://` address: use route B. On https with "microphone blocked": in Safari tap **aA** → Website Settings → Microphone → Allow, then reload. |
| "voice agent missing from the room" | `systemctl --user restart lk-agent`, wait 10 s, tap the mic again. |
| Bars move but nothing is sent | She didn't end with "over". Say it clearly as the last word, or tap the bars. |
| "working on it", then no reply | `journalctl --user -u lk-agent -n 20` and `journalctl --user -u yggdrasil -n 20`. `keyword commit (over)` means her words arrived; errors after that point to the brain. Most common cause: before-step 2. |
| Phone lost, or "this device is not paired" | Revoke it on `/devices`, then re-pair from `/pair`. |
| Panic | Box `/devices` → **sever all bridges** → confirm. Every device is revoked, every code is burned, and live bridge links drop within a second. Re-pair from scratch. Tonight's tailnet mode doesn't lock the app per device, so also run `systemctl --user stop lk-pwa` (`start` to undo). Route B: also unshare the box in Tailscale. |

## What good looks like (tick during the test)

- [ ] One scan puts MAIN on her phone with nothing typed; `/devices` lists "iPhone".
- [ ] One quick tap shows the bars and the timer; Safari asks for the mic once at most.
- [ ] A question plus "over" gets a spoken answer, and the bars come back by themselves (note the seconds).
- [ ] Three questions in a row with no help from you; the red square or "over and out" ends it.
- [ ] Your own phone does the same in your own conversation.

## After

- Route A: `sudo ufw delete allow from 192.168.1.0/24 to any port 8080 proto tcp`, and set
  lk-pwa back to `-H 127.0.0.1`. In tailnet mode, anyone who can reach port 8080 gets in.
- Route B: unshare the box in the Tailscale admin page if the share was only for tonight.
- Write down where she hesitated, in her own words. That's the real result of tonight.
