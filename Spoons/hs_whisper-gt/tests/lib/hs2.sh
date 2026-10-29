# Helpers for the live tests: run JavaScript in Hammerspoon 2, start a test server, and
# report results as TAP.
#
# hs2 reads JavaScript from standard input, one statement per line, and prints a banner
# line before the result. A statement that throws makes it exit 65.

SPOON_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
FIXTURES="$SPOON_DIR/tests/fixtures"
HS2="${HS2:-hs2}"
PYTHON="${PYTHON:-$HOME/.config/dmg/python/bin/python3}"
SPOON='hs.spoons["hs_whisper-gt"]'

TESTS_RUN=0
TESTS_FAILED=0

# Run one line of JavaScript and print its result, without the banner or colour codes.
hs2_eval() {
    printf '%s\n' "$1" | "$HS2" --no-prompt 2>&1 \
        | sed -e $'s/\x1b\\[[0-9;]*m//g' -e '/^Connected to Hammerspoon 2$/d'
    return "${PIPESTATUS[1]}"
}

# Poll a JavaScript expression until it prints "true", or give up after $2 seconds.
wait_for() {
    local expression="$1" seconds="${2:-10}" waited=0
    while [ "$waited" -lt "$((seconds * 4))" ]; do
        [ "$(hs2_eval "$expression")" = "true" ] && return 0
        sleep 0.25
        waited=$((waited + 1))
    done
    return 1
}

ok() {
    TESTS_RUN=$((TESTS_RUN + 1))
    echo "ok $TESTS_RUN - $1"
}

not_ok() {
    TESTS_RUN=$((TESTS_RUN + 1))
    TESTS_FAILED=$((TESTS_FAILED + 1))
    echo "not ok $TESTS_RUN - $1"
    [ -n "$2" ] && echo "#   $2"
}

# check DESCRIPTION EXPECTED ACTUAL
check() {
    if [ "$2" = "$3" ]; then ok "$1"; else not_ok "$1" "expected [$2], got [$3]"; fi
}

# check_contains DESCRIPTION NEEDLE HAYSTACK (case- and punctuation-insensitive)
check_contains() {
    local needle haystack
    needle="$(printf '%s' "$2" | tr '[:upper:]' '[:lower:]' | tr -d '[:punct:]')"
    haystack="$(printf '%s' "$3" | tr '[:upper:]' '[:lower:]' | tr -d '[:punct:]' | tr '\n' ' ')"
    case "$haystack" in
        *"$needle"*) ok "$1" ;;
        *) not_ok "$1" "[$2] not in [$3]" ;;
    esac
}

summary() {
    echo "1..$TESTS_RUN"
    [ "$TESTS_FAILED" -eq 0 ]
}

# A port nothing is listening on.
port_free() {
    "$PYTHON" -c 'import socket; s = socket.socket(); s.bind(("127.0.0.1", 0)); print(s.getsockname()[1])'
}

# Start whisper_stream.py playing the WAV $1, on port $2 (default: a free one). Sets
# TEST_SERVER_PID and TEST_SERVER_URL.
test_server_start() {
    local log
    log="$(mktemp -t whisper-test-server)"
    "$PYTHON" "$SPOON_DIR/whisper_stream.py" --port "${2:-0}" --test-file "$1" 2>"$log" &
    TEST_SERVER_PID=$!
    TEST_SERVER_LOG="$log"
    local port="" waited=0
    while [ -z "$port" ] && [ "$waited" -lt 240 ]; do
        port="$(sed -n 's/.*"status": "listening", "port": \([0-9]*\).*/\1/p' "$log")"
        sleep 0.25
        waited=$((waited + 1))
    done
    if [ -z "$port" ]; then
        echo "# test server did not start:"; sed 's/^/#   /' "$log"
        return 1
    fi
    TEST_SERVER_URL="ws://127.0.0.1:$port"
}

test_server_stop() {
    [ -n "$TEST_SERVER_PID" ] && kill "$TEST_SERVER_PID" 2>/dev/null
    wait "$TEST_SERVER_PID" 2>/dev/null
    TEST_SERVER_PID=""
}

# Point the Spoon at the test server, and put it back on exit. Also keeps the clipboard.
spoon_use_test_server() {
    SAVED_URL="$(hs2_eval "$SPOON.config.streamingUrl")"
    SAVED_CLIPBOARD="$(hs2_eval 'hs.pasteboard.readString() || ""')"
    hs2_eval "$SPOON.config.streamingUrl = \"$TEST_SERVER_URL\"; $SPOON._test.recorders.streaming.disconnect()" >/dev/null
    trap spoon_restore EXIT
}

spoon_restore() {
    hs2_eval "$SPOON._test.recorders.streaming.disconnect(); $SPOON.config.streamingUrl = \"$SAVED_URL\"" >/dev/null
    hs2_eval "hs.pasteboard.writeString($(printf '%s' "$SAVED_CLIPBOARD" | "$PYTHON" -c 'import json,sys; print(json.dumps(sys.stdin.read()))'))" >/dev/null
    test_server_stop
}
