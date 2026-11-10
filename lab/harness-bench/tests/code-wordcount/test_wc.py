"""Hidden tests for code-wordcount. Ground truth: runs of [a-z0-9']+ on lowercased text."""
import sys
import pytest


def _load(submitted):
    sys.path.insert(0, str(submitted))
    import wc
    return wc


GOLD = [
    ("Hello world", {"hello": 1, "world": 1}),
    ("The cat, the dog", {"the": 2, "cat": 1, "dog": 1}),
    ("it's it's ITS", {"it's": 2, "its": 1}),
    ("mix3d case_underscore email@x", {"mix3d": 1, "case": 1, "underscore": 1, "email": 1, "x": 1}),
    ("", {}),
    ("don't stop-me", {"don't": 1, "stop": 1, "me": 1}),
    ("tab\tseparated\nlines", {"tab": 1, "separated": 1, "lines": 1}),
]


@pytest.mark.parametrize("text,expected", GOLD)
def test_gold(text, expected, submitted):
    wc = _load(submitted)
    assert wc.word_counts(text) == expected


def test_returns_dict(submitted):
    wc = _load(submitted)
    assert isinstance(wc.word_counts("one"), dict)
