"""ContinuousRecorder with a stand-in transport and VAD model.

Ported from the Hammerspoon 1 Spoon, and changed where the server's behaviour changed: a
client that has gone, or a microphone that is off, now ends the recording and never the
server.
"""

from unittest.mock import patch

import numpy as np


def noise(samples=8000, level=0.1):
    return (np.random.randn(samples) * level).astype(np.float32)


class TestSettings:
    def test_defaults(self, make_recorder, tmp_path):
        recorder = make_recorder()
        assert recorder.output_dir == tmp_path
        assert recorder.filename_prefix == "test"
        assert recorder.silence_threshold == 2.0
        assert recorder.min_chunk_duration == 1.0
        assert recorder.max_chunk_duration == 10.0
        assert recorder.running is True
        assert recorder.recording is False

    def test_a_recording_overrides_the_defaults(self, make_recorder, tmp_path):
        recorder = make_recorder()
        recorder._apply_settings({"filename_prefix": "en-1", "output_dir": str(tmp_path / "x"),
                                  "silence_threshold": 3, "min_chunk_duration": 5,
                                  "max_chunk_duration": 20, "audio_input": "Mic"})
        assert recorder.filename_prefix == "en-1"
        assert recorder.output_dir == tmp_path / "x"
        assert recorder.silence_threshold == 3.0
        assert recorder.min_chunk_duration == 5.0
        assert recorder.max_chunk_duration == 20.0
        assert recorder.audio_input_device == "Mic"

    def test_settings_left_out_return_to_the_defaults(self, make_recorder):
        recorder = make_recorder()
        recorder._apply_settings({"filename_prefix": "first", "silence_threshold": 9})
        recorder._apply_settings({})
        assert recorder.filename_prefix == "test"
        assert recorder.silence_threshold == 2.0


class TestChunks:
    def test_reset_recording_state(self, make_recorder):
        recorder = make_recorder()
        recorder.chunk_num = 5
        recorder.current_chunk_audio = [noise()]
        recorder.all_audio = [noise()]
        recorder.mic_off = True
        recorder._reset_recording_state()
        assert recorder.chunk_num == 0
        assert recorder.current_chunk_audio == []
        assert recorder.all_audio == []
        assert recorder.mic_off is False
        assert recorder.silence_start_time is None

    def test_save_chunk_writes_a_numbered_file(self, make_recorder, tmp_path):
        recorder = make_recorder()
        recorder.current_chunk_audio = [noise()]
        chunk_file, peak = recorder._save_chunk()
        assert chunk_file == str(tmp_path / "test_chunk_001.wav")
        assert (tmp_path / "test_chunk_001.wav").exists()
        assert 0.0 < peak <= 1.0
        assert recorder.current_chunk_audio == []

    def test_save_chunk_with_no_audio(self, make_recorder):
        recorder = make_recorder()
        assert recorder._save_chunk() == (None, 0.0)
        assert recorder.chunk_num == 0

    def test_chunk_numbers_increase(self, make_recorder):
        recorder = make_recorder()
        for expected in (1, 2):
            recorder.current_chunk_audio = [noise()]
            recorder._save_chunk()
            assert recorder.chunk_num == expected

    def test_save_chunk_creates_the_output_directory(self, make_recorder, tmp_path):
        nested = tmp_path / "nested" / "output"
        recorder = make_recorder(output_dir=str(nested))
        recorder.current_chunk_audio = [noise()]
        recorder._save_chunk()
        assert nested.is_dir()

    def test_max_duration_saves_a_chunk(self, make_recorder):
        recorder = make_recorder()
        recorder.current_chunk_audio = [noise()]
        recorder.current_chunk_start_time = 0.0
        with patch('time.time', return_value=15.0):
            assert recorder._check_max_duration() is True
        assert recorder.chunk_num == 1

    def test_under_max_duration_saves_nothing(self, make_recorder):
        recorder = make_recorder()
        recorder.current_chunk_audio = [noise()]
        recorder.current_chunk_start_time = 0.0
        with patch('time.time', return_value=5.0):
            assert recorder._check_max_duration() is False
        assert recorder.chunk_num == 0

    def test_chunk_ready_carries_the_peak(self, make_recorder, transport):
        recorder = make_recorder()
        recorder._emit_chunk_ready("/path/to/chunk.wav", is_final=False, peak=0.42)
        assert transport.events[-1] == {"type": "chunk_ready", "chunk_num": 0,
                                        "audio_file": "/path/to/chunk.wav",
                                        "is_final": False, "peak": 0.42}

    def test_a_client_that_has_gone_does_not_stop_the_server(self, make_recorder, transport):
        recorder = make_recorder()
        transport.connected = False
        recorder._emit_chunk_ready("/path/to/chunk.wav")
        assert recorder.running is True

    def test_save_complete_recording(self, make_recorder, tmp_path):
        recorder = make_recorder()
        recorder.all_audio = [noise(), noise()]
        complete_file = recorder._save_complete_recording()
        assert complete_file.startswith(str(tmp_path / "test-"))
        assert complete_file.endswith(".wav")

    def test_save_complete_recording_with_no_audio(self, make_recorder):
        assert make_recorder()._save_complete_recording() is None


class TestVoiceActivity:
    def test_speech(self, make_recorder, vad):
        vad.probability = 0.9
        assert make_recorder()._detect_voice_activity(noise(512)) is True

    def test_silence(self, make_recorder, vad):
        vad.probability = 0.1
        assert make_recorder()._detect_voice_activity(np.zeros(512, dtype=np.float32)) is False

    def test_a_failing_model_counts_as_speech(self, make_recorder, transport):
        def broken(tensor, rate):
            raise RuntimeError("VAD error")
        recorder = make_recorder(vad_model=broken)
        assert recorder._detect_voice_activity(noise(512)) is True
        assert transport.types() == ["error"]

    def test_recent_audio_is_the_last_512_samples(self, make_recorder):
        recorder = make_recorder()
        recorder.current_chunk_audio = [noise(200) for _ in range(5)]
        assert len(recorder._get_recent_audio()) == 512

    def test_not_enough_recent_audio(self, make_recorder):
        recorder = make_recorder()
        recorder.current_chunk_audio = [noise(100)]
        assert recorder._get_recent_audio() is None

    def test_speech_resets_silence_tracking(self, make_recorder):
        recorder = make_recorder()
        recorder.silence_start_time = 123.0
        recorder.consecutive_silence_count = 5
        with patch.object(recorder, '_detect_voice_activity', return_value=True):
            recorder._process_vad(noise(512))
        assert recorder.silence_start_time is None
        assert recorder.consecutive_silence_count == 0

    def test_silence_timer_starts_after_two_detections(self, make_recorder):
        recorder = make_recorder()
        with patch.object(recorder, '_detect_voice_activity', return_value=False), \
                patch('time.time', return_value=100.0):
            recorder._process_vad(np.zeros(512, dtype=np.float32))
            assert recorder.silence_start_time is None
            recorder._process_vad(np.zeros(512, dtype=np.float32))
            assert recorder.silence_start_time == 100.0


class TestMicrophoneOff:
    def test_normal_audio_ends_the_check(self, make_recorder):
        recorder = make_recorder(perfect_silence_duration=2.0)
        recorder._check_perfect_silence(noise())
        assert recorder.startup_silence_check_done is True
        assert not recorder.mic_off

    def test_silence_ends_the_recording_but_not_the_server(self, make_recorder, transport):
        recorder = make_recorder(perfect_silence_duration=2.0)
        recorder.recording = True
        recorder.all_audio = [np.zeros(8000, dtype=np.float32)]
        silence = np.zeros(8000, dtype=np.float32)

        recorder._check_perfect_silence(silence)
        assert not recorder.mic_off
        with patch('time.time', return_value=recorder.perfect_silence_start_time + 3.0):
            recorder._check_perfect_silence(silence)

        assert recorder.mic_off is True
        assert recorder.recording is False
        assert recorder.running is True
        assert transport.types()[0] == "silence_warning"
        assert transport.types()[-1] == "recording_stopped"
        assert "chunk_ready" not in transport.types()
