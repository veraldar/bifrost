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
        async with httpx.AsyncClient(timeout=300) as c:
            # no `model` in the body on purpose: sending one would clobber the
            # session's model every turn (opencode replaces the whole model
            # ref, think level included). Omitted → the runner uses the
            # session's current model: VOICE_MODEL seeds it once at session
            # creation (below), and a settings-page switch replaces it.
            r = await c.post(
                f"{self._base}/session/{sid}/message",
                json={"parts": [{"type": "text", "text": text}]},
            )
            r.raise_for_status()
            data = r.json()
        parts = data.get("parts") or []
        return "\n".join(
            p.get("text", "") for p in parts if p.get("type") == "text"
        ).strip() or "(opencode returned no text)"

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


server = AgentServer()


@server.rtc_session(agent_name="bifrost")
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
        room_input_options=RoomInputOptions(text_enabled=True),
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
    if any(p.identity != human_identity for p in ctx.room.remote_participants.values()):
        logger.warning("another agent already in room '%s' — shutting down", ctx.room.name)
        ctx.shutdown("duplicate agent")
        return

    def _end_job_with_session(_ev) -> None:
        # start() returns immediately, so the job would otherwise outlive its
        # session: a zombie agent keeps answering room RPCs with "not-running"
        # and traps the phone in a reconnect loop. End the job with the
        # session — the next join dispatches a fresh one.
        ctx.shutdown("session closed")

    session.on("close", _end_job_with_session)

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

    async def _commit_turn_rpc(data) -> str:
        # the phone can call this while the session is already closing (stale
        # room, participant disconnect race) — raising here surfaces as a raw
        # RPC error/timeout on the phone; a "not-running" answer lets it
        # self-heal by reconnecting
        try:
            await session.commit_user_turn()
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

    @session.on("user_input_transcribed")
    def _on_transcript(ev) -> None:
        nonlocal turn_text, keyword_busy
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
                await session.commit_user_turn()
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
