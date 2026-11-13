"""Voice commands while a reply plays (owner 11-13): what counts as stop / pause / faster / slower /
resume, and what never does. `uv run python test_voice_commands.py` or pytest."""

from agent import command_of, strip_commands

# (heard, the deck is speaking, command)
CASES = [
    ("Stop.", False, "stop"),
    ("Okay, stop.", True, "stop"),
    ("Faster please.", True, "faster"),
    ("please slow down now", True, "slower"),
    ("Okay, pause.", True, "pause"),
    ("Continue please.", False, "resume"),
    # a real phone: the reply's own echo, then the keyword, in one utterance
    ("and the keeper climbed to the lamp, stop.", True, "stop"),
    # …but not when nothing is playing: then it is part of a message
    ("and the keeper climbed to the lamp, stop.", False, None),
    # ordinary speech and sentence ends that are not commands
    ("Hmm, that is interesting.", True, None),
    ("so we had to wait.", True, None),
    ("then the band started to play", True, None),
    ("tell me a story over", True, None),
]


def test_command_of() -> None:
    for heard, speaking, want in CASES:
        assert command_of(heard, speaking) == want, (heard, speaking, command_of(heard, speaking))


def test_strip_commands() -> None:
    assert strip_commands("Okay, stop. Tell me about the lighthouse over.") == "Tell me about the lighthouse over."


if __name__ == "__main__":
    test_command_of()
    test_strip_commands()
    print(f"ok: {len(CASES)} cases")
