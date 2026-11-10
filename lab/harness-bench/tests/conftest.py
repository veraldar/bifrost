"""Shared conftest — injects the model's submitted module dir into hidden tests."""
import pathlib
import pytest


def pytest_addoption(parser):
    parser.addoption("--submitted", action="store", default="",
                     help="dir holding the submitted module under test")


@pytest.fixture
def submitted(request):
    return pathlib.Path(request.config.getoption("--submitted"))
