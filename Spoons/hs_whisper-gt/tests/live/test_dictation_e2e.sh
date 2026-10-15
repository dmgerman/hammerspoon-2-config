#!/bin/bash
# Whole dictations through the Spoon, against a test server playing a fixture: start, stop,
# transcription by whisper-server, and the joined text on the clipboard.
#
# Needs Hammerspoon 2 running with hs_whisper-gt loaded and using the whisperserver
# transcriber, and whisper-server answering on port 8080. Takes about a minute.

source "$(dirname "$0")/../lib/hs2.sh"

if ! curl -s -o /dev/null --connect-timeout 2 http://127.0.0.1:8080/health; then
    echo "1..0 # SKIP whisper-server is not answering on 127.0.0.1:8080"
    exit 0
fi
check "the Spoon is idle" "IDLE" "$(hs2_eval "$SPOON.state()")"
check "the transcriber is whisperserver" "whisperserver" "$(hs2_eval "$SPOON._test.transcriber().name")"

# Dictate the fixture $1, stopping $2 seconds after starting, and print the clipboard.
dictate() {
    hs2_eval 'hs.pasteboard.writeString("(nothing yet)")' >/dev/null
    hs2_eval "$SPOON.transcribeToggle(); 'ok'" >/dev/null
    wait_for "$SPOON.state() === \"RECORDING\"" 20 || { echo "never started recording"; return 1; }
    sleep "$2"
    hs2_eval "$SPOON.transcribeToggle(); 'ok'" >/dev/null
    wait_for "$SPOON.state() === \"IDLE\"" 120 || { echo "never finished: $(hs2_eval "$SPOON.state()")"; return 1; }
    hs2_eval 'hs.pasteboard.readString()'
}

echo "# short fixture"
# What whisper-server makes of the fixture depends on its model: with the model in use on
# 2026-10-15 it hears only "happens." of "Transcribe happens.". So the dictation is compared
# with whisper-server's own transcription of the same file, which tests the pipeline rather
# than the model.
expected="$(curl -s -X POST http://127.0.0.1:8080/inference -F "file=@$FIXTURES/short.wav" \
    -F response_format=text -F language=en | tr -d '\n' | sed 's/^ *//; s/ *$//')"
test_server_start "$FIXTURES/short.wav" || exit 1
spoon_use_test_server
text="$(dictate short 3)"
check_contains "the transcription is on the clipboard ($expected)" "$expected" "$text"
test_server_stop

echo "# long fixture, several chunks"
test_server_start "$FIXTURES/long.wav" || exit 1
hs2_eval "$SPOON.config.streamingUrl = \"$TEST_SERVER_URL\"; $SPOON._test.recorders.streaming.disconnect()" >/dev/null
text="$(dictate long 46)"
check_contains "the first chunk's words" "one two three" "$text"
check_contains "a later chunk's words" "the detection seems to be working" "$text"

summary
