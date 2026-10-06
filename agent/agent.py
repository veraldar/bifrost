"""LiveKit voice agent bridging phone audio to a local opencode server."""

import asyncio
import os
import re
from typing import AsyncIterable

import httpx
import logging
from dotenv import load_dotenv
from livekit import plugins
from livekit.agents import (
    Agent,
    AgentServer,
    AgentSession,
    JobContext,
    RoomInputOptions,
    cli,
    llm,
)
from livekit.agents.llm import ChatContext, LLMStream
from livekit.agents.voice.room_io import RoomOptions
from livekit.agents.voice.room_io.types import RoomOutputOptions
from livekit.plugins import openai, silero

load_dotenv()

logger = logging.getLogger("opencode-bridge")

OPENCODE_URL = os.environ.get("OPENCODE_URL", "http://127.0.0.1:4096")
VOICE_MODEL = os.environ.get("VOICE_MODEL", "opencode/ling-3.0-flash-fin-free")
SPEACHES_URL = os.environ.get("SPEACHES_URL", "http://127.0.0.1:8000/v1")
STT_MODEL = os.environ.get("STT_MODEL", "Systran/faster-whisper-small")
TTS_MODEL = os.environ.get("TTS_MODEL", "speaches-ai/Kokoro-82M-v1.0-ONNX")
TTS_VOICE = os.environ.get("TTS_VOICE", "af_heart")
INSTRUCTIONS = (
    "You relay the user's spoken words to a coding assistant and speak its answers. "
    "Answers arrive as text from opencode; speak them verbatim unless asked to summarize. "
    "Keep spoken replies concise: code is described, not read character by character."
)

# whisper-small hallucinates on silence/room tone — these strings as an ENTIRE
# turn are noise, not speech (seen live: "you" and "呃" committed after a
# quiet stretch). Matched lowercase, punctuation stripped.
_SILENCE_HALLUCINATIONS = {
    "you",
    "bye",
    "uh",
    "um",
    "hmm",
    "mm",
    "mhm",
    "mm-hmm",
    "uh-huh",
    "uh huh",
    "thank you",
    "thanks for watching",
    "呃",
    "嗯",
    "啊",
}


def _is_noise_turn(text: str) -> bool:
    # punctuation → space (so "uh-huh" == "uh huh"), keep letters + CJK
    norm = re.sub(r"[^a-z0-9\u4e00-\u9fff]+", " ", text.lower()).strip()
    return len(norm) < 2 or norm in _SILENCE_HALLUCINATIONS


class OpenCodeLLM(llm.LLM):
    """Bridges LiveKit chat to opencode's REST server (one session per room).

    Room name = slug of the session name; the opencode session with a matching
    title is reused, or created on first use.
    """

    def __init__(self, base_url: str, room_key: str = "voice") -> None:
        super().__init__()
        self._base = base_url.rstrip("/")
        self._room_key = room_key.lower()
        self._session_id: str | None = None
        # last full (cumulative) voice prompt posted for this room — hands-free
        # VAD re-commits turns as A, A+B, A+B+C… while the previous reply is
        # still playing; only the delta may reach opencode (see _run)
        self.last_prompt = ""

    @staticmethod
    def _slugify(title: str) -> str:
        import re
        return (
            re.sub(r"[^a-z0-9_-]", "", (title or "").lower().strip().replace(" ", "-"))[:60]
            or "session"
        )

    async def _ensure_session(self) -> str:
        if self._session_id is None:
            async with httpx.AsyncClient() as c:
                r = await c.get(f"{self._base}/session")
                r.raise_for_status()
                for s in r.json():
                    if self._slugify(s.get("title") or "") == self._room_key or s.get("id") == self._room_key:
                        self._session_id = s["id"]
                        break
                else:
                    r = await c.post(
                        f"{self._base}/session",
                        json={"title": self._room_key},
                    )
                    r.raise_for_status()
                    self._session_id = r.json()["id"]
                # seed the session model ONCE (only when unset): ask() no
                # longer sends a model per turn (that clobbered the session's
                # model ref, think level included), so the seed makes voice
                # sessions start on VOICE_MODEL while a settings-page switch
                # stays authoritative afterwards
                s = (await c.get(f"{self._base}/session/{self._session_id}")).json()
                if not s.get("model"):
                    provider_id, model_id = VOICE_MODEL.split("/", 1)
                    r = await c.post(
                        f"{self._base}/api/session/{self._session_id}/model",
                        json={"model": {"id": model_id, "providerID": provider_id}},
                    )
                    r.raise_for_status()
            logger.info(f"opencode session for room {self._room_key!r}: {self._session_id}")
        return self._session_id

    async def ask(self, text: str) -> str:
        sid = await self._ensure_session()
        t0 = asyncio.get_running_loop().time()
        async with httpx.AsyncClient(timeout=300) as c:
            # no `model` in the body on purpose: sending one would clobber the
            # session's model every turn (opencode replaces the whole model
            # ref, think level included). Omitted → the runner uses the
            # session's current model: VOICE_MODEL seeds it once at session
            # creation (below), and a settings-page switch replaces it.
            try:
                r = await c.post(
                    f"{self._base}/session/{sid}/message",
                    json={"parts": [{"type": "text", "text": text}]},
                )
                r.raise_for_status()
            except Exception as e:  # noqa: BLE001 — 10-06: ask() failures were
                # swallowed by the caller's speech fallback and never logged;
                # the turn vanished with zero trace on either opencode
                logger.error("oc.ask FAILED sid=%s lat=%.2fs prompt=%r err=%s", sid, asyncio.get_running_loop().time() - t0, text[:60], e)
                raise
            data = r.json()
        reply = "\n".join(
            p.get("text", "") for p in data.get("parts", []) if p.get("type") == "text"
        ).strip() or "(opencode returned no text)"
        logger.info("oc.ask ok sid=%s lat=%.2fs reply=%d chars", sid, asyncio.get_running_loop().time() - t0, len(reply))
        return reply

    def chat(
        self,
        *,
        chat_ctx: ChatContext,
        tools=None,
        conn_options=None,
        **kwargs,
    ) -> LLMStream:
        return OpenCodeStream(
            llm=self, chat_ctx=chat_ctx, tools=tools, conn_options=conn_options
        )


class OpenCodeStream(LLMStream):
    def __init__(
        self,
        *,
        llm: OpenCodeLLM,
        chat_ctx: ChatContext,
        tools=None,
        conn_options=None,
    ) -> None:
        super().__init__(llm=llm, chat_ctx=chat_ctx, tools=tools, conn_options=conn_options)
        self._oc = llm

    async def _run(self) -> None:
        messages = self._chat_ctx.messages()
        logger.debug(
            "opencode chat_ctx: %s",
            [(m.role, (m.text_content or "")[:60]) for m in messages],
        )
        # only act on the newest turn: a PTT push with no recognized speech
        # must not re-send an earlier message to opencode
        last = messages[-1] if messages else None
        prompt = (last.text_content or "").strip() if last is not None and last.role == "user" else ""
        if not prompt:
            logger.info("opencode bridge: empty or absent user turn, skipping")
            return
        # the session can re-commit the SAME speech as a growing cumulative
        # turn (seen live 2026-09-25: one hands-free utterance flooded the
        # transcript with A, A+呃, A+呃+B…) — identical means already sent,
        # a strict extension means only the new tail is actually new
        prev = self._oc.last_prompt
        if prev and prompt == prev:
            logger.info("opencode bridge: duplicate cumulative turn, skipping")
            return
        send = prompt[len(prev) :].strip() if prev and prompt.startswith(prev) else prompt
        # update even when dropping: a discarded noise prefix must never
        # resurface later as the "new tail" of a cumulative re-commit
        self._oc.last_prompt = prompt
        # VAD fired on room tone and whisper turned the noise into a fill word
        # ("you", "呃") — a silent send with no real speech must not reach
        # opencode (defense in depth behind the VAD thresholds)
        if _is_noise_turn(send):
            logger.info("opencode bridge: dropping silent/noise turn: %r", send)
            return
        # keyword turn-taking: the commit phrase is protocol, not content —
        # never ship "over"/"over and out" to opencode
        send = re.sub(r"\s*over(?:\s+and\s+out)?[\s.!?]*$", "", send, flags=re.I).strip()
        if not send:
            logger.info("opencode bridge: turn was only the keyword, skipping")
            return
        try:
            reply = await self._oc.ask(send)
        except Exception as e:  # noqa: BLE001 - surface errors as speech
            reply = f"Sorry, talking to opencode failed: {e}"
        self._event_ch.send_nowait(
            llm.ChatChunk(id="opencode", delta=llm.ChoiceDelta(content=reply))
        )


# load_threshold: prod default is 0.7 against a load_fnc that reads the
# systemd USER-SLICE cgroup — it sums EVERY process on the box (other agent
# sessions, the PWA proxy, e2e runs) and produced "impossible cgroup cpu
# usage delta" warnings all through 10-06. Result: the worker flapped "at
# full capacity, marking as unavailable" with ZERO jobs running and silently
# dropped room dispatches — phone held PTT 17s, no agent ever joined, no STT
# event at all (pwa/.diag/stt-*.log empty, journal 18:13-18:14). Dev mode
# already runs inf; this is a single-tenant personal box, so the garbage
# metric must never gate availability (inf = never unavailable by load).
# host: the worker's HTTP (health) server listened on 0.0.0.0:8081 — the
# whole LAN could probe it. Loopback unless AGENT_HTTP_HOST says otherwise.
server = AgentServer(load_threshold=float("inf"), host=os.environ.get("AGENT_HTTP_HOST", "127.0.0.1"))

_voice_probe_started = False  # one Mac-endpoint probe task per process


AGENT_NAME = os.environ.get("AGENT_NAME", "bifrost")

@server.rtc_session(agent_name=AGENT_NAME)
async def entrypoint(ctx: JobContext) -> None:
    _api_key = "not-needed"
    session = AgentSession(
        # turn-taking is keyword-driven in hands-free (see below): turns never
        # auto-commit on silence — speech buffers until "over"/"over and out".
        # Manual is (re-)set after every PTT commit/abort too.
        vad=silero.VAD.load(min_silence_duration=0.9),
        # batch whisper needs 1-2s per segment: with the 0.5s default the
        # turn commits BEFORE the STT final lands (livekit logs "transcript
        # arrives after turn has been committed") and the speech is dropped
        turn_handling={"endpointing": {"min_delay": 1.5}},
        stt=openai.STT(base_url=SPEACHES_URL, api_key=_api_key, model=STT_MODEL),
        llm=OpenCodeLLM(OPENCODE_URL, room_key=ctx.room.name),
        tts=openai.TTS(base_url=SPEACHES_URL, api_key=_api_key, model=TTS_MODEL, voice=TTS_VOICE),
    )
    await session.start(
        room=ctx.room,
        # close_on_disconnect=False: the phone releases the room the moment a
        # PTT commit resolves (mic contract — capture device must go dark on
        # release), but the commit's flush → STT final → opencode handoff is
        # still in flight then. The default close killed the session mid-air
        # and dropped EVERY text-mode PTT turn (live 2026-09-29 room 'bug':
        # "closing agent session due to participant disconnect" + "skipping
        # user input, speech scheduling is paused" on each hold). We end the
        # job ourselves on human-left with a commit grace window instead.
        room_input_options=RoomInputOptions(text_enabled=True, close_on_disconnect=False),
        # the agent never speaks over the room: the phone speaks replies
        # itself through its own TTS (the "listen" voice) and drives the
        # mic on/off cycle — one voice path, no double synthesis
        room_options=RoomOptions(audio_output=RoomOutputOptions(audio_enabled=False)),
        agent=Agent(instructions=INSTRUCTIONS),
    )

    # explicit dispatch can double-fire (token minted twice while an old job
    # is still draining) — two agents would both STT the mic and both reply.
    # The phone's identity is deterministic (pwa token route: user_<room>);
    # anything else already in the room is another agent → yield to it.
    # NOTE: only meaningful after start() — the room connects there, so
    # remote_participants is empty any earlier (verified live: the check at
    # entrypoint start never saw the sibling).
    human_identity = f"user_{ctx.room.name}"
    # A page refresh re-dispatches a job while the previous one is still
    # draining (its session survives the disconnect through the commit
    # grace). Yielding instantly strands the room agentless: the phone
    # already holds its token and never re-mints, so nobody dispatches a
    # replacement — live 2026-10-02 room 'review': the duplicate kill plus
    # the old job's exit left ~30s of dead air and every hold/tap failed
    # with "no voice agent in the room". Wait out the drain; only a
    # sibling that will not leave is a real duplicate.
    for i in range(80):  # ~20s at 250ms — drain tail is commit grace + 4s
        if not any(p.identity != human_identity for p in ctx.room.remote_participants.values()):
            break
        if i == 0:
            logger.info(
                "previous agent draining in room '%s' — waiting for it to leave", ctx.room.name
            )
        await asyncio.sleep(0.25)
    else:
        # 10-06 20:59: two FRESH jobs landed in 'main-veraldar' together (the
        # phone double-connected) and EACH saw the other as 'the previous
        # agent' — both shut down, room agent-less. Yielding must be ORDERED,
        # not reflexive: the smallest identity stays, the rest yield — both
        # sides compute the same order, so exactly one survives.
        siblings = [
            p.identity
            for p in ctx.room.remote_participants.values()
            if p.identity != human_identity
        ]
        my_id = ctx.room.local_participant.identity
        if siblings and my_id > min(siblings):
            logger.warning(
                "another agent still in room '%s' after 20s — yielding (ordered, %s > %s)",
                ctx.room.name,
                my_id,
                min(siblings),
            )
            ctx.shutdown("duplicate agent")
            return
        logger.warning(
            "sibling agent persisted in room '%s' — I am primary (%s), proceeding",
            ctx.room.name,
            my_id,
        )

    def _end_job_with_session(_ev) -> None:
        # start() returns immediately, so the job would otherwise outlive its
        # session: a zombie agent keeps answering room RPCs with "not-running"
        # and traps the phone in a reconnect loop. End the job with the
        # session — the next join dispatches a fresh one.
        ctx.shutdown("session closed")

    session.on("close", _end_job_with_session)

    # Commit grace: a PTT release disconnects the human BEFORE the commit's
    # opencode handoff is done (flush silence 1.5s + slow STT final + POST).
    # With close_on_disconnect=False the session survives; this task ends the
    # job once the last commit has settled — and stays alive through
    # back-to-back holds that race the tail.
    commit_in_flight = False

    async def _human_left_grace() -> None:
        def _human_present() -> bool:
            return human_identity in {p.identity for p in ctx.room.remote_participants.values()}

        while True:
            # a fast re-hold rejoins the same room while this tail is
            # running — the job stays theirs until they leave for good
            if _human_present():
                await asyncio.sleep(0.5)
                continue
            waited = 0.0
            while commit_in_flight and waited < 15.0:  # bounded: never pin the job
                await asyncio.sleep(0.2)
                waited += 0.2
            await asyncio.sleep(4.0)  # tail: let the opencode POST land
            if _human_present() or commit_in_flight:  # new hold raced in
                continue
            break
        ctx.shutdown("session closed")

    def _on_participant_disconnected(participant) -> None:
        if participant.identity != human_identity:
            return
        asyncio.ensure_future(_human_left_grace())

    ctx.room.on("participant_disconnected", _on_participant_disconnected)

    async def _ptt_begin_rpc(data) -> str:
        # a PTT hold must be ONE message: VAD endpointing would auto-commit
        # on every mid-sentence pause, flushing partial transcripts as
        # separate opencode messages — switch to manual turns for the hold
        try:
            session.update_options(turn_detection="manual")
        except Exception as e:  # noqa: BLE001
            logger.warning("ptt_begin: %s", e)
            return "not-running"
        return "ok"

    # The phone mutes its mic BEFORE asking for the commit (PTT release calls
    # mic(false) first; hands-free mutes on the free_state RPC) — no frames
    # flow after that, and the batch STT only ever POSTs on VAD END_OF_SPEECH,
    # which needs trailing silence that will now never arrive. commit_user_turn
    # then times out EMPTY and the whole hold is dropped (live 2026-09-29 room
    # 'bug', repro'd in room 'voicerepro1': transcript only surfaced during
    # teardown). Detaching the input flips commit_user_turn into its flush
    # path: it injects stt_flush_duration of silence itself, the VAD closes
    # the last segment, the batch POST fires, and the final lands within
    # transcript_timeout. Re-attach immediately — the phone stays muted until
    # its reply finishes, so no frames are lost in between. (Detach only gates
    # frame forwarding in room_io/_input.py; the STT stream keeps its buffer.)
    async def _commit_with_flush() -> None:
        # commit_in_flight gates the human-left grace task (it must not end
        # the job while the handoff is still running)
        nonlocal commit_in_flight
        commit_in_flight = True
        session.input.set_audio_enabled(False)
        t0 = asyncio.get_running_loop().time()
        # 10-06 metric: the JoJo turn produced NO bridge log, NO user message
        # on either opencode instance — invisible failure inside this call.
        # Log entry, outcome and timing so the failing step names itself.
        logger.info("commit_user_turn: start (ptt flush)")
        try:
            # transcript_timeout must cover the Mac Studio batch STT POST after
            # the flush: the final landed ~4-5s after commit start (live
            # 2026-09-29 room 'bug') — at 3.0 the commit gave up EMPTY, the
            # late final hit the closed session and was skipped
            await session.commit_user_turn(transcript_timeout=8.0, stt_flush_duration=1.5)
            logger.info("commit_user_turn: done in %.2fs", asyncio.get_running_loop().time() - t0)
        except Exception as e:  # noqa: BLE001 — metric first, then re-raise
            logger.error("commit_user_turn: FAILED after %.2fs: %s", asyncio.get_running_loop().time() - t0, e)
            raise
        finally:
            session.input.set_audio_enabled(True)
            commit_in_flight = False

    async def _commit_turn_rpc(data) -> str:
        # the phone can call this while the session is already closing (stale
        # room, participant disconnect race) — raising here surfaces as a raw
        # RPC error/timeout on the phone; a "not-running" answer lets it
        # self-heal by reconnecting
        try:
            await _commit_with_flush()
        except Exception as e:  # noqa: BLE001
            logger.warning("commit_turn on dead session: %s", e)
            return "not-running"
        finally:
            # hold is over: keyword turn-taking resumes (never vad — silence
            # must not auto-commit in hands-free)
            try:
                session.update_options(turn_detection="manual")
            except Exception:  # noqa: BLE001
                pass
        return "ok"

    async def _ptt_abort_rpc(data) -> str:
        # Discord-style slide-to-cancel: drop the buffered turn, keep keyword
        # turn-taking, commit nothing
        try:
            session.clear_user_turn()
        except Exception as e:  # noqa: BLE001
            logger.warning("ptt_abort: %s", e)
        finally:
            try:
                session.update_options(turn_detection="manual")
            except Exception:  # noqa: BLE001
                pass
        return "ok"

    ctx.room.local_participant.register_rpc_method("ptt_begin", _ptt_begin_rpc)
    ctx.room.local_participant.register_rpc_method("ptt_abort", _ptt_abort_rpc)
    ctx.room.local_participant.register_rpc_method("commit_turn", _commit_turn_rpc)

    # ---- keyword turn-taking (radio protocol) ----
    # Speech buffers as ONE turn no matter how long the user thinks; "over"
    # commits it and answers; "over and out" commits and returns the phone to
    # the keyboard (radio "out": no spoken reply expected — the answer still
    # lands as text in the session). VAD still segments audio for the STT,
    # but turn_detection stays manual so silence never commits anything.
    session.update_options(turn_detection="manual")
    turn_text = ""  # STT finals accumulated for the turn being buffered
    keyword_busy = False  # a commit cycle is running — ignore further "over"

    def _notify_free_state(state: str) -> None:
        async def _send() -> None:
            try:
                await ctx.room.local_participant.perform_rpc(
                    destination_identity=human_identity,
                    method="free_state",
                    payload='{"state":"%s"}' % state,
                    response_timeout=4_000,
                )
            except Exception:  # noqa: BLE001 - phone may be gone; cosmetic
                pass

        asyncio.ensure_future(_send())

    def _norm(text: str) -> str:
        # punctuation → space so "over." / "over!" match
        return re.sub(r"[^a-z0-9\u4e00-\u9fff]+", " ", text.lower()).strip()

    # STT metric (req 10-06 'I speak no txt'): every transcript event —
    # interim AND final — lands in pwa/.diag/stt-<date>.log. The 10-06 Mac
    # restart outage was invisible in our logs: empty transcripts looked
    # identical to no audio. This line answers "did audio reach STT and what
    # came back" per event.
    from datetime import datetime, timezone
    from pathlib import Path

    _diag_dir = Path(__file__).resolve().parent.parent / "pwa" / ".diag"

    # 10-06 defense layer (req 'this cannot happen again'):
    # (a) SPLIT-BRAIN GUARD — the sandbox lane once left OPENCODE_URL pointing
    #     at the SANDBOX brain (:4100) in this live .env; voice turns landed
    #     in a session nobody was viewing. .env is gitignored so the fix
    #     can't be committed — instead every boot compares the resolved brain
    #     against the committed .env.example and screams on drift.
    _expected_oc = None
    try:
        for _line in (_diag_dir.parent.parent / "agent" / ".env.example").read_text().splitlines():
            if _line.startswith("OPENCODE_URL="):
                _expected_oc = _line.split("=", 1)[1].strip()
                break
    except OSError:
        pass
    logger.warning("brain: OPENCODE_URL=%s speaches=%s", OPENCODE_URL, SPEACHES_URL)
    if _expected_oc and OPENCODE_URL != _expected_oc:
        logger.critical(
            "BRAIN MISMATCH: OPENCODE_URL=%s but agent/.env.example expects %s — voice turns will land in the wrong opencode (10-06 split-brain)",
            OPENCODE_URL,
            _expected_oc,
        )

    # (b) MAC WATCHDOG — the Mac Studio serves STT+TTS; its restart took all
    #     voice down with zero signal in our own logs (found by hand-probing).
    #     Probe SPEACHES_URL every 60s; any HTTP answer = alive. Transitions
    #     go to the journal (CRITICAL when down) and .diag/voice-health-*.log.
    global _voice_probe_started
    if not _voice_probe_started:
        _voice_probe_started = True

        async def _voice_probe() -> None:
            alive = None
            while True:
                try:
                    async with httpx.AsyncClient(timeout=4) as c:
                        r = await c.get(f"{SPEACHES_URL.rstrip('/')}/models")
                        ok = r.status_code < 600
                except Exception:  # noqa: BLE001 — probe must never die
                    ok = False
                if ok != alive:
                    first = alive is None
                    alive = ok
                    try:
                        row = {
                            "ts": datetime.now(timezone.utc).strftime("%Y-%m-%dT%H:%M:%S.%fZ"),
                            "endpoint": SPEACHES_URL,
                            "up": ok,
                        }
                        with (_diag_dir / f"voice-health-{datetime.now(timezone.utc):%Y-%m-%d}.log").open("a") as f:
                            f.write(f"{row}\n")
                    except Exception:  # noqa: BLE001
                        pass
                    if not ok:
                        logger.critical("SPEACHES endpoint DOWN (%s) — voice will not transcribe or speak", SPEACHES_URL)
                    elif first:
                        logger.info("SPEACHES endpoint up: %s", SPEACHES_URL)
                    else:
                        logger.info("SPEACHES endpoint recovered: %s", SPEACHES_URL)
                await asyncio.sleep(60)

        asyncio.ensure_future(_voice_probe())

    def _diag_stt(ev) -> None:
        try:
            row = {
                "ts": datetime.now(timezone.utc).strftime("%Y-%m-%dT%H:%M:%S.%fZ"),
                "room": ctx.room.name,
                "final": bool(ev.is_final),
                "chars": len(ev.transcript or ""),
                "head": (ev.transcript or "")[:48],
            }
            with (_diag_dir / f"stt-{datetime.now(timezone.utc):%Y-%m-%d}.log").open("a") as f:
                f.write(f"{row}\n")
        except Exception:  # noqa: BLE001 — metric must never break voice
            pass

    @session.on("user_input_transcribed")
    def _on_transcript(ev) -> None:
        nonlocal turn_text, keyword_busy
        _diag_stt(ev)
        if not ev.is_final:
            return
        turn_text = f"{turn_text} {ev.transcript}".strip()
        if keyword_busy:
            return
        norm = _norm(turn_text)
        out = norm.endswith("over and out")
        if not out and not norm.endswith("over"):
            return
        phrase = "over and out" if out else "over"
        keyword_busy = True
        turn_text = ""
        logger.info("keyword commit (%s)", phrase)
        if not out:
            # phone mutes the mic NOW and shows the working animation; the
            # phone itself unmutes when it has finished SPEAKING the reply
            # (playback end → mic back — agent audio output is off)
            _notify_free_state("processing")

        async def _commit() -> None:
            nonlocal keyword_busy
            if out:
                # mic off on the phone FIRST (radio "out": nothing more is
                # coming) — fire & forget, the reply is not spoken anyway
                try:
                    await ctx.room.local_participant.perform_rpc(
                        destination_identity=human_identity,
                        method="end_free",
                        payload="{}",
                        response_timeout=4_000,
                    )
                except Exception as e:  # noqa: BLE001
                    logger.warning("end_free rpc: %s", e)
            try:
                await _commit_with_flush()
            except Exception as e:  # noqa: BLE001
                logger.warning("keyword commit: %s", e)
            finally:
                keyword_busy = False

        asyncio.ensure_future(_commit())

    # explicit dispatch lands the agent in the room BEFORE the phone connects,
    # and speech into an unlinked room is lost audio — wait for the human
    # (capped, so a never-arriving phone can't pin the job) before greeting
    deadline = asyncio.get_running_loop().time() + 30
    while human_identity not in {p.identity for p in ctx.room.remote_participants.values()}:
        if asyncio.get_running_loop().time() > deadline:
            break
        await asyncio.sleep(0.2)

    # (audio output is disabled — the greeting would synthesize into the
    # void; the phone's UI is the greeting now)
    logger.info("room '%s' ready — keyword turn-taking armed", ctx.room.name)


if __name__ == "__main__":
    cli.run_app(server)
