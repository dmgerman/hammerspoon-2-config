"""WebSocketServer on its own, with real WebSocket clients on a free port.

Takes the place of the Hammerspoon 1 Spoon's test_tcp_server.py.
"""

import json
import threading
import time

import pytest
from websockets.sync.client import connect

from whisper_stream import WebSocketServer


class Hooks:
    def __init__(self):
        self.connects = 0
        self.disconnects = 0
        self.server = None

    def on_connect(self, server):
        self.connects += 1
        server.send_event("server_ready", connects=self.connects)

    def on_disconnect(self):
        self.disconnects += 1
        # What the recorder does here: end a recording. It must reach no client.
        self.sent_on_disconnect = self.server.send_event("recording_stopped")


@pytest.fixture
def hooks():
    return Hooks()


@pytest.fixture
def server(hooks):
    server = WebSocketServer(0, on_connect=hooks.on_connect, on_disconnect=hooks.on_disconnect)
    hooks.server = server
    yield server
    server.close()


def receive(connection, timeout=5):
    return json.loads(connection.recv(timeout=timeout))


def wait_until(condition, timeout=5):
    deadline = time.time() + timeout
    while time.time() < deadline:
        if condition():
            return True
        time.sleep(0.02)
    return False


def test_port_zero_picks_a_free_port(server):
    assert server.port > 0


def test_a_client_is_greeted(server, hooks):
    with connect(f"ws://127.0.0.1:{server.port}") as client:
        assert receive(client) == {"type": "server_ready", "connects": 1}
        assert server.connected


def test_commands_arrive_in_order(server):
    with connect(f"ws://127.0.0.1:{server.port}") as client:
        receive(client)
        for name in ("start_recording", "status", "stop_recording"):
            client.send(json.dumps({"command": name}))
        received = [server.receive_command(timeout=2)["command"] for _ in range(3)]
        assert received == ["start_recording", "status", "stop_recording"]


def test_receive_command_times_out_with_none(server):
    started = time.time()
    assert server.receive_command(timeout=0.1) is None
    assert time.time() - started < 1


def test_invalid_json_is_answered_with_an_error(server):
    with connect(f"ws://127.0.0.1:{server.port}") as client:
        receive(client)
        client.send("not json")
        event = receive(client)
        assert event["type"] == "error"
        assert "Invalid command JSON" in event["error"]
        client.send("[1, 2]")
        assert receive(client)["type"] == "error"
        assert server.receive_command(timeout=0.2) is None


def test_events_reach_the_client(server):
    with connect(f"ws://127.0.0.1:{server.port}") as client:
        receive(client)
        assert server.send_event("chunk_ready", chunk_num=1, audio_file="/tmp/a b é.wav")
        assert receive(client) == {"type": "chunk_ready", "chunk_num": 1,
                                   "audio_file": "/tmp/a b é.wav"}


def test_sending_with_no_client_returns_false(server):
    assert server.send_event("chunk_ready") is False


def test_events_from_several_threads_arrive_whole(server):
    with connect(f"ws://127.0.0.1:{server.port}") as client:
        receive(client)

        def burst(n):
            for i in range(50):
                server.send_event("chunk_ready", thread=n, i=i)

        threads = [threading.Thread(target=burst, args=(n,)) for n in range(4)]
        for thread in threads:
            thread.start()
        for thread in threads:
            thread.join()
        events = [receive(client) for _ in range(200)]
        assert all(event["type"] == "chunk_ready" for event in events)


def test_disconnecting_calls_on_disconnect_with_no_client(server, hooks):
    with connect(f"ws://127.0.0.1:{server.port}") as client:
        receive(client)
    assert wait_until(lambda: hooks.disconnects == 1)
    assert not server.connected
    assert hooks.sent_on_disconnect is False


def test_a_new_client_can_connect_after_the_last_left(server, hooks):
    with connect(f"ws://127.0.0.1:{server.port}") as client:
        receive(client)
    assert wait_until(lambda: hooks.disconnects == 1)
    with connect(f"ws://127.0.0.1:{server.port}") as client:
        assert receive(client) == {"type": "server_ready", "connects": 2}


def test_a_second_client_takes_over(server, hooks):
    first_context = connect(f"ws://127.0.0.1:{server.port}")
    first = first_context.__enter__()
    receive(first)
    with connect(f"ws://127.0.0.1:{server.port}") as second:
        assert receive(second)["type"] == "server_ready"

        # The first client is told why, and then closed.
        event = receive(first)
        assert event["type"] == "error"
        assert "Another client" in event["error"]
        with pytest.raises(Exception):
            first.recv(timeout=2)

        # Whatever the old client's disconnection sent went nowhere, not to the new one.
        assert hooks.disconnects == 1
        assert hooks.sent_on_disconnect is False

        # Events now go to the second client only, and its commands are heard.
        server.send_event("status")
        assert receive(second)["type"] == "status"
        second.send(json.dumps({"command": "status"}))
        assert server.receive_command(timeout=2) == {"command": "status"}
    first_context.__exit__(None, None, None)
    assert wait_until(lambda: hooks.disconnects == 2)
