#!/usr/bin/env node
/**
 * onboard-voice — render the onboarding voice pack from THE script.
 *
 *   node scripts/onboard-voice.mjs [--force] [--only greet,lang] [--lang en|fr]
 *   (inside a MemoryDenyWriteExecute cgroup: node --jitless …)
 *
 * In   pwa/lib/onboard-script.json        (one source: app door + veraldar.org door)
 * Out  pwa/public/onboarding/<lang>/<id>.mp3 + pwa/public/onboarding/manifest.json
 *
 * Voice = the app's own voice, read from the app's env (pwa/.env.local, else
 * ~/.config/bifrost/env/live-pwa.env):
 *   en  TTS_VOICE_EN (af_heart) — Kokoro-82M v1.0. Rendered on the LOCAL speech
 *       server (127.0.0.1:8000, ONNX build of the same weights + voice the Mac
 *       runs as mlx-community/Kokoro-82M-bf16): no load on the Mac.
 *   fr  TTS_MODEL_FR / TTS_VOICE_FR (Elise-v2) — exists only on the Mac (SPEACHES_URL),
 *       through the same /audio/speech_stream call + sampling params the app's
 *       /api/tts/stream route makes. Sampled → several pinned seeds, best kept.
 * Referee: every render is transcribed back (STT_MODEL on SPEACHES_URL,
 * Qwen3-ASR) and scored against its text; the score lands in the manifest.
 * Only lines whose text/model/voice changed re-render (sha in the manifest).
 * The Mac runs ONE generation at a time — renders go strictly one by one.
 */
import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { homedir, tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const SCRIPT = join(ROOT, 'pwa/lib/onboard-script.json');
const OUT = join(ROOT, 'pwa/public/onboarding');
const MANIFEST = join(OUT, 'manifest.json');

const argv = process.argv.slice(2);
const FORCE = argv.includes('--force');
const ONLY = (argv[argv.indexOf('--only') + 1] || '').split(',').filter(Boolean);
const LANGS = argv.includes('--lang') ? [argv[argv.indexOf('--lang') + 1]] : ['en', 'fr'];
if (!argv.includes('--only')) ONLY.length = 0;

function readEnv(file) {
  const env = {};
  if (!existsSync(file)) return env;
  for (const l of readFileSync(file, 'utf8').split('\n')) {
    const m = /^([A-Z0-9_]+)=(.*)$/.exec(l.trim());
    if (m) env[m[1]] = m[2].replace(/^["']|["']$/g, '');
  }
  return env;
}
const appEnv = {
  ...readEnv(join(homedir(), '.config/bifrost/env/live-pwa.env')),
  ...readEnv(join(ROOT, 'pwa/.env.local')),
};
const MAC = process.env.OB_FR_URL || appEnv.SPEACHES_URL;
const CFG = {
  en: {
    url: process.env.OB_EN_URL || 'http://127.0.0.1:8000/v1',
    server: 'local speaches (onnx)',
    model: process.env.OB_EN_MODEL || 'speaches-ai/Kokoro-82M-v1.0-ONNX',
    voice: appEnv.TTS_VOICE_EN || 'af_heart',
    seeds: [null], // Kokoro is deterministic
  },
  fr: {
    url: MAC,
    server: 'mac mlx (the app path)',
    model: appEnv.TTS_MODEL_FR,
    voice: appEnv.TTS_VOICE_FR,
    lang: appEnv.TTS_LANG_FR || 'french',
    seeds: [7, 11, 23, 42],
  },
};
const ASR = {
  url: process.env.OB_ASR_URL || MAC,
  model: process.env.OB_ASR_MODEL || 'mlx-community/Qwen3-ASR-1.7B-8bit',
};

const sha = (s) => createHash('sha256').update(s).digest('hex').slice(0, 16);

function wav(pcm, rate = 24000) {
  const h = Buffer.alloc(44);
  h.write('RIFF', 0);
  h.writeUInt32LE(36 + pcm.length, 4);
  h.write('WAVEfmt ', 8);
  h.writeUInt32LE(16, 16);
  h.writeUInt16LE(1, 20); // PCM
  h.writeUInt16LE(1, 22); // mono
  h.writeUInt32LE(rate, 24);
  h.writeUInt32LE(rate * 2, 28);
  h.writeUInt16LE(2, 32);
  h.writeUInt16LE(16, 34);
  h.write('data', 36);
  h.writeUInt32LE(pcm.length, 40);
  return Buffer.concat([h, pcm]);
}

/** HTTP through curl: node's fetch needs WebAssembly (undici's llhttp), and
 *  node --jitless (MemoryDenyWriteExecute cgroups) has none */
function curl(args, timeoutS) {
  return execFileSync('curl', ['-sS', '--fail-with-body', '-m', String(timeoutS), ...args], {
    maxBuffer: 64 * 1024 * 1024,
  });
}

function render(lang, text, seed) {
  const c = CFG[lang];
  if (lang === 'en') {
    return curl(
      [
        '-H', 'content-type: application/json',
        '-d', JSON.stringify({ model: c.model, voice: c.voice, input: text, response_format: 'wav' }),
        `${c.url}/audio/speech`,
      ],
      60
    );
  }
  // the app's /api/tts/stream body, verbatim (route.ts) — same voice by construction;
  // the Mac streams raw int16 PCM at 24 kHz (X-Sample-Rate)
  const pcm = curl(
    [
      '-H', 'content-type: application/json',
      '-d',
      JSON.stringify({
        model: c.model,
        voice: c.voice,
        lang_code: c.lang,
        temperature: 0.2,
        top_k: 20,
        repetition_penalty: 1.3,
        streaming_interval: 4.0,
        seed,
        input: text,
      }),
      `${c.url}/audio/speech_stream`,
    ],
    240 // a cold Elise load took >90 s on 10-19
  );
  return wav(pcm, 24000);
}

/** the referee hears what ships: the final mp3, decoded back (the Mac's ASR
 *  takes wav, not mp3) */
function transcribe(file, lang) {
  if (!ASR.url) return null;
  try {
    const back = file.replace(/\.mp3$/, '.heard.wav');
    execFileSync('ffmpeg', ['-v', 'error', '-y', '-i', file, '-ar', '16000', back]);
    const out = curl(
      ['-F', `file=@${back}`, '-F', `model=${ASR.model}`, '-F', `language=${lang}`, `${ASR.url}/audio/transcriptions`],
      60
    );
    return String(JSON.parse(out.toString()).text || '').trim();
  } catch {
    return null;
  }
}

// silent plural endings are homophones in French (réponses courtes = réponse
// courte, détail = détails) — the referee catches garbled audio, not grammar
const words = (s) =>
  s
    .toLowerCase()
    .normalize('NFC')
    .replace(/[^\p{L}\p{N}' ]+/gu, ' ')
    .split(/\s+/)
    .filter(Boolean)
    .map((w) => (w.length > 3 ? w.replace(/[sx]$/, '') : w));
/** share of the script's words the transcript gives back (order-free) */
function score(text, heard) {
  if (heard == null) return null;
  const pool = words(heard);
  const want = words(text);
  let hit = 0;
  for (const w of want) {
    const i = pool.indexOf(w);
    if (i >= 0) {
      hit++;
      pool.splice(i, 1);
    }
  }
  return want.length ? Math.round((hit / want.length) * 100) / 100 : 1;
}

/** trim lead/tail silence (50 ms lead kept), mono 24 kHz mp3 @ 48 kbps */
function encode(wavFile, mp3File) {
  execFileSync('ffmpeg', [
    '-v', 'error', '-y', '-i', wavFile,
    '-af',
    'silenceremove=start_periods=1:start_threshold=-50dB:start_silence=0.05,areverse,silenceremove=start_periods=1:start_threshold=-50dB:start_silence=0.12,areverse',
    '-ac', '1', '-ar', '24000', '-b:a', '48k', mp3File,
  ]);
  const ms = Math.round(
    Number(
      execFileSync('ffprobe', ['-v', 'error', '-show_entries', 'format=duration', '-of', 'csv=p=0', mp3File])
        .toString()
        .trim()
    ) * 1000
  );
  return ms;
}

const script = JSON.parse(readFileSync(SCRIPT, 'utf8'));
const prev = existsSync(MANIFEST) ? JSON.parse(readFileSync(MANIFEST, 'utf8')) : { lines: {} };
const manifest = {
  version: script.version,
  generated: new Date().toISOString(),
  // a language this run doesn't render keeps the voice its files were made with
  voices: Object.fromEntries(
    ['en', 'fr'].map((l) => [
      l,
      !LANGS.includes(l) && prev.voices?.[l]
        ? prev.voices[l]
        : { server: CFG[l].server, model: CFG[l].model, voice: CFG[l].voice },
    ])
  ),
  referee: `${ASR.model} — score = share of script words heard back`,
  lines: {},
};
const tmp = join(tmpdir(), `onboard-voice-${process.pid}`);
mkdirSync(tmp, { recursive: true });
let made = 0;
let kept = 0;
const weak = [];
for (const line of script.lines) {
  const entry = { on: line.on };
  for (const lang of ['en', 'fr']) {
    const text = line[lang];
    if (!text) continue;
    const c = CFG[lang];
    const key = sha(`${text}|${c.model}|${c.voice}`);
    const file = `${lang}/${line.id}.mp3`;
    const old = prev.lines?.[line.id]?.[lang];
    const wanted = LANGS.includes(lang) && (!ONLY.length || ONLY.includes(line.id));
    if (!wanted || (!FORCE && old && old.sha === key && existsSync(join(OUT, file)))) {
      if (old) entry[lang] = old;
      kept++;
      continue;
    }
    mkdirSync(join(OUT, lang), { recursive: true });
    let best = null;
    for (const seed of c.seeds) {
      const raw = join(tmp, `${line.id}-${lang}-${seed}.wav`);
      const mp3 = join(tmp, `${line.id}-${lang}-${seed}.mp3`);
      const t0 = Date.now();
      writeFileSync(raw, render(lang, text, seed));
      const ms = encode(raw, mp3);
      const heard = transcribe(mp3, lang);
      const s = score(text, heard);
      console.log(
        `${lang} ${line.id.padEnd(12)} seed=${String(seed).padEnd(4)} ${String(ms).padStart(5)}ms render+asr ${Date.now() - t0}ms score=${s} heard="${heard}"`
      );
      if (!best || (s ?? 0) > (best.score ?? 0)) best = { mp3, ms, seed, heard, score: s };
      if (s == null || s >= 0.9) break; // good enough — keep the earliest pinned seed
    }
    const dst = join(OUT, file);
    writeFileSync(dst, readFileSync(best.mp3));
    entry[lang] = {
      text,
      sha: key,
      file,
      ms: best.ms,
      bytes: readFileSync(dst).length,
      seed: best.seed,
      heard: best.heard,
      score: best.score,
    };
    if ((best.score ?? 0) < 0.8) weak.push(`${lang}/${line.id} (${best.score})`);
    made++;
  }
  manifest.lines[line.id] = entry;
}
rmSync(tmp, { recursive: true, force: true });
writeFileSync(MANIFEST, JSON.stringify(manifest, null, 2) + '\n');
const all = Object.values(manifest.lines).flatMap((e) => [e.en, e.fr].filter(Boolean));
console.log(
  `\n${made} rendered, ${kept} current · ${all.length} files, ${Math.round(all.reduce((a, f) => a + f.bytes, 0) / 1024)} KiB` +
    (weak.length ? ` · WEAK (score < 0.8 or not refereed): ${weak.join(', ')}` : ' · referee: every line heard back ≥ 0.8')
);
