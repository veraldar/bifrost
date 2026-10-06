/**
 * LAB BUILD ONLY (gated on ?labmic=1): inject USER-AGI's looping wav as the
 * microphone, so the full hands-free loop simulates on a headless emulator
 * with no real audio hardware. Production phones use real microphones and
 * never set the flag. Installed at module load — before livekit connects —
 * and survives navigations because every page re-runs it when flagged.
 */
if (typeof window !== 'undefined' && localStorage.getItem('labmic') === '1') {
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
