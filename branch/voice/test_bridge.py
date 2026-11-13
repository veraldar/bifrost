"""Local test of the OpenCodeLLM bridge without a LiveKit room."""

import asyncio
import logging

logging.basicConfig(level=logging.DEBUG)

from livekit.agents.llm import ChatContext
from livekit.agents.types import APIConnectOptions

from agent import OpenCodeLLM, OpenCodeStream


async def main() -> None:
    ctx = ChatContext()
    ctx.add_message(role="user", content="Reply with exactly: LOCAL TEST OK")
    oc = OpenCodeLLM("http://127.0.0.1:4096")
    stream = OpenCodeStream(
        llm=oc, chat_ctx=ctx, tools=[], conn_options=APIConnectOptions(max_retry=0)
    )
    print("chat_ctx type:", type(ctx))
    await stream._run()
    # drain the channel
    while True:
        try:
            chunk = await asyncio.wait_for(stream._event_ch.recv(), timeout=1)
            print("CHUNK:", chunk.delta and chunk.delta.content)
        except (TimeoutError, asyncio.TimeoutError, StopAsyncIteration):
            break


asyncio.run(main())
