"""Mint a LiveKit access token for the phone PWA.

Usage: uv run mint_token.py [identity] [room]
"""

import os
import secrets
import sys

from dotenv import load_dotenv
from livekit.api import AccessToken, VideoGrants

load_dotenv()

identity = sys.argv[1] if len(sys.argv) > 1 else "phone"
room = sys.argv[2] if len(sys.argv) > 2 else "opencode"

token = (
    AccessToken(os.environ["LIVEKIT_API_KEY"], os.environ["LIVEKIT_API_SECRET"])
    .with_identity(identity)
    .with_name(identity)
    .with_grants(VideoGrants(room_join=True, room=room, can_publish=True, can_subscribe=True))
    .to_jwt()
)

print(f"URL:   {os.environ['LIVEKIT_URL']}")
print(f"ROOM:  {room}")
print(f"TOKEN: {token}")
