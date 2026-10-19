/**
 * BUILD-TIME ONLY: `next build` from a shell with no JIT.
 *
 * A session spawned under a unit with MemoryDenyWriteExecute=yes (the brain's
 * hardening, lab/yggdrasil/ASSESSMENT.md) can't JIT: node must run --jitless,
 * and V8 then has no WebAssembly. The build only meets WASM in two places:
 *   1. webpack / loader-utils hashing (xxhash64, md4 — chunk + font file names)
 *   2. the bundled edge-runtime undici's HTTP parser, built eagerly at load
 *      (nothing at build time sends HTTP; this app has no edge code)
 * This shim keeps the hardening and stands in for both:
 *   1. any module → one instance with the wasm-hash ABI (init / update(n) /
 *      final(n) over `memory`, hex digest written at offset 0), backed by
 *      native sha256. Build hashes only need to be deterministic.
 *   2. compile()/instantiate() never settle: undici loads; anything that REALLY
 *      needed it would hang visibly (and print below), never run wrong.
 * Usage: NODE_OPTIONS="--jitless --require <this file>" npm run build
 */
if (typeof WebAssembly === 'undefined') {
  const { createHash } = require('node:crypto');
  const MEM = 1 << 20; // wasm-hash reads Buffer.from(memory.buffer, 0, 65536)
  function Instance() {
    const memory = { buffer: new ArrayBuffer(MEM) };
    const mem = Buffer.from(memory.buffer);
    let h = createHash('sha256');
    this.exports = {
      memory,
      init() {
        h = createHash('sha256');
      },
      update(n) {
        h.update(mem.subarray(0, n));
      },
      final(n) {
        h.update(mem.subarray(0, n));
        mem.write(h.digest('hex'), 0, 'latin1'); // readers take digestSize chars
      },
    };
  }
  const never = (what) => () => {
    console.warn(`[jitless-wasm-shim] WebAssembly.${what} — async WASM is not available in a jitless node`);
    return new Promise(() => {});
  };
  globalThis.WebAssembly = {
    Module: function Module() {},
    Instance,
    compile: never('compile'),
    instantiate: never('instantiate'),
    validate: () => false,
  };
}
