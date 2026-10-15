"""The audio helpers in whisper_stream.py. Ported from the Hammerspoon 1 Spoon."""

import numpy as np

from whisper_stream import (
    normalize_audio,
    is_perfect_silence,
    convert_to_int16,
    SILENCE_AMPLITUDE_THRESHOLD,
)


class TestNormalizeAudio:
    def test_int16_to_float32(self):
        audio = np.array([0, 16384, -16384, 32767, -32768], dtype=np.int16)
        result = normalize_audio(audio)
        assert result.dtype == np.float32
        assert np.allclose(result, [0.0, 0.5, -0.5, 1.0, -1.0], atol=0.01)

    def test_float32_passthrough(self):
        audio = np.array([0.0, 0.5, -0.5, 1.0, -1.0], dtype=np.float32)
        result = normalize_audio(audio)
        assert result.dtype == np.float32
        assert np.allclose(result, audio)

    def test_float64_to_float32(self):
        audio = np.array([0.0, 0.5, -0.5], dtype=np.float64)
        assert normalize_audio(audio).dtype == np.float32

    def test_empty_array(self):
        result = normalize_audio(np.array([], dtype=np.int16))
        assert result.dtype == np.float32
        assert len(result) == 0


class TestIsPerfectSilence:
    def test_all_zeros_is_silence(self):
        assert is_perfect_silence(np.zeros(1000, dtype=np.float32))

    def test_below_threshold_is_silence(self):
        assert is_perfect_silence(np.full(1000, SILENCE_AMPLITUDE_THRESHOLD * 0.5, dtype=np.float32))

    def test_normal_audio_is_not_silence(self):
        assert not is_perfect_silence(np.full(1000, 0.1, dtype=np.float32))

    def test_int16_zeros(self):
        assert is_perfect_silence(np.zeros(1000, dtype=np.int16))

    def test_int16_audio(self):
        assert not is_perfect_silence(np.full(1000, 5000, dtype=np.int16))

    def test_one_loud_sample_is_not_silence(self):
        audio = np.zeros(1000, dtype=np.float32)
        audio[500] = 0.1
        assert not is_perfect_silence(audio)


class TestConvertToInt16:
    def test_float32_to_int16(self):
        result = convert_to_int16(np.array([0.0, 0.5, -0.5, 1.0, -1.0], dtype=np.float32))
        assert result.dtype == np.int16
        assert result[0] == 0
        assert abs(result[1] - 16383) <= 1
        assert abs(result[2] + 16383) <= 1
        assert result[3] == 32767
        assert result[4] == -32767

    def test_float64_to_int16(self):
        assert convert_to_int16(np.array([0.0, 0.5], dtype=np.float64)).dtype == np.int16

    def test_int16_passthrough(self):
        audio = np.array([0, 1000, -1000, 32767, -32768], dtype=np.int16)
        assert np.array_equal(convert_to_int16(audio), audio)

    def test_empty_array(self):
        result = convert_to_int16(np.array([], dtype=np.float32))
        assert result.dtype == np.int16
        assert len(result) == 0
