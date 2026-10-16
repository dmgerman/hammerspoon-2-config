#!/usr/bin/env python3
"""
Continuous audio recording with Silero VAD for chunk detection.

A long-running server, started by launchd, that any one client at a time talks to over a
WebSocket. Hammerspoon 2 is one client; Emacs is meant to be another. Messages are JSON
objects, one per WebSocket text frame. The protocol is described in the Spoon's readme.

The server loads the VAD model once, at startup. It opens the microphone when a recording
starts and keeps it open for --microphone-idle-timeout seconds after the last one ends, so
that only the first recording after a pause waits for the device to open.
"""

import sys
import json
import argparse
import time
import signal
import threading
import queue
import numpy as np
from pathlib import Path


# === Configuration Constants ===
SILENCE_AMPLITUDE_THRESHOLD = 0.01
VAD_SPEECH_THRESHOLD = 0.25  # Lower threshold = more aggressive speech detection
VAD_CONSECUTIVE_SILENCE_REQUIRED = 2  # Require 2 consecutive silence detections (1.0s) before considering it real silence
VAD_WINDOW_SAMPLES = 512  # Silero VAD scores exactly this many samples at a time, 32 ms at 16 kHz

DEFAULT_PORT = 12341
DEFAULT_OUTPUT_DIR = "/tmp/whisper_dict"
DEFAULT_FILENAME_PREFIX = "recording"


def log(message):
    """One line to stderr, which launchd sends to the log file."""
    print(f"{time.strftime('%Y-%m-%d %H:%M:%S')} {message}", file=sys.stderr, flush=True)


# === WebSocket Transport ===

class WebSocketServer:
    """The event protocol over a WebSocket, one client at a time.

    Commands arrive on the connection's thread and are handed to the command loop through a
    queue, so the recorder sees the same receive_command() whichever thread the client is on.

    A new connection takes over from an existing one rather than being refused. The case
    this is for is a client that went away without closing its connection, such as
    Hammerspoon reloading its configuration: refusing would leave the next client locked out
    until the stale connection timed out.

    on_connect(server) is called once a client is attached, and on_disconnect() once it has
    gone, both on the connection's thread. A client that is replaced is detached *before*
    on_disconnect() runs, so whatever that sends - the end of the old client's recording -
    goes nowhere rather than to the new client.
    """

    def __init__(self, port, host="127.0.0.1", on_connect=None, on_disconnect=None):
        from websockets.sync.server import serve

        self.port = port
        self.host = host
        self.on_connect = on_connect or (lambda server: None)
        self.on_disconnect = on_disconnect or (lambda: None)
        self._client = None
        # Held across a whole connect or disconnect, so that the two never interleave.
        self._attach_lock = threading.RLock()
        # The audio callback thread and the command loop both send.
        self._send_lock = threading.Lock()
        self._commands = queue.Queue()
        self._server = serve(self._handle, host, port)
        if port == 0:
            self.port = self._server.socket.getsockname()[1]
        self._thread = threading.Thread(target=self._server.serve_forever, daemon=True)
        self._thread.start()

    @property
    def connected(self):
        return self._client is not None

    def _send_to(self, connection, event):
        with self._send_lock:
            try:
                connection.send(json.dumps(event))
                return True
            except Exception:
                return False

    def _handle(self, connection):
        with self._attach_lock:
            previous = self._client
            if previous is not None:
                self._client = None
                self._send_to(previous, {"type": "error",
                                         "error": "Another client connected to the server"})
                self.on_disconnect()
                try:
                    previous.close()
                except Exception:
                    pass
                log("client replaced by a new connection")
            self._client = connection
            log("client connected")
            self.on_connect(self)

        try:
            for message in connection:
                if self._client is not connection:
                    break
                try:
                    command = json.loads(message)
                    if not isinstance(command, dict):
                        raise ValueError("not a JSON object")
                except (ValueError, TypeError):
                    self._send_to(connection, {"type": "error",
                                               "error": f"Invalid command JSON: {str(message)[:200]}"})
                    continue
                self._commands.put(command)
        except Exception:
            # The connection failing is a disconnection like any other.
            pass
        finally:
            with self._attach_lock:
                if self._client is connection:
                    self._client = None
                    log("client disconnected")
                    self.on_disconnect()

    def send_event(self, event_type, **kwargs):
        """Send one event to the client. False when there is no client to send it to."""
        client = self._client
        if client is None:
            return False
        return self._send_to(client, {"type": event_type, **kwargs})

    def receive_command(self, timeout=0.1):
        """Next command, or None if none arrived within the timeout."""
        try:
            return self._commands.get(timeout=timeout)
        except queue.Empty:
            return None

    def close(self):
        try:
            self._server.shutdown()
        except Exception:
            pass


# === Dependency Checking ===

def check_dependencies():
    """Check if all required dependencies are installed."""
    missing = []

    try:
        import numpy
    except ImportError:
        missing.append("numpy (install: pip install numpy)")

    try:
        import sounddevice
    except ImportError:
        missing.append("sounddevice (install: pip install sounddevice)")

    try:
        import websockets.sync.server
    except ImportError:
        missing.append("websockets (install: pip install websockets)")

    try:
        import torch
    except ImportError:
        missing.append("torch (install: pip install torch torchaudio)")
    else:
        try:
            import torchaudio
        except ImportError:
            missing.append("torchaudio (install: pip install torchaudio)")
        except Exception as e:
            # A torchaudio built against a mismatched torch version fails at
            # import with e.g. TypeError (metaclass conflict). Treat it as a
            # broken install and report it, rather than crashing the checker.
            missing.append(f"torchaudio (broken install: {type(e).__name__}: {e} — try: pip install --force-reinstall torchaudio)")

    try:
        import scipy.io.wavfile
    except ImportError:
        missing.append("scipy (install: pip install scipy)")

    return missing


# === Audio Processing Helpers ===

def normalize_audio(audio_chunk):
    """Normalize audio to float32 [-1, 1] range."""
    if audio_chunk.dtype == np.int16:
        return audio_chunk.astype(np.float32) / 32768.0
    return audio_chunk.astype(np.float32)


def is_perfect_silence(audio_chunk):
    """Check if audio is essentially zero (microphone off)."""
    audio_float = normalize_audio(audio_chunk)
    max_amplitude = np.max(np.abs(audio_float))
    return max_amplitude < SILENCE_AMPLITUDE_THRESHOLD


def convert_to_int16(audio_data):
    """Convert audio to int16 format for WAV file."""
    if audio_data.dtype == np.float32 or audio_data.dtype == np.float64:
        return (audio_data * 32767).astype(np.int16)
    return audio_data


# === File Audio Source (for testing) ===

class FileAudioSource:
    """Simulates real-time audio streaming from a WAV file for testing."""

    def __init__(self, file_path, sample_rate=16000, chunk_duration=0.5):
        """
        Load audio file and prepare for streaming simulation.

        Args:
            file_path: Path to WAV file
            sample_rate: Expected sample rate (will resample if needed)
            chunk_duration: Duration of each chunk in seconds (matches sounddevice blocksize)
        """
        import scipy.io.wavfile

        self.file_path = Path(file_path)
        if not self.file_path.exists():
            raise FileNotFoundError(f"Test audio file not found: {file_path}")

        # Load audio file
        file_sr, audio_data = scipy.io.wavfile.read(str(self.file_path))

        # Convert to float32 [-1, 1] range
        audio_data = normalize_audio(audio_data)

        # Handle stereo -> mono conversion
        if len(audio_data.shape) > 1:
            audio_data = audio_data[:, 0]  # Take first channel

        # Resample if needed
        if file_sr != sample_rate:
            from scipy import signal
            num_samples = int(len(audio_data) * sample_rate / file_sr)
            audio_data = signal.resample(audio_data, num_samples)

        self.audio_data = audio_data.astype(np.float32)
        self.sample_rate = sample_rate
        self.chunk_size = int(sample_rate * chunk_duration)
        self.position = 0
        self.chunk_duration = chunk_duration

    def rewind(self):
        """Start again from the beginning, for the next recording."""
        self.position = 0

    def read_chunk(self):
        """
        Read next chunk of audio data.

        Returns:
            numpy array of shape (chunk_size, 1) or None if EOF
        """
        if self.position >= len(self.audio_data):
            return None

        # Extract chunk
        end_pos = min(self.position + self.chunk_size, len(self.audio_data))
        chunk = self.audio_data[self.position:end_pos]
        self.position = end_pos

        # Pad last chunk if needed
        if len(chunk) < self.chunk_size:
            chunk = np.pad(chunk, (0, self.chunk_size - len(chunk)), mode='constant')

        # Return as (N, 1) shape to match sounddevice format
        return chunk.reshape(-1, 1)


# === Continuous Recorder ===

class MicrophoneError(Exception):
    """The microphone could not be opened."""


class ContinuousRecorder:
    """Records audio and detects chunk boundaries using Silero VAD.

    One recording at a time, any number of them over the life of the process. Settings
    given to start_recording() apply to that recording only; the constructor's are the
    defaults for the ones it leaves out.

    Two threads touch the recording state: the audio callback, and whichever thread starts,
    stops or abandons a recording (the command loop, or a WebSocket thread when a client
    disconnects). self.lock is held by both.
    """

    def __init__(self, transport, output_dir=DEFAULT_OUTPUT_DIR,
                 filename_prefix=DEFAULT_FILENAME_PREFIX,
                 silence_threshold=2.0,
                 min_chunk_duration=3.0,
                 max_chunk_duration=600.0,
                 sample_rate=16000,
                 audio_source=None,
                 audio_input_device=None,
                 perfect_silence_duration=0.0,
                 microphone_idle_timeout=300.0,
                 microphone_open_timeout=10.0,
                 verbose=False,
                 vad_model=None,
                 sounddevice=None):
        self.transport = transport
        self.defaults = {
            "output_dir": str(output_dir),
            "filename_prefix": filename_prefix,
            "silence_threshold": silence_threshold,
            "min_chunk_duration": min_chunk_duration,
            "max_chunk_duration": max_chunk_duration,
            "perfect_silence_duration": perfect_silence_duration,
            "audio_input": audio_input_device,
        }
        self.sample_rate = sample_rate
        self.audio_source = audio_source  # A FileAudioSource replaces the microphone
        self.microphone_idle_timeout = microphone_idle_timeout
        self.microphone_open_timeout = microphone_open_timeout
        self.verbose = verbose  # Emit periodic RMS to stderr for diagnostics
        self._sd = sounddevice

        self.lock = threading.RLock()

        # Diagnostic: last time we logged an RMS sample (seconds since epoch)
        self._last_rms_log_time = 0.0
        self._rms_log_interval = 1.0  # seconds between RMS log lines

        # The settings of the recording in progress; see _apply_settings.
        self._apply_settings({})

        # Chunk state
        self.chunk_num = 0
        self.current_chunk_audio = []
        self.current_chunk_start_time = None

        # Full recording (all audio for single file save)
        self.all_audio = []

        # Silence detection state
        self.silence_start_time = None
        self.perfect_silence_start_time = None
        self.startup_silence_check_done = False
        self.consecutive_silence_count = 0  # Count consecutive silence detections
        # Whether any block of the current chunk contained speech; sent with the chunk.
        self.chunk_speech = False

        # Control
        self.running = True
        self.recording = False  # Whether currently recording
        self.mic_off = False  # Track if stopped due to mic being off
        self.session = 0  # Incremented by each recording, so stale threads can tell

        # The microphone: open from a recording's start until it has been idle for
        # microphone_idle_timeout seconds.
        self.stream = None
        self.stream_device = None
        self._idle_timer = None

        # Load VAD model
        self.vad_model = vad_model if vad_model is not None else self._load_vad_model()

    def _load_vad_model(self):
        """Load Silero VAD model."""
        try:
            import torch
            model, _ = torch.hub.load(
                repo_or_dir='snakers4/silero-vad',
                model='silero_vad',
                force_reload=False,
                onnx=False,
                trust_repo=True
            )
            model.eval()
            return model
        except Exception as e:
            raise ImportError(f"Failed to load Silero VAD model: {e}")

    def _sounddevice(self):
        if self._sd is None:
            import sounddevice
            self._sd = sounddevice
        return self._sd

    # --- Settings ---

    def _apply_settings(self, command):
        """Take this recording's settings from COMMAND, falling back to the defaults."""
        def setting(name, convert):
            value = command.get(name)
            return convert(self.defaults[name] if value is None else value)

        self.output_dir = setting("output_dir", Path)
        self.filename_prefix = setting("filename_prefix", str)
        self.silence_threshold = setting("silence_threshold", float)
        self.min_chunk_duration = setting("min_chunk_duration", float)
        self.max_chunk_duration = setting("max_chunk_duration", float)
        self.perfect_silence_duration = setting("perfect_silence_duration", float)
        self.audio_input_device = command.get("audio_input") or self.defaults["audio_input"]

    def status(self):
        """What a client is told on connecting, and in answer to a status command."""
        return {
            "recording": self.recording,
            "microphone_open": self.stream is not None,
            "device": self.stream_device,
            "test_file": str(self.audio_source.file_path) if self.audio_source else None,
        }

    # --- Microphone ---

    def _device_index(self, name):
        if not name:
            return None
        for index, device in enumerate(self._sounddevice().query_devices()):
            if device['name'] == name and device['max_input_channels'] > 0:
                return index
        raise MicrophoneError(f"Audio input device not found: {name}")

    def _microphone_open(self, name):
        """Have the microphone NAME (None: the system default) open and delivering audio.

        Does nothing when it already is. Raises MicrophoneError when it cannot be opened.
        The open runs in a worker thread with a time limit, because PortAudio blocks
        indefinitely when this process has no microphone permission, and a server stuck
        there would answer nothing.
        """
        self._idle_timer_cancel()
        if self.stream is not None and self.stream_device == name:
            return
        self._microphone_close()

        sd = self._sounddevice()
        device = self._device_index(name)
        outcome = {}

        def open_stream():
            try:
                stream = sd.InputStream(callback=self.audio_callback,
                                        device=device,
                                        channels=1,
                                        samplerate=self.sample_rate,
                                        blocksize=int(self.sample_rate * 0.5),
                                        dtype=np.float32)
                stream.start()
                outcome["stream"] = stream
            except Exception as e:
                outcome["error"] = e

        started = time.time()
        opener = threading.Thread(target=open_stream, daemon=True)
        opener.start()
        opener.join(self.microphone_open_timeout)
        if opener.is_alive():
            raise MicrophoneError(
                f"The microphone did not open within {self.microphone_open_timeout:g} s. "
                "The usual cause is that this process has no microphone permission; see "
                "System Settings > Privacy & Security > Microphone.")
        if "error" in outcome:
            raise MicrophoneError(f"Microphone error: {outcome['error']}")

        self.stream = outcome["stream"]
        self.stream_device = name
        log(f"microphone opened ({name or 'system default'}) in {time.time() - started:.2f} s")

    def _microphone_close(self):
        self._idle_timer_cancel()
        stream, self.stream = self.stream, None
        if stream is None:
            return
        try:
            stream.stop()
            stream.close()
        except Exception as e:
            log(f"closing the microphone failed: {e}")
        log("microphone closed")

    def _idle_timer_cancel(self):
        if self._idle_timer is not None:
            self._idle_timer.cancel()
            self._idle_timer = None

    def _idle_timer_start(self):
        """Close the microphone once it has gone microphone_idle_timeout s unused."""
        self._idle_timer_cancel()
        if self.stream is None:
            return

        def expire():
            with self.lock:
                if not self.recording:
                    self._microphone_close()

        self._idle_timer = threading.Timer(self.microphone_idle_timeout, expire)
        self._idle_timer.daemon = True
        self._idle_timer.start()

    # --- Recording ---

    def _reset_recording_state(self):
        """Reset state for a new recording session."""
        self.chunk_num = 0
        self.current_chunk_audio = []
        self.current_chunk_start_time = None
        self.all_audio = []
        self.silence_start_time = None
        self.perfect_silence_start_time = None
        self.startup_silence_check_done = False
        self.mic_off = False
        self.consecutive_silence_count = 0
        self.chunk_speech = False

    def start_recording(self, command):
        """Begin a recording with the settings in COMMAND."""
        if self.recording:
            self.transport.send_event("error", error="Already recording")
            return

        self._apply_settings(command)
        try:
            if self.audio_source is None:
                self._microphone_open(self.audio_input_device)
        except MicrophoneError as e:
            log(str(e))
            self.transport.send_event("error", error=str(e))
            self.transport.send_event("recording_stopped")
            return

        with self.lock:
            self._reset_recording_state()
            self.session += 1
            self.recording = True
            self.current_chunk_start_time = time.time()

        log(f"recording started: {self.filename_prefix}")
        self.transport.send_event(
            "recording_started",
            device=str(self.audio_source.file_path) if self.audio_source else self.stream_device)

        if self.audio_source is not None:
            self._file_feed_start(self.session)

    def stop_recording(self):
        with self.lock:
            self._finalize_recording()

    def client_disconnected(self):
        """The client has gone: end its recording, keeping what was recorded."""
        with self.lock:
            if self.recording:
                log("client went away while recording; finalizing")
                self._finalize_recording()

    def _file_feed_start(self, session):
        """Play the test file into the recording, in real time, as the microphone would.

        Each recording plays it from the beginning, and the end of the file ends the
        recording - not the server.
        """
        self.audio_source.rewind()

        def feed():
            while True:
                with self.lock:
                    if not self.recording or self.session != session:
                        return
                    chunk = self.audio_source.read_chunk()
                    if chunk is None:
                        self._finalize_recording()
                        return
                self.audio_callback(chunk, len(chunk), None, None)
                time.sleep(self.audio_source.chunk_duration)

        threading.Thread(target=feed, daemon=True).start()

    def _detect_voice_activity(self, audio_block):
        """Whether a block of audio contains speech.

        Silero VAD scores one window of VAD_WINDOW_SAMPLES at a time. Every window in the
        block is scored, in order, and the highest score decides. Scoring only the last
        window, as this did before, missed speech that ended earlier in the block: a 0.5 s
        block holds 15 windows, so a short word could fall entirely outside the one scored.
        On the long test fixture it missed speech in three blocks, and scored the speech it
        did find at 0.3 to 0.6 where the whole block scores 0.99.
        """
        try:
            import torch
            audio = normalize_audio(audio_block)
            if len(audio) < VAD_WINDOW_SAMPLES:
                audio = np.pad(audio, (0, VAD_WINDOW_SAMPLES - len(audio)))
            # Every window is scored, with no early exit, because the model carries state
            # from one window to the next.
            best = 0.0
            for start in range(0, len(audio) - VAD_WINDOW_SAMPLES + 1, VAD_WINDOW_SAMPLES):
                window = np.ascontiguousarray(audio[start:start + VAD_WINDOW_SAMPLES])
                best = max(best, self.vad_model(torch.from_numpy(window), self.sample_rate).item())
            return best > VAD_SPEECH_THRESHOLD
        except Exception as e:
            self.transport.send_event("error", error=f"VAD detection error: {e}")
            return True  # Assume speech to avoid losing audio

    def _save_chunk(self):
        """Save current chunk audio to WAV file.

        Returns (path, peak, speech). peak is the max absolute amplitude on the float32
        buffer in [0, 1]. The client uses the first chunk's peak to reject a recording early
        when the microphone is delivering silence. speech is whether the VAD found speech in
        any block of the chunk; the client can skip a chunk without it, which Whisper would
        otherwise transcribe as something like "Thank you."
        """
        if not self.current_chunk_audio:
            return None, 0.0, False

        self.chunk_num += 1
        chunk_file = self.output_dir / f"{self.filename_prefix}_chunk_{self.chunk_num:03d}.wav"

        # Ensure output directory exists
        self.output_dir.mkdir(parents=True, exist_ok=True)

        audio_data = np.concatenate(self.current_chunk_audio)
        # Compute peak on the float32 buffer BEFORE int16 conversion so the
        # value stays in a stable [0, 1] range independent of dtype.
        peak = float(np.max(np.abs(audio_data))) if audio_data.size > 0 else 0.0
        audio_data = convert_to_int16(audio_data)

        import scipy.io.wavfile
        scipy.io.wavfile.write(str(chunk_file), self.sample_rate, audio_data)

        speech = self.chunk_speech

        # Reset for next chunk
        self.current_chunk_audio = []
        self.current_chunk_start_time = time.time()
        self.chunk_speech = False

        return str(chunk_file), peak, speech

    def _check_perfect_silence(self, audio_chunk):
        """Check for perfect silence at startup only - verify mic is working."""
        # Only check during startup period
        if self.startup_silence_check_done:
            return

        if not is_perfect_silence(audio_chunk):
            # Audio detected, mic is working - stop checking
            self.startup_silence_check_done = True
            self.perfect_silence_start_time = None
            return

        if self.perfect_silence_start_time is None:
            self.perfect_silence_start_time = time.time()
            return

        silence_duration = time.time() - self.perfect_silence_start_time
        # Check if perfect silence detection is enabled (> 0) and threshold exceeded
        if self.perfect_silence_duration > 0 and silence_duration >= self.perfect_silence_duration:
            # The microphone is off. That ends this recording, not the server.
            self.transport.send_event("silence_warning",
                                      message="Microphone off - stopping recording")
            self.mic_off = True
            self.startup_silence_check_done = True
            self._finalize_recording()

    def _emit_chunk_ready(self, chunk_file, is_final=False, peak=0.0, speech=True):
        """Emit chunk_ready event.

        A client that has gone simply misses it: the file is on disk either way.
        """
        if chunk_file:
            self.transport.send_event("chunk_ready",
                                      chunk_num=self.chunk_num,
                                      audio_file=chunk_file,
                                      is_final=is_final,
                                      peak=peak,
                                      speech=speech)

    def _check_max_duration(self):
        """Check if chunk exceeded max duration and save if needed."""
        chunk_duration = time.time() - self.current_chunk_start_time
        if chunk_duration >= self.max_chunk_duration:
            chunk_file, peak, speech = self._save_chunk()
            self._emit_chunk_ready(chunk_file, is_final=False, peak=peak, speech=speech)
            return True
        return False

    def _check_silence_boundary(self):
        """Check if silence threshold reached and save chunk if needed."""
        chunk_duration = time.time() - self.current_chunk_start_time

        if self.silence_start_time is None:
            return False

        silence_duration = time.time() - self.silence_start_time
        if silence_duration >= self.silence_threshold:
            if chunk_duration >= self.min_chunk_duration:
                chunk_file, peak, speech = self._save_chunk()
                self._emit_chunk_ready(chunk_file, is_final=False, peak=peak, speech=speech)
                self.silence_start_time = None
                self.consecutive_silence_count = 0
                return True
        return False

    def _process_vad(self, audio_block):
        """Process VAD for one block and update silence tracking."""
        has_voice = self._detect_voice_activity(audio_block)

        if has_voice:
            self.chunk_speech = True
            # Speech detected - reset silence tracking
            self.silence_start_time = None
            self.consecutive_silence_count = 0
        else:
            # No speech - increment consecutive silence counter
            self.consecutive_silence_count += 1

            # Only start silence timer after consecutive detections
            if self.consecutive_silence_count >= VAD_CONSECUTIVE_SILENCE_REQUIRED:
                if self.silence_start_time is None:
                    self.silence_start_time = time.time()

    def audio_callback(self, indata, frames, time_info, status):
        """Callback for sounddevice audio stream."""
        if status:
            self.transport.send_event("error", error=f"Audio callback status: {status}")

        # Diagnostic: emit periodic RMS/peak so we can tell whether the mic is
        # producing samples at all, even before recording is armed. Rate-limited
        # to ~1 line/sec so the log stays readable.
        if self.verbose:
            now = time.time()
            if now - self._last_rms_log_time >= self._rms_log_interval:
                self._last_rms_log_time = now
                mono = indata[:, 0]
                # RMS on the raw float32 samples (already in [-1, 1] range)
                rms = float(np.sqrt(np.mean(mono.astype(np.float64) ** 2)))
                peak = float(np.max(np.abs(mono)))
                log(f"audio rms={rms:.5f} peak={peak:.5f} "
                    f"frames={frames} recording={self.recording}")

        with self.lock:
            # Only process audio if actively recording
            if not self.recording:
                return

            # Extract mono audio
            audio_chunk = indata[:, 0].copy()

            # Check for mic off
            self._check_perfect_silence(audio_chunk)
            if not self.recording:
                return

            # Add to current chunk
            self.current_chunk_audio.append(audio_chunk)
            # Also accumulate for complete recording file
            self.all_audio.append(audio_chunk)

            # VAD on this block before a cut at the maximum duration, so that the chunk
            # the block ends is the one credited with any speech in it.
            self._process_vad(audio_chunk)

            # Check max duration boundary
            if self._check_max_duration():
                return

            # Check VAD-based silence boundary
            self._check_silence_boundary()

    def _save_complete_recording(self):
        """Save complete recording as single timestamped file."""
        if not self.all_audio:
            return None

        from datetime import datetime
        timestamp = datetime.now().strftime("%Y%m%d-%H%M%S")
        complete_file = self.output_dir / f"{self.filename_prefix}-{timestamp}.wav"

        # Ensure output directory exists
        self.output_dir.mkdir(parents=True, exist_ok=True)

        audio_data = np.concatenate(self.all_audio)
        audio_data = convert_to_int16(audio_data)

        import scipy.io.wavfile
        scipy.io.wavfile.write(str(complete_file), self.sample_rate, audio_data)

        return str(complete_file)

    def _finalize_recording(self):
        """Save the final chunk, emit recording_stopped, and start the idle timer.

        The caller holds self.lock.
        """
        if not self.recording:
            return  # Already finalized
        self.recording = False

        # Save complete recording as single file (for auditing/re-processing)
        complete_file = self._save_complete_recording()
        if complete_file:
            self.transport.send_event("complete_file", file_path=complete_file)

        # Don't save or transcribe final chunk if mic was off
        if not self.mic_off and self.current_chunk_audio:
            chunk_file, peak, speech = self._save_chunk()
            self._emit_chunk_ready(chunk_file, is_final=True, peak=peak, speech=speech)

        self.transport.send_event("recording_stopped")
        log("recording stopped")
        self._idle_timer_start()

    # --- Command loop ---

    def handle_command(self, command):
        name = command.get('command')
        if name == 'start_recording':
            self.start_recording(command)
        elif name == 'stop_recording':
            self.stop_recording()
        elif name == 'status':
            self.transport.send_event("status", **self.status())
        else:
            self.transport.send_event("error", error=f"Unknown command: {name}")

    def run(self):
        """Answer commands until self.running is cleared (by a signal)."""
        while self.running:
            command = self.transport.receive_command(timeout=0.1)
            if command:
                try:
                    self.handle_command(command)
                except Exception as e:
                    log(f"command {command.get('command')} failed: {e}")
                    self.transport.send_event("error", error=f"Command failed: {e}")

    def shutdown(self):
        """End any recording, keeping it, and release the microphone."""
        with self.lock:
            self._finalize_recording()
            self._microphone_close()


# === Main ===

def main():
    parser = argparse.ArgumentParser(
        description="Continuous audio recording with Silero VAD, served over a WebSocket"
    )
    parser.add_argument("--check-deps", action="store_true",
                        help="Check dependencies and exit")
    parser.add_argument("--port", type=int, default=DEFAULT_PORT,
                        help=f"WebSocket port on 127.0.0.1 (default {DEFAULT_PORT}; 0 picks a free one)")
    parser.add_argument("--output-dir", default=DEFAULT_OUTPUT_DIR,
                        help="Default directory for recordings")
    parser.add_argument("--filename-prefix", default=DEFAULT_FILENAME_PREFIX,
                        help="Default prefix for recording file names")
    parser.add_argument("--silence-threshold", type=float, default=2.0,
                        help="Silence duration to trigger chunk (seconds)")
    parser.add_argument("--min-chunk-duration", type=float, default=3.0,
                        help="Minimum chunk duration (seconds)")
    parser.add_argument("--max-chunk-duration", type=float, default=600.0,
                        help="Maximum chunk duration (seconds)")
    parser.add_argument("--test-file",
                        help="WAV file to play into each recording instead of the microphone")
    parser.add_argument("--audio-input", help="Default audio input device name")
    parser.add_argument("--perfect-silence-duration", type=float, default=0.0,
                        help="Duration of perfect silence to detect mic off (seconds, 0 = disabled)")
    parser.add_argument("--microphone-idle-timeout", type=float, default=300.0,
                        help="Seconds the microphone stays open after a recording ends")
    parser.add_argument("--microphone-open-timeout", type=float, default=10.0,
                        help="Seconds to wait for the microphone to open")
    parser.add_argument("--verbose", action="store_true",
                        help="Log periodic RMS/peak audio levels to stderr")

    args = parser.parse_args()

    if args.check_deps:
        missing = check_dependencies()
        if missing:
            print(json.dumps({"status": "error", "missing": missing}))
            sys.exit(1)
        print(json.dumps({"status": "ok"}))
        sys.exit(0)

    audio_source = None
    if args.test_file:
        try:
            audio_source = FileAudioSource(args.test_file)
        except Exception as e:
            log(f"failed to load test file: {e}")
            sys.exit(1)

    recorder = None
    transport = None

    def stop_for_signal(sig, frame):
        # The command loop notices within its 0.1 s poll; shutdown() then keeps
        # whatever was being recorded and releases the device.
        if recorder is not None:
            recorder.running = False
        else:
            sys.exit(0)

    signal.signal(signal.SIGINT, stop_for_signal)
    signal.signal(signal.SIGTERM, stop_for_signal)

    try:
        # The model loads before the port opens, so a client never connects to a server
        # that is not yet able to record.
        recorder = ContinuousRecorder(
            None,
            args.output_dir,
            args.filename_prefix,
            args.silence_threshold,
            args.min_chunk_duration,
            args.max_chunk_duration,
            audio_source=audio_source,
            audio_input_device=args.audio_input,
            perfect_silence_duration=args.perfect_silence_duration,
            microphone_idle_timeout=args.microphone_idle_timeout,
            microphone_open_timeout=args.microphone_open_timeout,
            verbose=args.verbose,
        )
        transport = WebSocketServer(
            args.port,
            on_connect=lambda server: server.send_event("server_ready", **recorder.status()),
            on_disconnect=recorder.client_disconnected)
        recorder.transport = transport
        # The port line is what a test that started the server with --port 0 reads.
        log(json.dumps({"status": "listening", "port": transport.port,
                        "test_file": args.test_file}))
        recorder.run()
    except Exception as e:
        log(f"fatal: {e}")
        import traceback
        traceback.print_exc(file=sys.stderr)
        sys.exit(1)
    finally:
        if recorder is not None:
            recorder.shutdown()
        if transport is not None:
            transport.close()
        log("stopped")


if __name__ == "__main__":
    main()
