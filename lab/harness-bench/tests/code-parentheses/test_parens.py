"""Hidden tests for code-parentheses."""
import sys
import pytest


def _load(submitted):
    sys.path.insert(0, str(submitted))
    import parens
    return parens


def test_simple_pairs(submitted):
    p = _load(submitted)
    assert p.is_balanced("()") is True
    assert p.is_balanced("(a(b)c)") is True


def test_unbalanced(submitted):
    p = _load(submitted)
    assert p.is_balanced("(") is False
    assert p.is_balanced(")(") is False          # order matters
    assert p.is_balanced("(()") is False


def test_empty_and_noise(submitted):
    p = _load(submitted)
    assert p.is_balanced("") is True
    assert p.is_balanced("no parens here") is True
    assert p.is_balanced("f(g, (h)) [j]") is True
