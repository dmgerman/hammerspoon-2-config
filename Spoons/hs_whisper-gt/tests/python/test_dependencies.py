"""check_dependencies() and --check-deps."""

import json
import subprocess
import sys

from conftest import SERVER
from whisper_stream import check_dependencies


def test_everything_is_installed():
    assert check_dependencies() == []


def test_check_deps_reports_ok():
    result = subprocess.run([sys.executable, str(SERVER), "--check-deps"],
                            capture_output=True, text=True, timeout=120)
    assert result.returncode == 0
    assert json.loads(result.stdout) == {"status": "ok"}


def test_a_missing_module_is_named(monkeypatch):
    # A None entry in sys.modules makes the import fail as if it were not installed.
    monkeypatch.setitem(sys.modules, "websockets", None)
    monkeypatch.setitem(sys.modules, "websockets.sync", None)
    monkeypatch.setitem(sys.modules, "websockets.sync.server", None)
    missing = check_dependencies()
    assert len(missing) == 1
    assert missing[0].startswith("websockets")
