/**
 * LAB BUILD ONLY: inject USER-AGI's looping wav as the microphone, so the full
 * voice loop simulates on a headless emulator with no real audio hardware.
 *
 * Two keys, both required, neither one sticky:
 *   build  NEXT_PUBLIC_LABMIC=1 at `npm run build` — never set for a build a
 *          person talks to (10-14: the sandbox build armed this for EVERY
 *          device that held the tree; the user's phone sent the lab wav
 *          instead of their voice, and STT never heard them)
 *   page   ?labmic=1 in the URL of this page load
 * A `labmic` key left in localStorage by the old build is cleared at first
 * paint on every page (app/layout.tsx boot script) — this module never reads it.
 */
const LAB_BUILD = process.env.NEXT_PUBLIC_LABMIC === '1';

if (
  LAB_BUILD &&
  typeof window !== 'undefined' &&
  new URLSearchParams(window.location.search).get('labmic') === '1'
) {
  const orig = navigator.mediaDevices.getUserMedia.bind(navigator.mediaDevices);
  navigator.mediaDevices.getUserMedia = async (c) => {
    if (!c || !c.audio) return orig(c);
    const ac = new (window.AudioContext || (window as any).webkitAudioContext)();
    const buf = await ac.decodeAudioData(await (await fetch('/user-agi.wav')).arrayBuffer());
    const src = ac.createBufferSource();
    src.buffer = buf;
    src.loop = true;
    const dst = ac.createMediaStreamDestination();
    src.connect(dst);
    src.start();
    return dst.stream;
  };
}
export {};
