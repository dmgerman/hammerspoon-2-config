"""When the server opens and closes the microphone, with sounddevice replaced by a fake.

The microphone is opened by a recording, kept open between recordings, and closed once it
has been idle for microphone_idle_timeout seconds. The point is that macOS's microphone
indicator is on only around dictation, while a run of dictations does not pay the cost of
opening the device each time.
"""

import threading
import time

import pytest


class FakeStream:
    def __init__(self, sd, device, hang=False, fail=None, **kwargs):
        if fail:
            raise fail
        if hang:
            # PortAudio blocks like this when the process has no microphone permission.
            sd.release.wait()
        self.sd = sd
        self.device = device
        self.callback = kwargs["callback"]
        self.started = False
        self.closed = False
        sd.streams.append(self)

    def start(self):
        self.started = True

    def stop(self):
        self.started = False

    def close(self):
        self.closed = True


class FakeSounddevice:
    def __init__(self):
        self.streams = []
        self.hang = False
        self.fail = None
        self.release = threading.Event()
        self.devices = [
            {"name": "MacBook Pro Microphone", "max_input_channels": 1},
            {"name": "MacBook Pro Speakers", "max_input_channels": 0},
            {"name": "BlackHole 2ch", "max_input_channels": 2},
        ]

    def query_devices(self):
        return self.devices

    def InputStream(self, device=None, **kwargs):
        return FakeStream(self, device, hang=self.hang, fail=self.fail, **kwargs)

    def open_streams(self):
        return [stream for stream in self.streams if not stream.closed]


@pytest.fixture
def sd():
    fake = FakeSounddevice()
    yield fake
    fake.release.set()


@pytest.fixture
def recorder(make_recorder, sd):
    recorder = make_recorder(sounddevice=sd, microphone_idle_timeout=0.3,
                             microphone_open_timeout=0.5)
    yield recorder
    recorder.shutdown()


def record_once(recorder, **settings):
    recorder.start_recording({"command": "start_recording", **settings})
    recorder.stop_recording()


def test_nothing_is_open_before_the_first_recording(recorder, sd):
    assert sd.streams == []
    assert recorder.status()["microphone_open"] is False


def test_a_recording_opens_the_microphone(recorder, sd, transport):
    recorder.start_recording({"command": "start_recording"})
    assert len(sd.open_streams()) == 1
    assert sd.streams[0].started
    assert transport.types() == ["recording_started"]
    assert recorder.status() == {"recording": True, "microphone_open": True,
                                 "device": None, "test_file": None}


def test_the_microphone_stays_open_between_recordings(recorder, sd):
    record_once(recorder)
    record_once(recorder)
    record_once(recorder)
    assert len(sd.streams) == 1
    assert len(sd.open_streams()) == 1


def test_the_microphone_closes_after_the_idle_timeout(recorder, sd):
    record_once(recorder)
    assert len(sd.open_streams()) == 1
    time.sleep(0.6)
    assert sd.open_streams() == []
    assert recorder.status()["microphone_open"] is False


def test_a_recording_within_the_timeout_keeps_it_open(recorder, sd):
    record_once(recorder)
    time.sleep(0.2)
    recorder.start_recording({"command": "start_recording"})
    time.sleep(0.3)
    # The first recording's timer would have fired by now; the second one cancelled it.
    assert len(sd.open_streams()) == 1
    recorder.stop_recording()


def test_it_reopens_after_closing(recorder, sd):
    record_once(recorder)
    time.sleep(0.6)
    record_once(recorder)
    assert len(sd.streams) == 2
    assert len(sd.open_streams()) == 1


def test_another_device_reopens_the_microphone(recorder, sd, transport):
    record_once(recorder)
    record_once(recorder, audio_input="BlackHole 2ch")
    assert len(sd.streams) == 2
    assert sd.streams[0].closed
    assert sd.streams[1].device == 2
    assert recorder.status()["device"] == "BlackHole 2ch"
    assert transport.of_type("recording_started")[-1]["device"] == "BlackHole 2ch"


def test_an_unknown_device_is_an_error(recorder, sd, transport):
    recorder.start_recording({"command": "start_recording", "audio_input": "No Such Mic"})
    assert recorder.recording is False
    assert transport.types() == ["error", "recording_stopped"]
    assert "not found" in transport.events[0]["error"]


def test_an_output_only_device_is_not_an_input(recorder, sd, transport):
    recorder.start_recording({"command": "start_recording", "audio_input": "MacBook Pro Speakers"})
    assert transport.types() == ["error", "recording_stopped"]


def test_a_failing_open_is_an_error_and_the_server_carries_on(recorder, sd, transport):
    sd.fail = OSError("device busy")
    recorder.start_recording({"command": "start_recording"})
    assert transport.types() == ["error", "recording_stopped"]
    assert "device busy" in transport.events[0]["error"]
    assert recorder.running

    sd.fail = None
    recorder.start_recording({"command": "start_recording"})
    assert recorder.recording


def test_a_hanging_open_is_an_error_within_the_time_limit(recorder, sd, transport):
    sd.hang = True
    started = time.time()
    recorder.start_recording({"command": "start_recording"})
    assert time.time() - started < 2
    assert transport.types() == ["error", "recording_stopped"]
    assert "permission" in transport.events[0]["error"]
    recorder.handle_command({"command": "status"})
    assert transport.types()[-1] == "status"


def test_audio_reaches_the_recording(recorder, sd, tmp_path, transport):
    import numpy as np
    recorder.start_recording({"command": "start_recording", "filename_prefix": "mic"})
    block = (np.random.randn(8000, 1) * 0.1).astype(np.float32)
    sd.streams[0].callback(block, 8000, None, None)
    recorder.stop_recording()
    chunk = transport.of_type("chunk_ready")[0]
    assert chunk["is_final"] is True
    assert chunk["audio_file"] == str(tmp_path / "mic_chunk_001.wav")


def test_audio_between_recordings_is_dropped(recorder, sd, transport):
    import numpy as np
    record_once(recorder)
    events = len(transport.events)
    sd.streams[0].callback(np.ones((8000, 1), dtype=np.float32) * 0.1, 8000, None, None)
    assert len(transport.events) == events
    assert recorder.all_audio == []


def test_shutdown_releases_the_microphone(recorder, sd):
    recorder.start_recording({"command": "start_recording"})
    recorder.shutdown()
    assert sd.open_streams() == []
    assert recorder.recording is False
