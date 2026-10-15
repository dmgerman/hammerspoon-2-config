"""FileAudioSource, which stands in for the microphone in tests.

Ported from the Hammerspoon 1 Spoon's test_silence_detection.py, which depended on a
/tmp/empty.wav that did not exist and so skipped every test. The silence is generated here.
"""

import numpy as np
import pytest

from whisper_stream import FileAudioSource


def test_silence_is_all_zeros(silent_wav):
    source = FileAudioSource(silent_wav)
    assert np.max(np.abs(source.audio_data)) == 0.0


def test_chunks_are_half_a_second_of_mono(short_wav):
    source = FileAudioSource(short_wav)
    chunk = source.read_chunk()
    assert chunk.shape == (8000, 1)
    assert chunk.dtype == np.float32


def test_the_last_chunk_is_padded_and_then_the_file_ends(silent_wav):
    source = FileAudioSource(silent_wav)
    chunks = []
    while (chunk := source.read_chunk()) is not None:
        chunks.append(chunk)
    assert len(chunks) == 6
    assert all(chunk.shape == (8000, 1) for chunk in chunks)


def test_rewind_plays_the_file_again(short_wav):
    source = FileAudioSource(short_wav)
    first = source.read_chunk()
    while source.read_chunk() is not None:
        pass
    source.rewind()
    assert np.array_equal(source.read_chunk(), first)


def test_other_sample_rates_are_resampled(tmp_path):
    import scipy.io.wavfile
    path = tmp_path / "44k.wav"
    scipy.io.wavfile.write(str(path), 44100, np.zeros(44100, dtype=np.int16))
    source = FileAudioSource(path)
    assert len(source.audio_data) == 16000


def test_stereo_becomes_mono(tmp_path):
    import scipy.io.wavfile
    path = tmp_path / "stereo.wav"
    scipy.io.wavfile.write(str(path), 16000, np.zeros((16000, 2), dtype=np.int16))
    assert FileAudioSource(path).audio_data.ndim == 1


def test_a_missing_file_is_an_error(tmp_path):
    with pytest.raises(FileNotFoundError):
        FileAudioSource(tmp_path / "missing.wav")
