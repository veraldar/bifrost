"""Hidden tests for code-fizzbuzz — the model never sees these."""
import sys
import pytest


def _load(submitted):
    sys.path.insert(0, str(submitted))
    import fizz
    return fizz


def test_fifteen(submitted, tmp_path):
    fizz = _load(submitted)
    assert fizz.fizzbuzz(15) == "FizzBuzz"


def test_three_and_five(submitted, tmp_path):
    fizz = _load(submitted)
    assert fizz.fizzbuzz(3) == "Fizz" and fizz.fizzbuzz(5) == "Buzz"


def test_plain_numbers(submitted, tmp_path):
    fizz = _load(submitted)
    assert fizz.fizzbuzz(1) == "1" and fizz.fizzbuzz(7) == "7" and fizz.fizzbuzz(98) == "98"


def test_zero_and_negatives(submitted, tmp_path):
    fizz = _load(submitted)
    assert fizz.fizzbuzz(0) == "FizzBuzz"
    assert fizz.fizzbuzz(-3) == "Fizz"
    assert fizz.fizzbuzz(-5) == "Buzz"
    assert fizz.fizzbuzz(-7) == "-7"
