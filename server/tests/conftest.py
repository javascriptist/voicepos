from __future__ import annotations

import pytest

from voicepos.menu import Menu, load_menu


@pytest.fixture(scope="session")
def menu() -> Menu:
    return load_menu()
