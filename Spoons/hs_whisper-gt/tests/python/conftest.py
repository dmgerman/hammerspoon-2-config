"""Shared fixtures for the whisper_stream.py tests.

Nothing here needs Hammerspoon. The server tests start whisper_stream.py as a real process
on a free port, with --test-file in place of the microphone, and talk to it over a real
WebSocket.
"""

import json
import os
import queue
import subprocess
import sys
import threading
import time
from pathlib import Path

import numpy as np
import pytest

SPOON = Path(__file__).resolve().parents[2]
FIXTURES = SPOON / "tests" / "fixtures"
SERVER = SPOON / "whisper_stream.py"

sys.path.insert(0, str(SPOON))


# --- Stand-ins for the transport and the VAD model ---

class RecordingTransport:
    """A transport that keeps every event sent, and can pretend the client has gone."""

    def __init__(self):
        self.events = []
        self.connected = True

    def send_event(self, event_type, **kwargs):
        self.events.append({"type": event_type, **kwargs})
        return self.connected

    def receive_command(self, timeout=0.1):
        return None

    def types(self):
        return [event["type"] for event in self.events]

    def of_type(self, event_type):
        return [event for event in self.events if event["type"] == event_type]


class FixedVad:
    """A VAD model that reports the same speech probability for everything."""

    def __init__(self, probability=0.8):
        self.probability = probability

    def __call__(self, tensor, sample_rate):
        probability = self.probability

        class Result:
            def item(self):
                return probability

        return Result()


@pytest.fixture
def transport():
    return RecordingTransport()


@pytest.fixture
def vad():
    return FixedVad()


@pytest.fixture
def make_recorder(transport, vad, tmp_path):
    """Build a ContinuousRecorder with the stand-ins; keyword arguments override."""
    from whisper_stream import ContinuousRecorder

    def build(**overrides):
        settings = dict(output_dir=str(tmp_path), filename_prefix="test",
                        silence_threshold=2.0, min_chunk_duration=1.0,
                        max_chunk_duration=10.0, vad_model=vad)
        settings.update(overrides)
        recorder = ContinuousRecorder(transport, **settings)
        return recorder

    return build


# --- Audio fixtures ---

def wav_write(path, samples, sample_rate=16000):
    import scipy.io.wavfile
    scipy.io.wavfile.write(str(path), sample_rate, samples)
    return path


@pytest.fixture
def silent_wav(tmp_path):
    """Three seconds of digital silence: what a muted microphone delivers."""
    return wav_write(tmp_path / "silence.wav", np.zeros(16000 * 3, dtype=np.int16))


@pytest.fixture
def short_wav():
    """One second of speech: "Transcribe happens." """
    return FIXTURES / "short.wav"


@pytest.fixture
def long_wav():
    """43.5 seconds of speech with pauses, which VAD cuts into several chunks."""
    return FIXTURES / "long.wav"


# --- A real server process and a real client ---

class ServerProcess:
    def __init__(self, process, port, log_lines):
        self.process = process
        self.port = port
        self.log_lines = log_lines

    @property
    def url(self):
        return f"ws://127.0.0.1:{self.port}"

    def running(self):
        return self.process.poll() is None

    def stop(self, sig=None):
        if self.running():
            if sig is None:
                self.process.terminate()
            else:
                self.process.send_signal(sig)
        try:
            return self.process.wait(timeout=10)
        except subprocess.TimeoutExpired:
            self.process.kill()
            return self.process.wait()


def server_start(test_file, *extra, startup_timeout=60):
    """Start whisper_stream.py on a free port and wait until it is listening."""
    process = subprocess.Popen(
        [sys.executable, str(SERVER), "--port", "0", "--test-file", str(test_file), *extra],
        stdout=subprocess.DEVNULL, stderr=subprocess.PIPE, text=True)
    log_lines = []
    port_found = queue.Queue()

    def read_log():
        for line in process.stderr:
            log_lines.append(line.rstrip("\n"))
            if '"status": "listening"' in line:
                port_found.put(json.loads(line.split(" ", 2)[2])["port"])

    threading.Thread(target=read_log, daemon=True).start()
    try:
        port = port_found.get(timeout=startup_timeout)
    except queue.Empty:
        process.kill()
        raise RuntimeError("server did not start:\n" + "\n".join(log_lines))
    return ServerProcess(process, port, log_lines)


@pytest.fixture
def start_server(tmp_path):
    started = []

    def start(test_file, *extra):
        server = server_start(test_file, *extra)
        started.append(server)
        return server

    yield start
    for server in started:
        server.stop()


class Client:
    """A WebSocket client that keeps every event and can wait for one."""

    def __init__(self, url):
        from websockets.sync.client import connect
        # connect() is meant to be used in a with statement; this client outlives one.
        self._context = connect(url)
        self.connection = self._context.__enter__()
        self.events = []
        self._incoming = queue.Queue()
        self.closed = threading.Event()
        threading.Thread(target=self._read, daemon=True).start()

    def _read(self):
        try:
            for message in self.connection:
                self._incoming.put(json.loads(message))
        except Exception:
            pass
        finally:
            self.closed.set()

    def send(self, command, **fields):
        self.connection.send(json.dumps({"command": command, **fields}))

    def wait_for(self, event_type, timeout=10):
        """Return the next event of EVENT_TYPE, keeping every event read on the way."""
        deadline = time.time() + timeout
        for event in self.events:
            if event["type"] == event_type and not event.get("_seen"):
                event["_seen"] = True
                return event
        while time.time() < deadline:
            try:
                event = self._incoming.get(timeout=max(0.01, deadline - time.time()))
            except queue.Empty:
                break
            self.events.append(event)
            if event["type"] == event_type:
                event["_seen"] = True
                return event
        raise AssertionError(f"no {event_type} within {timeout} s; got "
                             f"{[e['type'] for e in self.events]}")

    def types(self):
        return [event["type"] for event in self.events]

    def close(self):
        self._context.__exit__(None, None, None)


@pytest.fixture
def connect():
    clients = []

    def open_client(server):
        client = Client(server.url)
        clients.append(client)
        return client

    yield open_client
    for client in clients:
        try:
            client.close()
        except Exception:
            pass
