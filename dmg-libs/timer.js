// One-shot timers that outlive the function which created them.
//
// hs.timer.doAfter() returns a timer and keeps no reference to it. A caller that discards
// the return value is relying on the timer staying alive by itself, and it does not: a
// garbage collection before the deadline collects the JavaScript wrapper, and the callback
// never runs. Measured on 2026-10-07, two doAfter(4) timers with a collection forced at
// t=1 — the one assigned to a global fired, the one whose return value was discarded did
// not. This is the same mechanism that loses hs.task tasks; see dmg-libs/shell.js and
// ai/issue_unfiled_task-gc.md.
//
// So `later` holds every timer it creates until the timer has fired, which makes a
// fire-and-forget call safe:
//
//     const timers = require(hs.appinfo.configDir + "/dmg-libs/timer.js")
//     timers.later(0.2, () => hs.eventtap.keyStroke(["cmd"], "v"))
//
// A Spoon that already keeps its timer in a variable for its own reasons — to cancel it,
// or to avoid stacking two of them — needs nothing from here.

// Timers that have been created and not yet fired.
const pending = new Set()

/**
 * Run `fn` once, after `seconds`, holding the timer until it fires.
 *
 * @param {number} seconds The delay.
 * @param {Function} fn Called with no arguments.
 * @returns {object} The timer, for a caller that wants to stop it early. Keeping it is not
 *   necessary; stopping it early leaves it held until the process reloads, which costs one
 *   object.
 */
function later(seconds, fn) {
    const timer = hs.timer.doAfter(seconds, () => {
        pending.delete(timer)
        fn()
    })
    if (timer) pending.add(timer)
    return timer
}

/** How many timers are waiting, for checking that none are being leaked. */
function pendingCount() {
    return pending.size
}

module.exports = {
    later: later,
    pendingCount: pendingCount
}
