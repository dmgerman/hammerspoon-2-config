#!/bin/bash
# The Spoon and the server losing each other, and finding each other again:
#
#   1. A configuration reload: the Spoon reconnects to the launchd server.
#   2. The server restarting between dictations: the next recording reconnects.
#   3. serverRestart(): launchd restarts the real server, and the Spoon reconnects.
#
# Needs Hammerspoon 2 running with hs_whisper-gt loaded, and the LaunchAgent installed.
# Step 1 reloads the configuration; step 3 restarts the real server.

source "$(dirname "$0")/../lib/hs2.sh"
RECORDER="$SPOON._test.recorders.streaming"

echo "# a configuration reload"
hs2_eval 'hs.timer.doAfter(0.1, () => hs.reload()); "ok"' >/dev/null
sleep 3
wait_for "$RECORDER.connected" 30 \
    && ok "after a reload the Spoon is connected to the launchd server" \
    || not_ok "after a reload the Spoon is connected to the launchd server"
check "on the configured URL" "ws://127.0.0.1:12341" "$(hs2_eval "$SPOON.config.streamingUrl")"

echo "# the server restarting between recordings"
port="$(port_free)"
test_server_start "$FIXTURES/short.wav" "$port" || exit 1
spoon_use_test_server

record_once() {
    hs2_eval "(() => { globalThis.__wt = {done: false, error: null, final: false}; const r = $RECORDER; r.start({prefix: \"$1\"}, (f, n, isFinal) => { if (isFinal) __wt.final = true }).then(() => new Promise((ok) => hs.timer.doAfter(2, ok))).then(() => r.stop(null, null)).then(() => { __wt.done = true }).catch((e) => { __wt.error = e.message; __wt.done = true }); return 'ok' })()" >/dev/null
    wait_for "__wt.done" 30
    hs2_eval '__wt.error === null && __wt.final'
}

check "a recording" "true" "$(record_once reconnect-1)"
test_server_stop
wait_for "$RECORDER.connected === false" 10 && ok "the Spoon sees the server go" || not_ok "the Spoon sees the server go"
test_server_start "$FIXTURES/short.wav" "$port" || exit 1
check "the next recording reconnects to the new server" "true" "$(record_once reconnect-2)"
spoon_restore
trap - EXIT

echo "# serverRestart() through launchd"
before="$(launchctl print "gui/$(id -u)/org.turingmachine.whisper-stream" | sed -n 's/^[[:space:]]*pid = //p')"
hs2_eval "globalThis.__wr = undefined; $SPOON.serverRestart().then((r) => { globalThis.__wr = r === null ? 'ok' : r }); 'ok'" >/dev/null
wait_for '__wr !== undefined' 60
check "serverRestart() succeeds" "ok" "$(hs2_eval '__wr')"
after="$(launchctl print "gui/$(id -u)/org.turingmachine.whisper-stream" | sed -n 's/^[[:space:]]*pid = //p')"
[ -n "$after" ] && [ "$before" != "$after" ] && ok "launchd started a new server ($before -> $after)" || not_ok "launchd started a new server" "$before -> $after"
check "the Spoon is connected to it" "true" "$(hs2_eval "$RECORDER.connected")"

hs2_eval 'delete globalThis.__wt; delete globalThis.__wr' >/dev/null
summary
