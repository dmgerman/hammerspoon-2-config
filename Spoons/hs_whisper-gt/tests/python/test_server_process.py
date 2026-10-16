"""whisper_stream.py as a real process, driven over a real WebSocket.

--test-file stands in for the microphone: every recording plays the file from the start,
in real time, and the end of the file ends the recording.
"""

import signal
import time
from pathlib import Path

import pytest


def chunks_of(client):
    return [event for event in client.events if event["type"] == "chunk_ready"]


def record_whole_file(client, tmp_path, prefix, timeout=20):
    client.send("start_recording", filename_prefix=prefix, output_dir=str(tmp_path))
    client.wait_for("recording_started")
    client.wait_for("recording_stopped", timeout=timeout)


def test_a_client_is_told_the_server_state(start_server, connect, short_wav):
    server = start_server(short_wav)
    client = connect(server)
    ready = client.wait_for("server_ready")
    assert ready["recording"] is False
    assert ready["microphone_open"] is False
    assert ready["test_file"] == str(short_wav)


def test_status_answers(start_server, connect, short_wav):
    client = connect(start_server(short_wav))
    client.wait_for("server_ready")
    client.send("status")
    assert client.wait_for("status")["recording"] is False


def test_unknown_commands_are_errors(start_server, connect, short_wav):
    client = connect(start_server(short_wav))
    client.wait_for("server_ready")
    client.send("dance")
    assert "Unknown command" in client.wait_for("error")["error"]


def test_a_short_recording(start_server, connect, short_wav, tmp_path):
    client = connect(start_server(short_wav))
    client.wait_for("server_ready")
    record_whole_file(client, tmp_path, "en-short")

    chunks = chunks_of(client)
    assert len(chunks) == 1
    assert chunks[0]["chunk_num"] == 1
    assert chunks[0]["is_final"] is True
    assert chunks[0]["peak"] > 0.01
    assert chunks[0]["speech"] is True
    assert chunks[0]["audio_file"] == str(tmp_path / "en-short_chunk_001.wav")
    assert Path(chunks[0]["audio_file"]).stat().st_size > 1000

    complete = client.wait_for("complete_file")["file_path"]
    assert Path(complete).name.startswith("en-short-")
    assert client.types().index("complete_file") < client.types().index("chunk_ready")


def test_stop_ends_a_recording_early(start_server, connect, long_wav, tmp_path):
    client = connect(start_server(long_wav))
    client.wait_for("server_ready")
    client.send("start_recording", filename_prefix="early", output_dir=str(tmp_path))
    client.wait_for("recording_started")
    time.sleep(2)
    client.send("stop_recording")
    client.wait_for("recording_stopped", timeout=5)
    assert chunks_of(client)[-1]["is_final"] is True


def test_starting_twice_is_an_error(start_server, connect, long_wav, tmp_path):
    client = connect(start_server(long_wav))
    client.wait_for("server_ready")
    client.send("start_recording", output_dir=str(tmp_path))
    client.wait_for("recording_started")
    client.send("start_recording", output_dir=str(tmp_path))
    assert client.wait_for("error")["error"] == "Already recording"
    client.send("stop_recording")
    client.wait_for("recording_stopped")


def test_each_recording_uses_its_own_settings(start_server, connect, short_wav, tmp_path):
    client = connect(start_server(short_wav))
    client.wait_for("server_ready")
    record_whole_file(client, tmp_path / "one", "first")
    record_whole_file(client, tmp_path / "two", "second")
    assert (tmp_path / "one" / "first_chunk_001.wav").exists()
    assert (tmp_path / "two" / "second_chunk_001.wav").exists()


@pytest.mark.slow
def test_a_long_recording_is_cut_into_chunks(start_server, connect, long_wav, tmp_path):
    client = connect(start_server(long_wav))
    client.wait_for("server_ready")
    client.send("start_recording", filename_prefix="en-long", output_dir=str(tmp_path),
                silence_threshold=1.0, min_chunk_duration=3.0)
    client.wait_for("recording_started")
    client.wait_for("recording_stopped", timeout=60)

    chunks = chunks_of(client)
    assert len(chunks) > 1
    assert [chunk["chunk_num"] for chunk in chunks] == list(range(1, len(chunks) + 1))
    # Only the last chunk can be final, and it need not be: a final chunk is sent only when
    # audio is left over after the last cut, and with this fixture the last cut can fall at
    # its very end.
    assert not any(chunk["is_final"] for chunk in chunks[:-1])
    assert all(Path(chunk["audio_file"]).exists() for chunk in chunks)
    assert len([e for e in client.events if e["type"] == "complete_file"]) == 1
    # The fixture is speech followed by about seven seconds of silence, which Whisper
    # transcribes as "Thank you." The chunks cut from that silence say they have no speech.
    assert chunks[0]["speech"] is True
    assert chunks[-1]["speech"] is False


def test_a_client_leaving_mid_recording_keeps_the_recording(start_server, connect, long_wav, tmp_path):
    server = start_server(long_wav)
    client = connect(server)
    client.wait_for("server_ready")
    client.send("start_recording", filename_prefix="left", output_dir=str(tmp_path))
    client.wait_for("recording_started")
    time.sleep(2)
    client.close()

    # The recording is finished without its client, and the server waits for the next.
    # The complete recording is written first and the final chunk after it.
    final_chunk = tmp_path / "left_chunk_001.wav"
    deadline = time.time() + 5
    while time.time() < deadline and not final_chunk.exists():
        time.sleep(0.1)
    assert final_chunk.exists()
    assert list(tmp_path.glob("left-*.wav"))
    assert server.running()

    again = connect(server)
    assert again.wait_for("server_ready")["recording"] is False
    again.send("start_recording", filename_prefix="again", output_dir=str(tmp_path))
    again.wait_for("recording_started")
    again.send("stop_recording")
    again.wait_for("recording_stopped")


def test_a_new_client_takes_over_a_recording(start_server, connect, long_wav, tmp_path):
    server = start_server(long_wav)
    first = connect(server)
    first.wait_for("server_ready")
    first.send("start_recording", filename_prefix="first", output_dir=str(tmp_path))
    first.wait_for("recording_started")
    time.sleep(1.5)

    second = connect(server)
    assert second.wait_for("server_ready")["recording"] is False
    assert "Another client" in first.wait_for("error")["error"]
    assert first.closed.wait(5)

    # The first client's recording ended with nothing sent to the second.
    assert (tmp_path / "first_chunk_001.wav").exists()
    assert "chunk_ready" not in second.types()
    assert "recording_stopped" not in second.types()

    second.send("start_recording", filename_prefix="second", output_dir=str(tmp_path))
    second.wait_for("recording_started")
    second.send("stop_recording")
    assert second.wait_for("chunk_ready")["audio_file"].endswith("second_chunk_001.wav")


def test_sigterm_keeps_the_recording_and_exits_cleanly(start_server, connect, long_wav, tmp_path):
    server = start_server(long_wav)
    client = connect(server)
    client.wait_for("server_ready")
    client.send("start_recording", filename_prefix="term", output_dir=str(tmp_path))
    client.wait_for("recording_started")
    time.sleep(2)

    assert server.stop(signal.SIGTERM) == 0
    final = client.wait_for("chunk_ready", timeout=5)
    assert final["is_final"] is True
    assert (tmp_path / "term_chunk_001.wav").exists()
    assert list(tmp_path.glob("term-*.wav"))


def test_an_idle_server_keeps_running_without_clients(start_server, short_wav):
    server = start_server(short_wav)
    time.sleep(3)
    assert server.running()


def test_a_silent_microphone_ends_the_recording_not_the_server(
        start_server, connect, silent_wav, tmp_path):
    server = start_server(silent_wav)
    client = connect(server)
    client.wait_for("server_ready")
    client.send("start_recording", filename_prefix="mute", output_dir=str(tmp_path),
                perfect_silence_duration=1.0)
    client.wait_for("recording_started")
    assert "Microphone off" in client.wait_for("silence_warning", timeout=5)["message"]
    client.wait_for("recording_stopped")
    assert "chunk_ready" not in client.types()
    assert server.running()

    client.send("status")
    assert client.wait_for("status")["recording"] is False
