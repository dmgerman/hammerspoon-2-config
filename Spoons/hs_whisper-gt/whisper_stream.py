#!/usr/bin/env python3
"""
Continuous audio recording with Silero VAD for chunk detection.

Outputs JSON events to stdout for Hammerspoon integration.
"""

import sys
import json
import argparse
import time
import signal
import socket
import threading
import queue
import numpy as np
from pathlib import Path


# === Configuration Constants ===
SILENCE_AMPLITUDE_THRESHOLD = 0.01
PERFECT_SILENCE_DURATION_AT_START = 2.0  # Detect mic off at recording start
VAD_SPEECH_THRESHOLD = 0.25  # Lower threshold = more aggressive speech detection
VAD_WINDOW_SECONDS = 0.5
VAD_CONSECUTIVE_SILENCE_REQUIRED = 2  # Require 2 consecutive silence detections (1.0s) before considering it real silence


# === Event Output ===

def output_event(event_type, **kwargs):
    """Output a JSON event to stdout."""
    event = {"type": event_type, **kwargs}
    print(json.dumps(event), flush=True)


def output_error(error_msg):
    """Output an error event."""
    output_event("error", error=str(error_msg))

def output_debug(msg):
    """Output a debug event."""
    output_event("debug", message=str(msg))


# === Stdio Transport ===

class StdioServer:
    """The event protocol over this process's own stdin and stdout.

    Hammerspoon 2 has no socket module, so a client there cannot open a TCP
    connection. It can write to a task's stdin and read its stdout, which
    carries the same newline-delimited JSON in both directions and needs no
    port: nothing to find free, nothing left listening, and the server exits
    with whoever started it.

    Interface-compatible with TCPServer. The two wait methods are stubs
    because a pipe has no connection to establish -- it is there as soon as
    the process is.
    """

    def __init__(self):
        # Named for symmetry with TCPServer, where it is the listening port.
        self.port = None
        # stdout is written from the audio callback thread as well as from the
        # command loop, and a half-written line would not parse.
        self._lock = threading.Lock()
        self._lines = queue.Queue()
        self._reader = threading.Thread(target=self._read_stdin, daemon=True)
        self._reader.start()

    def _read_stdin(self):
        """Read commands in a thread, so receive_command can offer a timeout.

        Reading stdin blocks until a line arrives, and the command loop must
        not block: it has to keep returning to the audio processing between
        commands. So the blocking read lives here and hands lines over.
        """
        for line in sys.stdin:
            line = line.strip()
            if line:
                self._lines.put(line)
        # End of input: whoever was sending commands has gone.
        self._lines.put(None)

    def wait_for_client(self, timeout=10):
        return True

    def wait_for_reconnect(self, timeout=None):
        # Our stdin cannot reopen once it has ended, so there is nothing to
        # wait for. False tells the command loop to shut down.
        return False

    def send_event(self, event_type, **kwargs):
        """Send one event. False means the far end has gone."""
        with self._lock:
            try:
                print(json.dumps({"type": event_type, **kwargs}), flush=True)
                return True
            except (BrokenPipeError, ValueError):
                return False

    def receive_command(self, timeout=0.1):
        """Next command, or None if none arrived within the timeout."""
        try:
            line = self._lines.get(timeout=timeout)
        except queue.Empty:
            return None

        if line is None:
            # stdin ended, so the client exited without saying so. Report it
            # as the shutdown it amounts to, rather than spinning on EOF.
            return {"command": "shutdown"}

        try:
            return json.loads(line)
        except json.JSONDecodeError:
            self.send_event("error", error=f"Invalid command JSON: {line[:200]}")
            return None

    def close(self):
        pass


# === TCP Server ===

class TCPServer:
    """TCP server for sending events to Hammerspoon client."""

    def __init__(self, port):
        self.server_socket = socket.socket(socket.AF_INET, socket.SOCK_STREAM)
        self.server_socket.setsockopt(socket.SOL_SOCKET, socket.SO_REUSEADDR, 1)
        self.server_socket.bind(('127.0.0.1', port))
        self.server_socket.listen(1)
        self.client_socket = None
        self.port = port

    def wait_for_client(self, timeout=10):
        """Accept single client connection with timeout."""
        self.server_socket.settimeout(timeout)
        try:
            self.client_socket, addr = self.server_socket.accept()
            self.client_socket.settimeout(None)  # Blocking mode for send
            return True
        except socket.timeout:
            return False

    def send_event(self, event_type, **kwargs):
        """Send JSON event with newline delimiter.

        Returns False if client disconnected, True otherwise.
        """
        if self.client_socket:
            event = {"type": event_type, **kwargs}
            message = json.dumps(event) + "\n"
            try:
                self.client_socket.sendall(message.encode('utf-8'))
                return True
            except (BrokenPipeError, ConnectionResetError, OSError):
                # Client disconnected
                return False
        return True

    def receive_command(self, timeout=0.1):
        """Receive a command from client (non-blocking).

        Returns command dict if received, None otherwise.
        """
        if not self.client_socket:
            return None

        try:
            self.client_socket.settimeout(timeout)
            data = self.client_socket.recv(1024)
            if not data:
                # Client disconnected
                return {'command': 'disconnect'}

            # Parse JSON command (newline-delimited)
            for line in data.decode('utf-8').split('\n'):
                line = line.strip()
                if line:
                    try:
                        return json.loads(line)
                    except json.JSONDecodeError:
                        pass
        except socket.timeout:
            # No data available (normal)
            return None
        except (ConnectionResetError, BrokenPipeError):
            # Client disconnected
            return {'command': 'disconnect'}

        return None

    def wait_for_reconnect(self, timeout=None):
        """Wait for a new client connection after previous client disconnected.

        Returns True if client connected, False on timeout.
        """
        if self.client_socket:
            # Close old connection
            try:
                self.client_socket.close()
            except:
                pass
            self.client_socket = None

        self.server_socket.settimeout(timeout)
        try:
            self.client_socket, addr = self.server_socket.accept()
            self.client_socket.settimeout(None)
            return True
        except socket.timeout:
            return False

    def close(self):
        """Close server and client sockets."""
        if self.client_socket:
            try:
                self.client_socket.close()
            except:
                pass
            self.client_socket = None
        if self.server_socket:
            try:
                self.server_socket.close()
            except:
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

    has_torch = False
    has_onnx = False
    try:
        import torch
        has_torch = True
    except ImportError:
        pass

    try:
        import onnxruntime
        has_onnx = True
    except ImportError:
        pass

    if not has_torch and not has_onnx:
        missing.append("torch or onnxruntime (install: pip install torch torchaudio OR pip install onnxruntime)")

    if has_torch:
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

    def stream_to_callback(self, callback, simulate_realtime=True):
        """
        Stream audio chunks to callback function, simulating real-time behavior.

        Args:
            callback: Function(indata, frames, time_info, status) matching sounddevice callback
            simulate_realtime: If True, sleep between chunks to simulate real-time streaming
        """
        while True:
            chunk = self.read_chunk()
            if chunk is None:
                break

            # Call the callback with sounddevice-compatible signature
            # (indata, frames, time, status)
            callback(chunk, len(chunk), None, None)

            # Simulate real-time streaming delay
            if simulate_realtime:
                time.sleep(self.chunk_duration)


# === Continuous Recorder ===

class ContinuousRecorder:
    """Records audio continuously and detects chunk boundaries using Silero VAD."""

    def __init__(self, tcp_server, output_dir, filename_prefix,
                 silence_threshold=5.0,
                 min_chunk_duration=10.0,
                 max_chunk_duration=120.0,
                 sample_rate=16000,
                 audio_source=None,
                 audio_input_device=None,
                 perfect_silence_duration=0.0,
                 verbose=False):
        self.tcp_server = tcp_server
        self.output_dir = Path(output_dir)
        self.filename_prefix = filename_prefix
        self.silence_threshold = silence_threshold
        self.min_chunk_duration = min_chunk_duration
        self.max_chunk_duration = max_chunk_duration
        self.sample_rate = sample_rate
        self.audio_source = audio_source  # Optional FileAudioSource for testing
        self.audio_input_device = audio_input_device  # Optional audio input device name
        self.perfect_silence_duration = perfect_silence_duration  # Duration to detect mic off (0 to disable)
        self.verbose = verbose  # Emit periodic RMS to stderr for diagnostics

        # Diagnostic: last time we logged an RMS sample (seconds since epoch)
        self._last_rms_log_time = 0.0
        self._rms_log_interval = 1.0  # seconds between RMS log lines

        # Chunk state
        self.chunk_num = 0
        self.current_chunk_audio = []
        self.current_chunk_start_time = None

        # Full recording (all audio for single file save)
        self.all_audio = []

        # Silence detection state
        self.silence_start_time = None
        self.perfect_silence_start_time = None
        self.mic_warning_shown = False
        self.startup_silence_check_done = False
        self.consecutive_silence_count = 0  # Count consecutive silence detections

        # Control
        self.running = True
        self.recording = False  # Whether currently recording
        self.mic_off = False  # Track if stopped due to mic being off

        # Load VAD model
        self.vad_model = self._load_vad_model()

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

    def _reset_recording_state(self):
        """Reset state for a new recording session."""
        self.chunk_num = 0
        self.current_chunk_audio = []
        self.current_chunk_start_time = None
        self.all_audio = []
        self.silence_start_time = None
        self.perfect_silence_start_time = None
        self.mic_warning_shown = False
        self.startup_silence_check_done = False
        self.mic_off = False
        self.consecutive_silence_count = 0

    def _detect_voice_activity(self, audio_chunk):
        """Detect if audio chunk contains voice using Silero VAD."""
        try:
            import torch
            audio_float = normalize_audio(audio_chunk)
            audio_tensor = torch.from_numpy(audio_float)
            speech_prob = self.vad_model(audio_tensor, self.sample_rate).item()
            return speech_prob > VAD_SPEECH_THRESHOLD
        except Exception as e:
            self.tcp_server.send_event("error", error=f"VAD detection error: {e}")
            return True  # Assume speech to avoid losing audio

    def _save_chunk(self):
        """Save current chunk audio to WAV file.

        Returns (path, peak) where peak is the max absolute amplitude on the
        float32 buffer in [0, 1]. Peak is used downstream to reject the
        recording early when the microphone is delivering silence — see the
        first-chunk gate in core/manager.lua.
        """
        if not self.current_chunk_audio:
            return None, 0.0

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

        # Reset for next chunk
        self.current_chunk_audio = []
        self.current_chunk_start_time = time.time()

        return str(chunk_file), peak

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
            # Microphone is off at startup - stop recording immediately
            self.tcp_server.send_event("silence_warning",
                                      message="Microphone off - stopping recording")
            self.mic_off = True  # Flag that mic is off

            # Stop recording and notify client
            if self.recording:
                self._finalize_recording()

            self.running = False  # Stop server loop
            self.startup_silence_check_done = True  # Don't check again

    def _emit_chunk_ready(self, chunk_file, is_final=False, peak=0.0):
        """Emit chunk_ready event."""
        if chunk_file:
            if not self.tcp_server.send_event("chunk_ready",
                                             chunk_num=self.chunk_num,
                                             audio_file=chunk_file,
                                             is_final=is_final,
                                             peak=peak):
                # Client disconnected, stop recording
                self.running = False

    def _check_max_duration(self):
        """Check if chunk exceeded max duration and save if needed."""
        chunk_duration = time.time() - self.current_chunk_start_time
        if chunk_duration >= self.max_chunk_duration:
            chunk_file, peak = self._save_chunk()
            self._emit_chunk_ready(chunk_file, is_final=False, peak=peak)
            return True
        return False

    def _get_recent_audio(self):
        """Get recent audio for VAD analysis."""
        # Silero VAD requires exactly 512 samples for 16kHz
        vad_samples = 512
        recent_audio = np.concatenate(self.current_chunk_audio[-10:])

        if len(recent_audio) >= vad_samples:
            return recent_audio[-vad_samples:]
        return None

    def _check_silence_boundary(self):
        """Check if silence threshold reached and save chunk if needed."""
        chunk_duration = time.time() - self.current_chunk_start_time

        if self.silence_start_time is None:
            return False

        silence_duration = time.time() - self.silence_start_time
        if silence_duration >= self.silence_threshold:
            if chunk_duration >= self.min_chunk_duration:
                chunk_file, peak = self._save_chunk()
                self._emit_chunk_ready(chunk_file, is_final=False, peak=peak)
                self.silence_start_time = None
                self.consecutive_silence_count = 0
                return True
        return False

    def _process_vad(self, recent_audio):
        """Process VAD and update silence tracking."""
        has_voice = self._detect_voice_activity(recent_audio)

        if has_voice:
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
            self.tcp_server.send_event("error", error=f"Audio callback status: {status}")

        # Diagnostic: emit periodic RMS/peak so we can tell whether the mic is
        # producing samples at all, even before recording is armed. Rate-limited
        # to ~1 line/sec so the console stays readable.
        if self.verbose:
            now = time.time()
            if now - self._last_rms_log_time >= self._rms_log_interval:
                self._last_rms_log_time = now
                mono = indata[:, 0]
                # RMS on the raw float32 samples (already in [-1, 1] range)
                rms = float(np.sqrt(np.mean(mono.astype(np.float64) ** 2)))
                peak = float(np.max(np.abs(mono)))
                print(
                    f"[whisper_stream] audio rms={rms:.5f} peak={peak:.5f} "
                    f"frames={frames} recording={self.recording}",
                    file=sys.stderr, flush=True,
                )

        # Only process audio if actively recording
        if not self.recording:
            return

        # Extract mono audio
        audio_chunk = indata[:, 0].copy()

        # Check for mic off
        self._check_perfect_silence(audio_chunk)

        # Add to current chunk
        self.current_chunk_audio.append(audio_chunk)
        # Also accumulate for complete recording file
        self.all_audio.append(audio_chunk)

        # Check max duration boundary
        if self._check_max_duration():
            return

        # Check VAD-based silence boundary
        recent_audio = self._get_recent_audio()
        if recent_audio is not None:
            self._process_vad(recent_audio)
            self._check_silence_boundary()

    def start(self):
        """Start persistent recording server (supports multiple recording sessions)."""
        def stop_for_signal(sig, frame):
            # Setting the flag alone is not enough. It is read by the command loop, so it
            # only takes effect once the main thread gets back there -- and a server that
            # is blocked inside PortAudio opening the input stream never does. Measured
            # on 2026-10-08: a server sent SIGTERM while waiting on that call was still
            # running four seconds later, both under Hammerspoon and from a shell. The
            # client escalates to SIGKILL for exactly that case, but a process killed
            # that way never closes the audio device, so exit properly when we can:
            # SystemExit unwinds the `with` holding the stream, which releases it.
            self.running = False
            sys.exit(0)

        # Only in the main thread; a signal handler cannot be installed anywhere else.
        try:
            signal.signal(signal.SIGINT, stop_for_signal)
            signal.signal(signal.SIGTERM, stop_for_signal)
        except ValueError:
            # Not in the main thread (under test, say) - skip the handlers
            pass

        # Use file source for testing or sounddevice for real recording
        if self.audio_source:
            self._start_with_file_source()
        else:
            self._start_with_microphone()

    def _start_with_microphone(self):
        """Start recording from microphone using sounddevice."""
        import sounddevice as sd

        try:
            # Keep audio stream running persistently
            # Get device index if device name specified
            device = None
            if self.audio_input_device:
                devices = sd.query_devices()
                for idx, dev in enumerate(devices):
                    if dev['name'] == self.audio_input_device and dev['max_input_channels'] > 0:
                        device = idx
                        break
                if device is None:
                    raise ValueError(f"Audio input device not found: {self.audio_input_device}")

            with sd.InputStream(callback=self.audio_callback,
                              device=device,
                              channels=1,
                              samplerate=self.sample_rate,
                              blocksize=int(self.sample_rate * 0.5),
                              dtype=np.float32):

                # Send server_ready event
                self.tcp_server.send_event("server_ready")

                # Main command loop - server stays running
                self._run_command_loop()

        except Exception as e:
            # Microphone error - send event but stay running for retry
            error_msg = f"Microphone error: {e}"
            self.tcp_server.send_event("error", error=error_msg)
            self.tcp_server.send_event("recording_stopped")  # Signal recording stopped

            # If we were recording, save what we have
            if self.recording:
                self._finalize_recording()

            # Send server_ready so client knows we're still alive
            self.tcp_server.send_event("server_ready")

            # Keep server running indefinitely - microphone might be fixed later
            # Loop forever until explicit shutdown command
            while self.running:
                try:
                    self._run_command_loop()
                except Exception as loop_err:
                    # Command loop error - log but keep trying
                    self.tcp_server.send_event("error", error=f"Command loop error: {loop_err}")
                    time.sleep(1)  # Brief pause before retry

    def _start_with_file_source(self):
        """Start recording from file source (for testing)."""
        import threading

        try:
            # Send server_ready event
            self.tcp_server.send_event("server_ready")

            # Start file streaming in background thread
            def stream_audio():
                while self.running:
                    # Only stream if recording
                    if self.recording:
                        chunk = self.audio_source.read_chunk()
                        if chunk is None:
                            # EOF - finalize and stop
                            if self.recording:
                                self._finalize_recording()
                            self.running = False
                            break
                        # Call audio callback
                        self.audio_callback(chunk, len(chunk), None, None)
                        # Simulate real-time streaming delay
                        time.sleep(self.audio_source.chunk_duration)
                    else:
                        # Not recording, just sleep a bit
                        time.sleep(0.01)

            audio_thread = threading.Thread(target=stream_audio, daemon=True)
            audio_thread.start()

            # Main command loop
            self._run_command_loop()

            # Wait for audio thread to finish
            audio_thread.join(timeout=2.0)

        except Exception as e:
            # File streaming error - send event but stay running
            error_msg = f"File streaming error: {e}"
            self.tcp_server.send_event("error", error=error_msg)
            self.tcp_server.send_event("recording_stopped")

            if self.recording:
                self._finalize_recording()

            # Keep server running
            self.tcp_server.send_event("server_ready")
            self._run_command_loop()

    def _run_command_loop(self):
        """Main command processing loop (shared by microphone and file modes)."""
        while self.running:
            # Check for commands from client
            cmd = self.tcp_server.receive_command(timeout=0.1)
            if cmd:
                command = cmd.get('command')

                if command == 'start_recording':
                    if not self.recording:
                        # The prefix belongs to the recording, not to the
                        # server, which outlives it: the server is pre-started
                        # so the first recording is not delayed by model
                        # loading. A prefix fixed at startup would name every
                        # later recording after the warmup that started the
                        # server, and chunk files -- numbered from 1 within
                        # each session -- would overwrite the previous
                        # session's.
                        prefix = cmd.get('filename_prefix')
                        if prefix:
                            self.filename_prefix = str(prefix)

                        # Start new recording session
                        self._reset_recording_state()
                        self.recording = True
                        self.current_chunk_start_time = time.time()

                        # Give stream a moment to stabilize
                        time.sleep(0.3)

                        self.tcp_server.send_event("recording_started")

                elif command == 'stop_recording':
                    if self.recording:
                        # Stop current recording session
                        self._finalize_recording()

                elif command == 'shutdown':
                    # Shutdown server
                    self.running = False

                elif command == 'disconnect':
                    # Client disconnected - stay running and wait for reconnect
                    if self.recording:
                        # Save current recording
                        self._finalize_recording()
                    # Wait for new client
                    if not self.tcp_server.wait_for_reconnect(timeout=60):
                        # No client after timeout, shutdown
                        self.running = False

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
        """Save final chunk and emit recording_stopped event."""
        # Reset recording state FIRST (single source of truth)
        if not self.recording:
            return  # Already finalized
        self.recording = False

        # Save complete recording as single file (for auditing/re-processing)
        complete_file = self._save_complete_recording()
        if complete_file:
            # Notify Lua about complete file path (for saving matching .txt file)
            self.tcp_server.send_event("complete_file", file_path=complete_file)

        # Don't save or transcribe final chunk if mic was off
        if self.mic_off:
            self.tcp_server.send_event("recording_stopped")
            return

        if self.current_chunk_audio:
            chunk_file, peak = self._save_chunk()
            self._emit_chunk_ready(chunk_file, is_final=True, peak=peak)

        self.tcp_server.send_event("recording_stopped")


# === Main ===

def main():
    parser = argparse.ArgumentParser(
        description="Continuous audio recording with Silero VAD"
    )
    parser.add_argument("--check-deps", action="store_true",
                       help="Check dependencies and exit")
    parser.add_argument("--transport", choices=["stdio", "tcp"], default="stdio",
                        help="How to talk to the client: over this process's "
                             "stdin/stdout (default), or over a TCP port")
    parser.add_argument("--tcp-port", type=int, default=12341,
                       help="TCP server port")
    parser.add_argument("--output-dir", help="Output directory for chunks")
    parser.add_argument("--filename-prefix", help="Prefix for chunk filenames")
    parser.add_argument("--silence-threshold", type=float, default=2.0,
                       help="Silence duration to trigger chunk (seconds)")
    parser.add_argument("--min-chunk-duration", type=float, default=3.0,
                       help="Minimum chunk duration (seconds)")
    parser.add_argument("--max-chunk-duration", type=float, default=600.0,
                       help="Maximum chunk duration (seconds)")
    parser.add_argument("--test-file", help="WAV file to use instead of microphone (for testing)")
    parser.add_argument("--audio-input", help="Audio input device name (e.g., 'BlackHole 2ch')")
    parser.add_argument("--perfect-silence-duration", type=float, default=0.0,
                       help="Duration of perfect silence to detect mic off (seconds, 0 = disabled, 2.0 for testing)")
    parser.add_argument("--verbose", action="store_true",
                       help="Emit periodic RMS/peak audio levels to stderr for diagnostics")

    args = parser.parse_args()

    if args.check_deps:
        missing = check_dependencies()
        if missing:
            print(json.dumps({"status": "error", "missing": missing}))
            sys.exit(1)
        print(json.dumps({"status": "ok"}))
        sys.exit(0)

    if not args.output_dir or not args.filename_prefix:
        print(json.dumps({"status": "error", "error": "Missing required arguments"}),
              file=sys.stderr, flush=True)
        sys.exit(1)

    output_dir = Path(args.output_dir)
    output_dir.mkdir(parents=True, exist_ok=True)

    # Create file audio source if test file provided
    audio_source = None
    if args.test_file:
        try:
            audio_source = FileAudioSource(args.test_file)
            print(json.dumps({"status": "test_mode", "file": args.test_file}),
                  file=sys.stderr, flush=True)
        except Exception as e:
            print(json.dumps({"status": "error", "error": f"Failed to load test file: {e}"}),
                  file=sys.stderr, flush=True)
            sys.exit(1)

    tcp_server = None
    try:
        # Both transports carry the same protocol and present the same
        # methods, so everything below is written against whichever this is.
        # The name is historical: it was the TCP one first.
        if args.transport == "stdio":
            tcp_server = StdioServer()
            print(json.dumps({"status": "listening", "transport": "stdio"}),
                  file=sys.stderr, flush=True)
        else:
            tcp_server = TCPServer(args.tcp_port)
            print(json.dumps({"status": "listening", "port": args.tcp_port}),
                  file=sys.stderr, flush=True)

        # Wait for client connection
        if not tcp_server.wait_for_client(timeout=10):
            print(json.dumps({"status": "error", "error": "Client connection timeout"}),
                  file=sys.stderr, flush=True)
            sys.exit(1)

        # Start recording
        recorder = ContinuousRecorder(
            tcp_server,
            args.output_dir,
            args.filename_prefix,
            args.silence_threshold,
            args.min_chunk_duration,
            args.max_chunk_duration,
            audio_source=audio_source,
            audio_input_device=args.audio_input,
            perfect_silence_duration=args.perfect_silence_duration,
            verbose=args.verbose,
        )
        recorder.start()
    except Exception as e:
        error_msg = str(e)
        if tcp_server:
            tcp_server.send_event("error", error=error_msg)
        print(json.dumps({"status": "error", "error": error_msg}),
              file=sys.stderr, flush=True)
        import traceback
        traceback.print_exc(file=sys.stderr)
        sys.exit(1)
    finally:
        if tcp_server:
            tcp_server.close()


if __name__ == "__main__":
    main()
