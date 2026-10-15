#!/bin/bash
# The Spoon's streaming recorder against a test server: connecting, a recording's chunks
# reaching onChunk, and what happens when the server goes away mid-recording.
#
# Needs Hammerspoon 2 running with hs_whisper-gt loaded. Does not need whisper-server.

source "$(dirname "$0")/../lib/hs2.sh"
RECORDER="$SPOON._test.recorders.streaming"

# Start a recording and collect what the recorder hands over in globalThis.__wt.
recording_start() {
    hs2_eval "(() => { globalThis.__wt = {chunks: [], started: false, stopped: false, error: null}; $RECORDER.start({prefix: \"$1\"}, (file, num, isFinal, peak) => __wt.chunks.push({file, num, isFinal, peak})).then(() => { __wt.started = true }).catch((e) => { __wt.error = e.message }); return \"ok\" })()" >/dev/null
}

recording_stop() {
    hs2_eval "(() => { $RECORDER.stop(null, null).then(() => { __wt.stopped = true }).catch((e) => { __wt.stopError = e.message; __wt.stopped = true }); return \"ok\" })()" >/dev/null
}

echo "# short fixture"
test_server_start "$FIXTURES/short.wav" || exit 1
spoon_use_test_server

hs2_eval "globalThis.__wv = undefined; $RECORDER.validate().then((r) => { globalThis.__wv = r }); 'ok'" >/dev/null
wait_for "__wv !== undefined" 10
check "validate() connects" "null" "$(hs2_eval 'String(__wv)')"
check "connected" "true" "$(hs2_eval "$RECORDER.connected")"
check "the server reported itself" "false" "$(hs2_eval "$RECORDER.status.recording")"

recording_start "live-recorder"
if wait_for "__wt.started || __wt.error !== null" 20; then
    check "start() resolves once the server is recording" "true" "$(hs2_eval '__wt.started')"
else
    not_ok "start() resolves once the server is recording" "timed out"
fi

# The fixture is one second long; the server ends the recording at the end of the file.
if wait_for "__wt.chunks.some((c) => c.isFinal)" 10; then
    ok "a final chunk arrives"
else
    not_ok "a final chunk arrives" "$(hs2_eval 'JSON.stringify(__wt)')"
fi
check "one chunk, numbered 1" "1:1" "$(hs2_eval '__wt.chunks.length + ":" + __wt.chunks[0].num')"
chunk_file="$(hs2_eval '__wt.chunks[0].file')"
[ -s "$chunk_file" ] && ok "the chunk file exists ($chunk_file)" || not_ok "the chunk file exists" "$chunk_file"
check "the chunk has sound in it" "true" "$(hs2_eval '__wt.chunks[0].peak > 0.01')"

recording_stop
wait_for "__wt.stopped" 20 && ok "stop() resolves" || not_ok "stop() resolves"
check "stop() did not fail" "true" "$(hs2_eval '__wt.stopError === undefined')"
test_server_stop

echo "# the server goes away mid-recording"
test_server_start "$FIXTURES/long.wav" || exit 1
hs2_eval "$SPOON.config.streamingUrl = \"$TEST_SERVER_URL\"; $RECORDER.disconnect()" >/dev/null
recording_start "live-recorder-lost"
wait_for "__wt.started" 20 && ok "recording against the long fixture" || not_ok "recording against the long fixture" "$(hs2_eval 'JSON.stringify(__wt)')"
sleep 2
test_server_stop
wait_for "$RECORDER.connected === false" 10 \
    && ok "the recorder notices the server has gone" \
    || not_ok "the recorder notices the server has gone"

recording_stop
wait_for "__wt.stopped" 20 && ok "stop() settles without a server" || not_ok "stop() settles without a server"
check "and says why" "Could not reach the streaming server" "$(hs2_eval 'String(__wt.stopError)')"

echo "# nothing listening"
hs2_eval "$SPOON.config.streamingUrl = \"ws://127.0.0.1:$(port_free)\"; $RECORDER.disconnect()" >/dev/null
hs2_eval "$RECORDER.validate().then((r) => { globalThis.__wv = r }); 'ok'" >/dev/null
wait_for "typeof __wv === \"string\"" 10 && ok "validate() fails" || not_ok "validate() fails" "$(hs2_eval 'String(__wv)')"
check_contains "and names the LaunchAgent" "org.turingmachine.whisper-stream" "$(hs2_eval '__wv')"

hs2_eval 'delete globalThis.__wt; delete globalThis.__wv' >/dev/null
summary
