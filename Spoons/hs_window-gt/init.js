// hs_window-gt — window placement, movement and resizing, and an undo history.
//
// Every window operation lives here rather than in init.js, because undo needs one place
// through which all of them pass.
//
// The history follows Emacs's winner-mode: a ring of past positions, consecutive identical
// ones collapsed, undo walking back through the ring rather than popping it, and redo
// cancelling a walk. It differs in being per window rather than per layout, because the
// recording hook is per window (see below); an operation moving two windows records one
// entry for each, and undoing it takes two.
//
// The recording hook is advice on HSWindow's `frame` setter, so anything that moves a
// window from JavaScript is recorded, not only the commands here. Hammerspoon 1 had
// hs.window.filter to subscribe to window events; Hammerspoon 2 has no single equivalent,
// and assembling one from hs.ax means an observer per window or per application. The
// advice costs one property redefinition and sees everything except a window moved by hand.
//
// hs.ax watchers can now watch any element rather than only an application, which is what
// the number keys below use to notice a window closing. Watching windowMoved and
// windowResized the same way would let the history see a window moved by hand as it
// happens, rather than reconstructing it afterwards as record() does.
//
// Hand movement is recovered without watching for it. Before changing a window we compare
// where it is with where we last put it; if they differ, someone moved it, and both
// positions go on the ring. Undo then returns to where your hand left it, and undo again to
// where the last command had put it.

// MARK: - User-configurable settings

const config = {
    // Positions remembered per window, oldest discarded. winner-ring-size is 200.
    historySize: 200,

    // Isolation dims everything except the focused window. Hammerspoon 1 used
    // hs.window.highlight, which Hammerspoon 2 does not have.
    isolationColor: "#000000",
    isolationOpacity: 0.85,

    // The ring drawn around the pointer after it is moved, so it can be found again. Its
    // size is the diameter, in pixels, and its width the thickness of the line.
    //
    // The ring ignores mouse events, so a click inside it reaches what is underneath
    // rather than on the window beneath. mouseHighlightSeconds is therefore also how long
    // that square is unclickable, and is the reason it is short.
    mouseHighlightColor: "#FF0000",
    mouseHighlightSize: 60,
    mouseHighlightWidth: 4,
    mouseHighlightSeconds: 0.5,

    // Where screenshot() writes. The pasteboard copy is usually the one that gets used, so
    // this is somewhere to find the file afterwards rather than somewhere to keep it.
    screenshotDir: "/tmp",
    // Seconds the path stays on screen after a capture.
    screenshotAlertSeconds: 3,

    // Windows attached to number keys. attachKeyToWindow() binds one of attachKeys, with
    // these modifiers, to focus the window it was called on. Modifiers are named as
    // hs.hotkey wants them: "cmd", "alt", "ctrl", "shift".
    //
    // 0 is not among the keys because alt-0 is what invokes the attaching, and attaching a
    // window to it would replace that binding.
    attachModifiers: ["alt"],
    attachKeys: "123456789",
    // Seconds to wait for the number key after attachKeyToWindow() asks for one. The wait
    // ends early on Escape, or on any key that is not a digit.
    attachKeyWait: 5,

    // Seconds between sweeps for records of windows that have closed.
    forgetInterval: 120,

    // Reapplying a size after moving a window to another screen: how many attempts, and
    // how long to wait between them. See setFrameOnScreen for why one is not enough.
    resizeAttempts: 5,
    resizeDelay: 0.05
}

// MARK: - State

// Window id -> { ring, walk, applied, unmaximized, unmaximizedV, unmaximizedH, onScreen }
//   ring          positions to walk back through, oldest first
//   walk          how far back undo has walked, null when not walking
//   applied       where we last put the window, for spotting a move we did not make
//   unmaximized   size to go back to when maximize is pressed a second time
//   unmaximizedV  size to go back to when verticalMaximize is pressed a second time
//   unmaximizedH  size to go back to when horizontalMaximize is pressed a second time
//   onScreen      screen id -> the frame the window had when it last left that screen
//
// Keyed by id, not held on the window: hs.window.focusedWindow() returns a new object
// every call, so a property set on one is gone by the next lookup. The id is what persists.
// Records for windows that have closed are dropped by forgetClosedWindows().
const history = new Map()

// The advice, kept so stop() can put the original back.
let framePropertyOriginal = null
let recording = true

// Isolation overlays, one per screen.
let isolationWindows = []

// The ring drawn around the pointer, and the timer that takes it away. One at a time: a
// second move removes the first ring before drawing its own.
let highlightWindow = null
let highlightTimer = null

// How far through the window order mouseWindowCenterNext() has walked, and the order it
// was walking, so that a changed list restarts it. See that function for why it cannot
// just take the second window every time.
let mouseNextIndex = 0
let mouseNextOrder = ""

// Held: a timer with no reference left is collected before it fires.
let forgetTimer = null

// Window ids, for previousWindow(): what is focused now, and what was before it.
let currentFocusedId = null
let previousFocusedId = null
let focusWatcher = null

// MARK: - Helpers

function alert(message) {
    hs.ui.alert(message).duration(2).show()
}

function focused() {
    return hs.window.focusedWindow()
}

/**
 * Focus a window and bring its application forward.
 *
 * Not window.focus() alone. That sets the window as its application's focused one and then
 * calls NSRunningApplication.activate(), which macOS ignores when the calling application
 * is not frontmost — and Hammerspoon never is at the moment a hotkey fires. It fails
 * silently, reporting success while nothing moves. hs.application.launchOrFocus() goes
 * through NSWorkspace.openApplication, which is not restricted, and is what hs_menu-gt
 * uses for the same reason.
 *
 * The window is focused first so that the application comes forward with the right window
 * already selected.
 *
 * @param {object} window The window to focus.
 * @returns {boolean} Whether the window accepted focus.
 */
function focusWindow(window) {
    if (!window) return false

    const accepted = window.focus()
    const bundleID = window.application ? window.application.bundleID : null
    if (bundleID) hs.application.launchOrFocus(bundleID)
    return accepted
}

/** Whether two frames describe the same rectangle, within a pixel. */
function sameFrame(a, b) {
    if (!a || !b) return false
    return Math.abs(a.x - b.x) < 1 && Math.abs(a.y - b.y) < 1 &&
        Math.abs(a.w - b.w) < 1 && Math.abs(a.h - b.h) < 1
}

function copyFrame(f) {
    return new HSRect(f.x, f.y, f.w, f.h)
}

function entryFor(win) {
    let entry = history.get(win.id)
    if (!entry) {
        entry = {
            ring: [], walk: null, applied: null,
            unmaximized: null, unmaximizedV: null, unmaximizedH: null,
            onScreen: new Map()
        }
        history.set(win.id, entry)
    }
    return entry
}

/**
 * Drop the records of windows that no longer exist.
 *
 * A record per window would otherwise accumulate for the lifetime of the session, one for
 * every window ever moved.
 */
function forgetClosedWindows() {
    const alive = new Set(hs.window.allWindows().map((w) => w.id))
    for (const id of [...history.keys()]) {
        if (!alive.has(id)) history.delete(id)
    }
    return history.size
}

// MARK: - The history

/**
 * Record where a window is, just before it is moved.
 *
 * Called from the advice, so it runs for any JavaScript that sets a frame.
 */
function record(win, current) {
    if (!recording || !win || current === undefined || current === null) return

    const entry = entryFor(win)

    // A move that is not ours ends any undo walk in progress: the ring is being added to
    // again, so there is no sequence left to cancel.
    entry.walk = null

    // Where we last put it differs from where it is, so it was moved by hand in between.
    // Both positions are worth returning to, so both go on: the one we set, then the one
    // it was actually left at.
    if (entry.applied && !sameFrame(entry.applied, current)) {
        push(entry, entry.applied)
    }
    push(entry, current)
}

function push(entry, frame) {
    const last = entry.ring[entry.ring.length - 1]
    // winner-insert-if-new: an identical position replaces rather than repeats.
    if (last && sameFrame(last, frame)) return
    entry.ring.push(copyFrame(frame))
    if (entry.ring.length > config.historySize) entry.ring.shift()
}

/** Set a frame without recording it, for undo and redo putting a window back. */
function restore(win, frame) {
    recording = false
    try {
        win.frame = copyFrame(frame)
    } finally {
        recording = true
    }
    entryFor(win).applied = copyFrame(frame)
}

/**
 * Step back through a window's history.
 *
 * Repeated calls walk further back, as winner-undo does, rather than each undo undoing the
 * one before it.
 */
function undo(win) {
    const window = win || focused()
    if (!window) return module.exports

    const entry = entryFor(window)
    if (!entry.ring.length) {
        alert("No window history")
        return module.exports
    }

    // Starting a walk: remember where we are, so redo can come back to it.
    if (entry.walk === null) {
        entry.walk = 0
        entry.current = copyFrame(window.frame)
        // A hand movement since the last command is itself a position to return to.
        if (entry.applied && !sameFrame(entry.applied, entry.current)) {
            push(entry, entry.applied)
        }
    }

    if (entry.walk >= entry.ring.length) {
        alert("No further window history")
        return module.exports
    }

    entry.walk += 1
    restore(window, entry.ring[entry.ring.length - entry.walk])
    return module.exports
}

/**
 * Cancel a walk begun by `undo`, returning the window to where it was before it.
 *
 * Only meaningful straight after undoing, as winner-redo is.
 */
function redo(win) {
    const window = win || focused()
    if (!window) return module.exports

    const entry = entryFor(window)
    if (entry.walk === null || !entry.current) {
        alert("Nothing to redo")
        return module.exports
    }

    restore(window, entry.current)
    entry.walk = null
    return module.exports
}

/** How many positions are remembered for a window. */
function historyDepth(win) {
    const window = win || focused()
    if (!window) return 0
    const entry = history.get(window.id)
    return entry ? entry.ring.length : 0
}

/** Forget every window's history. */
function clearHistory() {
    history.clear()
    return module.exports
}

// MARK: - The recording hook

/**
 * Advise HSWindow's `frame` setter, so every frame change from JavaScript is recorded.
 *
 * The original descriptor is captured and delegated to, rather than assumed to be the
 * innermost one, so this composes with any other advice on the same property.
 */
function installAdvice() {
    if (framePropertyOriginal) return

    const win = hs.window.focusedWindow() || hs.window.allWindows()[0]
    if (!win) {
        console.error("[hs_window-gt] no window to take the prototype from; undo is off")
        return
    }

    const proto = Object.getPrototypeOf(win)
    const original = Object.getOwnPropertyDescriptor(proto, "frame")
    if (!original || !original.set || !original.configurable) {
        console.error("[hs_window-gt] HSWindow.frame cannot be advised; undo is off")
        return
    }

    framePropertyOriginal = { proto: proto, descriptor: original }

    Object.defineProperty(proto, "frame", {
        configurable: true,
        enumerable: original.enumerable,
        get: original.get,
        set: function (value) {
            try {
                record(this, original.get.call(this))
            } catch (e) {
                console.error(`[hs_window-gt] recording failed: ${e.message}`)
            }
            original.set.call(this, value)
            try {
                entryFor(this).applied = copyFrame(original.get.call(this))
            } catch (e) {
                // Nothing to do: the move happened, only the bookkeeping did not.
            }
        }
    })
}

function removeAdvice() {
    if (!framePropertyOriginal) return
    Object.defineProperty(framePropertyOriginal.proto, "frame", framePropertyOriginal.descriptor)
    framePropertyOriginal = null
}

// MARK: - Placing a window in a grid
//
// place() takes a grid and a cell within it, which covers halves, thirds and quadrants:
// place(win, {cols: 3}, {col: 1}) is the middle third.

function place(win, grid, cell) {
    const window = win || focused()
    if (!window) return false

    const screen = window.screen.frame
    const cols = grid.cols === undefined ? 1 : grid.cols
    const rows = grid.rows === undefined ? 1 : grid.rows
    const col = cell.col === undefined ? 0 : cell.col
    const row = cell.row === undefined ? 0 : cell.row
    const colSpan = cell.colSpan === undefined ? 1 : cell.colSpan
    const rowSpan = cell.rowSpan === undefined ? 1 : cell.rowSpan

    const cellWidth = screen.w / cols
    const cellHeight = screen.h / rows

    window.frame = new HSRect(
        screen.x + col * cellWidth,
        screen.y + row * cellHeight,
        colSpan * cellWidth,
        rowSpan * cellHeight
    )
    return true
}

/** Whether a window already fills its screen. */
function isMaximized(win) {
    const window = win || focused()
    if (!window) return false
    return sameFrame(window.frame, window.screen.frame)
}

/**
 * Fill the screen with a window, or put it back if it already fills it.
 *
 * The size to go back to is the one it had when it was maximized, kept against the window's
 * id. A window maximized by some other means — dragged to fill the screen, or maximized
 * before this Spoon started — has nothing recorded, and says so rather than guessing.
 */
function maximize(win) {
    const window = win || focused()
    if (!window) return false

    const entry = entryFor(window)

    if (isMaximized(window)) {
        if (!entry.unmaximized) {
            alert("No earlier size to go back to")
            return false
        }
        window.frame = copyFrame(entry.unmaximized)
        entry.unmaximized = null
        return true
    }

    entry.unmaximized = copyFrame(window.frame)
    return place(window, {}, {})
}

const leftHalf = (win) => place(win, { cols: 2 }, { col: 0 })
const rightHalf = (win) => place(win, { cols: 2 }, { col: 1 })
const topHalf = (win) => place(win, { rows: 2 }, { row: 0 })
const bottomHalf = (win) => place(win, { rows: 2 }, { row: 1 })
const leftThird = (win) => place(win, { cols: 3 }, { col: 0 })
const centerThird = (win) => place(win, { cols: 3 }, { col: 1 })
const rightThird = (win) => place(win, { cols: 3 }, { col: 2 })
const leftTwoThirds = (win) => place(win, { cols: 3 }, { col: 0, colSpan: 2 })
const rightTwoThirds = (win) => place(win, { cols: 3 }, { col: 1, colSpan: 2 })
const topLeft = (win) => place(win, { cols: 2, rows: 2 }, { col: 0, row: 0 })
const topRight = (win) => place(win, { cols: 2, rows: 2 }, { col: 1, row: 0 })
const bottomLeft = (win) => place(win, { cols: 2, rows: 2 }, { col: 0, row: 1 })
const bottomRight = (win) => place(win, { cols: 2, rows: 2 }, { col: 1, row: 1 })

/** Centre a window on its screen, keeping its size. */
function center(win) {
    const window = win || focused()
    if (!window) return false

    const screen = window.screen.frame
    const frame = window.frame
    window.frame = new HSRect(
        screen.x + (screen.w - frame.w) / 2,
        screen.y + (screen.h - frame.h) / 2,
        frame.w,
        frame.h
    )
    return true
}

// MARK: - Resizing in place

/** Whether a window already fills its screen's height. */
function isVerticallyMaximized(win) {
    const window = win || focused()
    if (!window) return false
    const screen = window.screen.frame
    const frame = window.frame
    return Math.abs(frame.y - screen.y) < 1 && Math.abs(frame.h - screen.h) < 1
}

/** Whether a window already fills its screen's width. */
function isHorizontallyMaximized(win) {
    const window = win || focused()
    if (!window) return false
    const screen = window.screen.frame
    const frame = window.frame
    return Math.abs(frame.x - screen.x) < 1 && Math.abs(frame.w - screen.w) < 1
}

/**
 * Fill the screen's height, keeping width and horizontal position, or put the height back
 * if it already fills it.
 *
 * Only the vertical pair is restored, so a horizontal move made while tall is kept. As with
 * maximize(), a window that filled the height by some other means has nothing recorded and
 * says so rather than guessing.
 */
function verticalMaximize(win) {
    const window = win || focused()
    if (!window) return false

    const entry = entryFor(window)
    const screen = window.screen.frame
    const frame = window.frame

    if (isVerticallyMaximized(window)) {
        if (!entry.unmaximizedV) {
            alert("No earlier height to go back to")
            return false
        }
        window.frame = new HSRect(frame.x, entry.unmaximizedV.y, frame.w, entry.unmaximizedV.h)
        entry.unmaximizedV = null
        return true
    }

    entry.unmaximizedV = copyFrame(frame)
    window.frame = new HSRect(frame.x, screen.y, frame.w, screen.h)
    return true
}

/**
 * Fill the screen's width, keeping height and vertical position, or put the width back
 * if it already fills it.
 *
 * Only the horizontal pair is restored, so a vertical move made while wide is kept.
 */
function horizontalMaximize(win) {
    const window = win || focused()
    if (!window) return false

    const entry = entryFor(window)
    const screen = window.screen.frame
    const frame = window.frame

    if (isHorizontallyMaximized(window)) {
        if (!entry.unmaximizedH) {
            alert("No earlier width to go back to")
            return false
        }
        window.frame = new HSRect(entry.unmaximizedH.x, frame.y, entry.unmaximizedH.w, frame.h)
        entry.unmaximizedH = null
        return true
    }

    entry.unmaximizedH = copyFrame(frame)
    window.frame = new HSRect(screen.x, frame.y, screen.w, frame.h)
    return true
}

/** Halve the height, keeping the top edge. */
function halfHeight(win) {
    const window = win || focused()
    if (!window) return false
    const frame = window.frame
    window.frame = new HSRect(frame.x, frame.y, frame.w, frame.h / 2)
    return true
}

/** Halve the width, keeping the left edge. */
function halfWidth(win) {
    const window = win || focused()
    if (!window) return false
    const frame = window.frame
    window.frame = new HSRect(frame.x, frame.y, frame.w / 2, frame.h)
    return true
}

/**
 * Set the width to a fraction of the screen, keeping height and position.
 *
 * @param {number} denominator 2 for half the screen's width, 3 for a third, and so on.
 */
function fractionWidth(denominator, win) {
    const window = win || focused()
    if (!window) return false

    const n = Number(denominator)
    if (!Number.isFinite(n) || n < 1) {
        alert(`Illegal fraction [${denominator}]`)
        return false
    }

    const screen = window.screen.frame
    const frame = window.frame
    window.frame = new HSRect(frame.x, frame.y, screen.w / n, frame.h)
    return true
}

/** Move a window by its own width or height, without resizing it. */
function moveByOwnSize(direction, win) {
    const window = win || focused()
    if (!window) return false

    const frame = window.frame
    const deltas = {
        left: [-frame.w, 0],
        right: [frame.w, 0],
        up: [0, -frame.h],
        down: [0, frame.h]
    }
    const delta = deltas[direction]
    if (!delta) {
        alert(`Illegal direction [${direction}]`)
        return false
    }

    window.frame = new HSRect(frame.x + delta[0], frame.y + delta[1], frame.w, frame.h)
    return true
}

// MARK: - Screens

function screenList() {
    // hs.screen.all(), not allScreens() as in Hammerspoon 1.
    return hs.screen.all()
}

/**
 * The ids of the screens showing a fullscreen window.
 *
 * Hammerspoon 1 asked hs.spaces for the type of the space on each screen. Hammerspoon 2
 * has no spaces module, so a screen counts as fullscreen when a window on it reports
 * isFullscreen.
 *
 * @returns {Set<number>}
 */
function fullscreenScreenIds() {
    const ids = new Set()
    for (const window of hs.window.allWindows()) {
        if (window.isFullscreen && window.screen) ids.add(window.screen.id)
    }
    return ids
}

/** Whether a screen is showing a fullscreen window. */
function screenHasFullscreenWindow(screen) {
    return screen ? fullscreenScreenIds().has(screen.id) : false
}

/**
 * Move a window to the next or previous screen, keeping its place within the screen.
 *
 * Screens showing a fullscreen window are stepped over: a window moved there would be
 * behind the fullscreen one and never visible.
 *
 * @param {string} direction "next" or "previous".
 */
function moveToScreen(direction, win) {
    const window = win || focused()
    if (!window) return false

    const screens = screenList()
    if (screens.length < 2) {
        alert("Only one screen")
        return false
    }

    const current = window.screen
    const index = screens.findIndex((s) => s.id === current.id)
    const step = direction === "previous" ? -1 : 1

    // Step until a screen without a fullscreen window is reached, stopping before the
    // walk returns to the screen the window is already on.
    const occupied = fullscreenScreenIds()
    let target = null
    for (let n = 1; n < screens.length; n++) {
        const position = (((index + step * n) % screens.length) + screens.length) % screens.length
        const candidate = screens[position]
        if (!occupied.has(candidate.id)) {
            target = candidate
            break
        }
    }
    if (!target) {
        alert("Every other screen has a fullscreen window")
        return false
    }

    const from = current.frame
    const to = target.frame
    const frame = window.frame
    const entry = entryFor(window)

    // Where the window sits now is what it should come back to. Scaling one way and back
    // does not return it: an application rounds a size to whole rows and columns, so a few
    // pixels are lost on each crossing.
    entry.onScreen.set(current.id, copyFrame(frame))

    // Where the window was when it last left the target screen, if it has been there and
    // has not been resized by hand since, which would make that stale.
    const remembered = sameFrame(entry.applied, frame) ? entry.onScreen.get(target.id) : null

    // Otherwise keep the window where it sat within its screen, proportionally, so a
    // window on the right of one display arrives on the right of the next.
    setFrameOnScreen(window, remembered || new HSRect(
        to.x + ((frame.x - from.x) / from.w) * to.w,
        to.y + ((frame.y - from.y) / from.h) * to.h,
        frame.w * (to.w / from.w),
        frame.h * (to.h / from.h)
    ))
    return true
}

/**
 * Set a frame that lies on a different screen than the window is on now.
 *
 * A single frame assignment is clamped by the screen the window currently occupies, so a
 * window moving from a small display to a large one arrives at the small display's width.
 * Hammerspoon 1 has the same problem and works around it in setFrameWithWorkarounds:
 * apply the size, move, then apply the size again, the second one taking effect now that
 * the window is on a screen with room for it.
 */
function setFrameOnScreen(win, rect) {
    // The frame assignment moves the window and is what the undo advice records. Its size
    // is unreliable here: the accessibility API clamps a size to the screen the window is
    // on at the time of the call, so a window growing as it moves to a larger display
    // arrives at the smaller display's dimensions.
    win.frame = copyFrame(rect)

    // A window that was already on the target screen is not clamped, so it has the size now
    // and there is nothing to correct.
    if (sizeApplied(win, rect)) return

    // Apply the size again once the window is on the target screen. The application only
    // accepts the larger size after it has handled the move on its own run loop, which it
    // cannot do while this function runs, so reapplying here in a loop changes nothing and
    // the attempts are scheduled instead. Each one reads the size back and stops once it
    // matches.
    resize(win, rect, config.resizeAttempts)
}

/** Whether a window has the size of a rectangle, to the nearest point. */
function sizeApplied(win, rect) {
    const size = win.size
    return Math.abs(size.w - rect.w) < 1 && Math.abs(size.h - rect.h) < 1
}

/**
 * Reapply a size until the application accepts it, or the attempts run out.
 *
 * The window is held rather than looked up by id on each attempt: hs.window.allWindows()
 * takes a fifth of a second, and an HSWindow still reports its frame and takes a new size
 * long after it was obtained. Only properties set on one are lost, and none are set here.
 */
function resize(win, rect, attempts) {
    if (attempts <= 0) return
    hs.timer.doAfter(config.resizeDelay, () => {
        try {
            // The advice recorded where the window was put before these corrections ran.
            // Bring that up to date, or the next move reads the difference as one made by
            // hand.
            const entry = history.get(win.id)
            if (entry) entry.applied = copyFrame(win.frame)

            if (sizeApplied(win, rect)) return
            win.size = new HSSize(rect.w, rect.h)
        } catch (e) {
            // The window closed between attempts. Nothing left to correct.
            return
        }
        resize(win, rect, attempts - 1)
    })
}

// MARK: - Windows among themselves

/**
 * Whether two windows can be moved around one another.
 *
 * macOS does not treat a fullscreen window as a window with a frame. It refuses to move
 * one, and a window sent to a screen a fullscreen window occupies is taken into that
 * window's space, after which it is not listed by hs.window.allWindows() nor by its own
 * application. Neither is worth working around, so both are refused here.
 *
 * @param {HSWindow[]} windows  The windows taking part.
 * @param {object[]} destinations  The screens windows are arriving on.
 */
function movable(windows, destinations) {
    if (windows.some((w) => w.isFullscreen)) {
        alert("A fullscreen window cannot be moved")
        return false
    }

    // fullscreenScreenIds() enumerates every window, which takes a fifth of a second. Nothing
    // is arriving on a screen when the windows stay where they are, so skip it in that case.
    if (!destinations.length) return true

    const occupied = fullscreenScreenIds()
    if (destinations.some((s) => s && occupied.has(s.id))) {
        alert("That screen is showing a fullscreen window")
        return false
    }
    return true
}

/**
 * Put two windows side by side on this window's screen: the other one on the left half,
 * this one on the right.
 *
 * Hammerspoon 1 opened a chooser of the other windows from inside this function. Here the
 * other window is a parameter, and the command asks for it, so the Spoon does no prompting.
 */
function tileWith(other, win) {
    const window = win || focused()
    if (!window || !other) return false
    if (other.id === window.id) {
        alert("A window cannot be tiled with itself")
        return false
    }
    // The other window arrives on this window's screen, unless it is already there.
    const crossing = window.screen && other.screen && window.screen.id !== other.screen.id
    if (!movable([window, other], crossing ? [window.screen] : [])) return false

    // Both halves are of this window's screen, so the other window may be crossing to it.
    const screen = window.screen.frame
    setFrameOnScreen(other, new HSRect(screen.x, screen.y, screen.w / 2, screen.h))
    place(window, { cols: 2 }, { col: 1 })

    // Choosing the other window took focus away from this one; give it back.
    window.focus()
    return true
}

/** Exchange two windows' positions and sizes, across screens as well as within one. */
function swapWithWindow(other, win) {
    const window = win || focused()
    if (!window || !other) return false
    if (other.id === window.id) {
        alert("A window cannot be swapped with itself")
        return false
    }
    // Each window arrives on the other's screen, unless they share one.
    const crossing = window.screen && other.screen && window.screen.id !== other.screen.id
    if (!movable([window, other], crossing ? [window.screen, other.screen] : [])) return false

    const mine = copyFrame(window.frame)
    const theirs = copyFrame(other.frame)

    // Either window may be crossing to the other's screen, where a single frame assignment
    // is clamped to the screen it is leaving.
    setFrameOnScreen(window, theirs)
    setFrameOnScreen(other, mine)

    window.focus()
    return true
}

/** Swap this window's position and size with the window behind it. */
function swapWithPrevious(win) {
    const window = win || focused()
    if (!window) return false

    const other = hs.window.orderedWindows().find((w) => w.id !== window.id)
    if (!other) {
        alert("No other window")
        return false
    }
    return swapWithWindow(other, window)
}

/** Focus the window that had focus before this one. */
function previousWindow() {
    if (previousFocusedId !== null) {
        const still = hs.window.allWindows().find((w) => w.id === previousFocusedId)
        if (still) return focusWindow(still)
    }

    // Nothing remembered, or it has gone: the next window in order will do.
    const ordered = hs.window.orderedWindows()
    if (ordered.length < 2) {
        alert("No previous window")
        return false
    }
    return focusWindow(ordered[1])
}

/** Send a window behind the others, by focusing the one under it. */
function sendToBack(win) {
    const window = win || focused()
    if (!window) return false

    const ordered = hs.window.orderedWindows().filter((w) => w.id !== window.id)
    if (!ordered.length) {
        alert("No other window")
        return false
    }
    // Focusing every other window in reverse order leaves this one last.
    for (let i = ordered.length - 1; i >= 0; i--) ordered[i].focus()
    return true
}

// MARK: - The mouse
//
// hs.mouse.setAbsolutePosition takes two numbers, not a point. Its coordinates are the
// ones window frames are in — the origin at the top left of the primary screen, y
// increasing downwards — so a frame's centre can be passed as it stands.

/** Take away the ring around the pointer, if one is displayed. */
function mouseHighlightClear() {
    if (highlightTimer) {
        highlightTimer.stop()
        highlightTimer = null
    }
    if (highlightWindow) {
        highlightWindow.destroy()
        highlightWindow = null
    }
}

/**
 * Draw a ring around a point for `config.mouseHighlightSeconds`.
 *
 * The pointer has just jumped across the desktop, and the eye has not followed it; the
 * ring says where it landed.
 *
 * A stroke and no fill: UICircle draws the fill instead of the stroke when both are given,
 * so a filled circle cannot be a ring. The window is a stroke-width larger than the circle,
 * since the line is centred on the circle's edge and half of it would otherwise be clipped.
 *
 * The ring ignores mouse events, so a click inside its square reaches the window
 * underneath rather than landing on the ring.
 *
 * @param {number} x Centre, in screen coordinates.
 * @param {number} y Centre, in screen coordinates.
 */
function mouseHighlight(x, y) {
    mouseHighlightClear()

    const diameter = config.mouseHighlightSize
    const width = config.mouseHighlightWidth
    const box = diameter + width
    const rect = toUIRect({ x: x - box / 2, y: y - box / 2, w: box, h: box })

    highlightWindow = hs.canvas.create({ x: rect.x, y: rect.y, w: rect.w, h: rect.h })
        .level("status")
        // Clicks inside the ring reach whatever is underneath it.
        .ignoreMouseEvents(true)
        .behaviorList(["canJoinAllSpaces", "stationary"])
    highlightWindow.appendElements([{
        type: "circle",
        action: "stroke",
        strokeColor: canvasColor(config.mouseHighlightColor),
        strokeWidth: width,
        center: { x: rect.w / 2, y: rect.h / 2 },
        radius: diameter / 2
    }])
    highlightWindow.show()

    highlightTimer = hs.timer.doAfter(config.mouseHighlightSeconds, () => {
        highlightTimer = null
        mouseHighlightClear()
    })
}

/** Put the pointer at a point in screen coordinates, and ring it. */
function mouseMoveTo(x, y) {
    hs.mouse.setAbsolutePosition(x, y)
    mouseHighlight(x, y)
    return true
}

/** Put the pointer in the middle of a window. */
function mouseWindowCenter(win) {
    const window = win || focused()
    if (!window) return false
    const frame = window.frame
    return mouseMoveTo(frame.x + frame.w / 2, frame.y + frame.h / 2)
}

/**
 * Put the pointer in the middle of the next window, advancing on each call.
 *
 * The position in the order has to be remembered between calls. Moving the pointer neither
 * raises nor focuses a window, so `orderedWindows()` returns the same list every time, and
 * taking the second entry each call would move the pointer to the same window however
 * often it was invoked.
 *
 * The walk restarts whenever the set of windows or their order differs from the last call,
 * which is what happens once a window is actually focused or opened, so it does not carry
 * an index into a list it no longer describes.
 *
 * Only standard windows are walked, so the pointer does not stop on a Notification Centre
 * widget or the Finder's desktop.
 */
function mouseWindowCenterNext() {
    const ordered = hs.window.orderedWindows()
        .filter((w) => w.isStandard && w.isVisible && !w.isMinimized)
    if (ordered.length < 2) {
        alert("No other window")
        return false
    }

    const order = ordered.map((w) => w.id).join(",")
    // Index 0 is the frontmost window, so a fresh walk starts at 1, and wrapping past the
    // end returns to it rather than skipping it.
    mouseNextIndex = order === mouseNextOrder ? (mouseNextIndex + 1) % ordered.length : 1
    mouseNextOrder = order

    return mouseWindowCenter(ordered[mouseNextIndex])
}

/**
 * Put the pointer in the middle of a screen.
 *
 * The focused window's screen, since that is the one being worked on, and the primary
 * screen when nothing is focused. fullFrame rather than frame: the middle of the display
 * itself, not of the area left over by the menu bar and the Dock.
 */
function mouseScreenCenter(screen) {
    const window = focused()
    const target = screen || (window && window.screen) || hs.screen.primary()
    if (!target) return false
    const frame = target.fullFrame
    return mouseMoveTo(frame.x + frame.w / 2, frame.y + frame.h / 2)
}

/**
 * Put the pointer in the middle of the next screen.
 *
 * Nothing is remembered between calls, unlike mouseWindowCenterNext: the pointer is moved
 * onto the screen, so the screen it is on is where the next call starts from. hs.screen.all()
 * keeps a stable order, so repeated calls walk the displays and come back round.
 *
 * The screen under the pointer is the starting point rather than the focused window's. The
 * pointer is what is being moved, and after the first call the two are on different screens
 * anyway, since moving the pointer does not change which window has focus.
 */
function mouseScreenCenterNext() {
    const screens = hs.screen.all()
    if (screens.length < 2) {
        alert("Only one screen")
        return false
    }

    const here = hs.mouse.getCurrentScreen()
    const index = here ? screens.findIndex((s) => s.id === here.id) : -1
    // An unknown current screen gives -1, which starts at the first screen.
    return mouseScreenCenter(screens[(index + 1) % screens.length])
}

// MARK: - Windows attached to number keys
//
// A window is attached to a digit, and that digit with config.attachModifiers focuses it
// from then on. Ported from wkeys_attach_current_window_to_key() in the Hammerspoon 1
// configuration, with two changes: attaching a digit that is already in use releases the
// old binding, which the v1 version left bound and holding its window; and the window is
// remembered by id and looked up when the key is pressed, so a window that has since been
// closed is reported rather than silently doing nothing.

// Digit -> {hotkey, id, title, bundleID}.
const attachedKeys = new Map()

// The number row, by key code. hs.keycodes.map is no use here: it holds both directions in
// one object, so the names "0" to "9" collide with the key codes 0 to 9, and the digits
// are missing from it either way. Key codes are read rather than event.characters because
// characters are transformed by the modifiers -- with Option held, 1 arrives as "\u00a1".
const DIGIT_KEY_CODES = {
    18: "1", 19: "2", 20: "3", 21: "4", 23: "5",
    22: "6", 26: "7", 28: "8", 25: "9", 29: "0"
}
const ESCAPE_KEY_CODE = 53

// The tap waiting for a number key, and the timer that gives up on it. One at a time.
let captureTap = null
let captureTimer = null

/** Stop waiting for a number key. */
function captureStop() {
    if (captureTap) {
        hs.eventtap.removeWatcher(captureTap)
        captureTap = null
    }
    if (captureTimer) {
        captureTimer.stop()
        captureTimer = null
    }
}

/**
 * Wait for one key press and report which digit it was.
 *
 * A tap rather than a dialog: a text prompt is a lot of ceremony for one character, and it
 * takes the keyboard and the focus with it. This consumes the key it captures, so the digit
 * is not also typed into whatever is in front.
 *
 * The key is expected without a modifier. A modifier chord that is already bound is taken
 * by the hotkey before any tap sees it -- alt-3 would fire the window attached to 3 rather
 * than arriving here -- so the wait would simply time out.
 *
 * @param {function} report Called with the digit, or with null for Escape or a timeout, or
 *        with "" for a key that is not a digit.
 */
function captureDigit(report) {
    captureStop()

    captureTap = hs.eventtap.addWatcher([hs.eventtap.eventTypes.keyDown], (event) => {
        const code = event.keyCode
        captureStop()
        report(code === ESCAPE_KEY_CODE ? null : (DIGIT_KEY_CODES[code] || ""))
        return hs.eventtap.consume
    }, false)

    if (!captureTap) {
        console.error("[hs_window-gt] could not watch for a key press")
        report(null)
        return false
    }

    captureTap.start()
    captureTimer = hs.timer.doAfter(config.attachKeyWait, () => {
        captureStop()
        report(null)
    })
    return true
}

/**
 * Release a number key, if a window is attached to it.
 *
 * Both halves of the attachment go: the hotkey, and the watcher that was waiting for the
 * window to close. Removing the watcher takes the same element, notification and listener
 * that added it, which is why the entry keeps all three.
 */
function detachKey(key) {
    const digit = String(key)
    const entry = attachedKeys.get(digit)
    if (!entry) return false

    if (entry.element && entry.onDestroyed) {
        try {
            hs.ax.removeWatcher(entry.element, hs.ax.notificationTypes.uIElementDestroyed,
                                entry.onDestroyed)
        } catch (e) {
            // The element is usually already gone when this runs, since the window closing
            // is what brought us here. Nothing is left to remove, and that is not a fault.
            console.log(`[hs_window-gt] watcher for ${digit} was already gone: ${e && e.message ? e.message : e}`)
        }
    }

    entry.hotkey.destroy()
    attachedKeys.delete(digit)
    return true
}

/** Release every number key. */
function detachAllKeys() {
    for (const digit of [...attachedKeys.keys()]) detachKey(digit)
    return true
}

/**
 * What is attached to what.
 *
 * `title` is what the window was called when it was attached, not what it is called now:
 * the attachment follows the window's id, and a window that has been retitled since is
 * still listed under its old name.
 *
 * @returns {object} Digit -> `{title, id, bundleID, alive, nowTitled}`.
 */
function attachedWindows() {
    const windows = hs.window.allWindows()
    const listed = {}
    for (const [digit, entry] of attachedKeys) {
        const window = windows.find((w) => w.id === entry.id)
        listed[digit] = {
            title: entry.title,
            id: entry.id,
            bundleID: entry.bundleID,
            alive: Boolean(window),
            nowTitled: window ? window.title : null,
            nowBundleID: window && window.application ? window.application.bundleID : null
        }
    }
    return listed
}

/**
 * Focus the window attached to a digit, releasing the key if the window has gone.
 *
 * There is no window-closed event to unbind on — Hammerspoon 2 has no hs.window.filter —
 * so the window is looked up when the key is pressed rather than held onto. Finding it
 * gone is the moment the attachment is known to be dead, so that is when it is released:
 * one press says what happened, and the chord is free from then on. Nothing has to be
 * watched or swept, and a session that never attaches a key does no work at all.
 *
 * Releasing the hotkey from inside its own handler is safe. destroy() disables it and
 * detaches its callbacks; the callback running at that moment is held by the interpreter's
 * own stack frame, and the dispatch loop returns as soon as it has fired one hotkey.
 *
 * The application is checked as well as the id. Window ids are reused: a window opened
 * after this one closed can be given the same number, and without this the key would
 * silently focus a stranger. Comparing the bundle identifier catches another application
 * inheriting the id; a second window of the same application is not distinguishable this
 * way, and is not worth more machinery.
 */
function focusAttached(digit) {
    const entry = attachedKeys.get(digit)
    if (!entry) return false

    const window = hs.window.allWindows().find((w) => w.id === entry.id)
    const bundleID = window && window.application ? window.application.bundleID : null
    if (!window || (entry.bundleID && bundleID !== entry.bundleID)) {
        detachKey(digit)
        alert(`${digit} was ${entry.title}\nthat window has gone, key released`)
        return false
    }

    // Pressing the key for the window you are already in goes back where you came from, so
    // one key both reaches a window and returns from it. previousWindow() is what tracks
    // that, and it is updated by focusing here as much as by switching windows by hand.
    const here = focused()
    if (here && here.id === window.id) return previousWindow()

    return focusWindow(window)
}

/**
 * Attach a window to a number key, given the digit.
 *
 * @param {object} target The window.
 * @param {string} digit One of config.attachKeys.
 * @returns {boolean} Whether it was attached.
 */
function attachDigit(target, digit) {
    if (digit.length !== 1 || !config.attachKeys.includes(digit)) {
        alert(`Cannot attach to "${digit}"\nuse one of ${config.attachKeys}`)
        return false
    }

    // Whatever was on this digit is forgotten: its hotkey is destroyed and its entry
    // dropped, so the window it pointed at is no longer reachable through this key and
    // nothing is left holding it.
    detachKey(digit)

    const title = target.title || (target.application ? target.application.title : "window")
    const hotkey = hs.hotkey.bind(config.attachModifiers, digit, () => focusAttached(digit), null)
    if (!hotkey) {
        alert(`Could not bind ${config.attachModifiers.join("-")}-${digit}`)
        return false
    }

    // Watching the window itself, which became possible when hs.ax watchers stopped being
    // restricted to applications. Without it the key stays bound to a window that no longer
    // exists: Hammerspoon goes on swallowing the chord, and nothing gives it back until the
    // key is pressed and found to be dead. A closed window is invisible as a cause, so the
    // chord would simply stop working in other applications for no apparent reason.
    //
    // The press-time check in focusAttached stays as the backstop. This does not fire when
    // an application quits outright rather than closing its windows, and addWatcher can
    // fail to attach at all.
    const element = target.axElement()
    let onDestroyed = null
    if (element) {
        onDestroyed = () => {
            if (!attachedKeys.has(digit)) return
            detachKey(digit)
            alert(`${config.attachModifiers.join("-")}-${digit} released\n${title} has closed`)
        }
        try {
            hs.ax.addWatcher(element, hs.ax.notificationTypes.uIElementDestroyed, onDestroyed)
        } catch (e) {
            console.error(`[hs_window-gt] could not watch ${title} for closing: ${e && e.message ? e.message : e}`)
            onDestroyed = null
        }
    }

    attachedKeys.set(digit, {
        hotkey: hotkey,
        id: target.id,
        title: title,
        bundleID: target.application ? target.application.bundleID : null,
        element: onDestroyed ? element : null,
        onDestroyed: onDestroyed
    })
    alert(`${config.attachModifiers.join("-")}-${digit}\n${title}`)
    return true
}

/**
 * Attach a window to a number key, asking for the key if one is not given.
 *
 * With no digit, the next key press is captured and consumed. The key is asked for on its
 * own, without a modifier: a modifier chord that is already attached would be taken by its
 * hotkey before the tap saw it.
 *
 * Nothing takes the focus, so the window being attached is still the focused one
 * throughout, and there is nothing to give the focus back to afterwards.
 *
 * @param {object} [window] The window to attach. Defaults to the focused one.
 * @param {string|number} [key] The digit. Omit to be asked for it.
 * @returns {boolean} Whether a window was found to attach.
 */
function attachKeyToWindow(window, key) {
    const target = window || focused()
    if (!target) {
        alert("No window to attach")
        return false
    }

    if (key !== undefined && key !== null && String(key).trim() !== "") {
        return attachDigit(target, String(key).trim())
    }

    alert(`Press a number key for\n${target.title || (target.application ? target.application.title : "window")}`)
    captureDigit((digit) => {
        // null is Escape or a timeout: nothing was chosen, so nothing is said.
        if (digit === null) return
        attachDigit(target, digit)
    })
    return true
}

// MARK: - Isolation
//
// Everything except the focused window is dimmed, by covering each screen with a dark
// window placed just below the focused one.

function isolationOn() {
    return isolationWindows.length > 0
}

/**
 * One dark panel.
 *
 * The darkness is a filled rectangle inside the window, not the window's own background: a
 * window with nothing in it draws nothing, whatever its background colour is set to, which
 * is why earlier versions of this were invisible. This is the shape hs_countdown-gt's
 * progress bar uses, which is known to render.
 *
 * "status" is above other applications' windows. "normal" is Hammerspoon's own layer,
 * behind whichever application is frontmost.
 */
/**
 * Convert a rectangle from screen coordinates to hs.ui window coordinates.
 *
 * A screen's frame and a window's frame have their origin at the top left of the primary
 * screen, with y increasing downwards. An hs.ui window is placed with its origin at the
 * bottom left of the primary screen, with y increasing upwards, so a screen below the
 * primary has a negative y. Passing one as the other puts a panel somewhere plausible but
 * wrong, which is what dimmed the left of the screen rather than the right.
 */
function toUIRect(rect) {
    const primary = hs.screen.primary().fullFrame
    const primaryBottom = primary.y + primary.h
    return {
        x: rect.x,
        y: primaryBottom - (rect.y + rect.h),
        w: rect.w,
        h: rect.h
    }
}

// Canvas colours are {red, green, blue, alpha} components in 0..1.
function canvasColor(value, alpha) {
    const text = String(value || "#000000").replace("#", "")
    const hex = text.length === 3 ? text.split("").map((c) => c + c).join("") : text
    const component = (at) => parseInt(hex.slice(at, at + 2), 16) / 255
    const own = hex.length >= 8 ? component(6) : 1
    return {
        red: component(0),
        green: component(2),
        blue: component(4),
        alpha: own * (alpha === undefined ? 1 : alpha)
    }
}

function addOverlay(screenRect) {
    if (screenRect.w <= 0 || screenRect.h <= 0) return
    const rect = toUIRect(screenRect)

    const overlay = hs.canvas.create({ x: rect.x, y: rect.y, w: rect.w, h: rect.h })
        .level("status")
        // Clicks pass through the dimming to the windows underneath.
        .ignoreMouseEvents(true)
        .behaviorList(["canJoinAllSpaces", "stationary"])
    overlay.appendElements([{
        type: "rectangle",
        action: "fill",
        fillColor: canvasColor(config.isolationColor, config.isolationOpacity),
        frame: { x: 0, y: 0, w: rect.w, h: rect.h }
    }])
    overlay.show()

    isolationWindows.push(overlay)
}

/**
 * Dim everything except the focused window.
 *
 * The focused window is left uncovered rather than raised above the dimming: window level
 * beats window order, so an overlay above other applications cannot be got behind. Its
 * screen is covered by four panels around the window — above, below, left and right — and
 * every other screen by one.
 *
 * The panels ignore mouse events, so clicks reach the windows beneath the dimming as
 * usual; nothing covers the focused window in any case.
 */
function startIsolation() {
    if (isolationOn()) return module.exports

    const window = focused()
    const hole = window ? window.frame : null
    const holeScreen = window && window.screen ? window.screen.id : null

    for (const screen of screenList()) {
        const f = screen.fullFrame

        if (!hole || screen.id !== holeScreen) {
            addOverlay({ x: f.x, y: f.y, w: f.w, h: f.h })
            continue
        }

        const holeBottom = hole.y + hole.h
        const holeRight = hole.x + hole.w

        addOverlay({ x: f.x, y: f.y, w: f.w, h: hole.y - f.y })
        addOverlay({ x: f.x, y: holeBottom, w: f.w, h: (f.y + f.h) - holeBottom })
        addOverlay({ x: f.x, y: hole.y, w: hole.x - f.x, h: hole.h })
        addOverlay({ x: holeRight, y: hole.y, w: (f.x + f.w) - holeRight, h: hole.h })
    }
    return module.exports
}

function stopIsolation() {
    for (const overlay of isolationWindows) {
        try {
            // Hidden as well as destroyed: destroy() on its own left the panels on screen,
            // and once the list is cleared there is no way back to them short of a reload.
            overlay.hide()
            overlay.destroy()
        } catch (e) {
            console.error(`[hs_window-gt] could not remove an isolation overlay: ${e.message}`)
        }
    }
    isolationWindows = []
    return module.exports
}

function toggleIsolation() {
    return isolationOn() ? stopIsolation() : startIsolation()
}

// MARK: - Information

/** Show a window's application, title, screen and frame. */
function info(win) {
    const window = win || focused()
    if (!window) {
        alert("No window")
        return null
    }

    const app = window.application
    const frame = window.frame
    const text = [
        app ? app.title : "(unknown application)",
        app && app.bundleID ? app.bundleID : "",
        window.title || "(no title)",
        `${window.screen ? window.screen.name : "?"}  ` +
        `${Math.round(frame.x)},${Math.round(frame.y)} ` +
        `${Math.round(frame.w)}×${Math.round(frame.h)}`,
        `history: ${historyDepth(window)}`
    ].filter(Boolean).join("\n")

    hs.ui.alert(text).duration(4).show()
    console.log(`[hs_window-gt] ${text.replace(/\n/g, " | ")}`)
    return text
}

// MARK: - Screenshots

function twoDigits(n) {
    return String(n).padStart(2, "0")
}

// Sortable, and safe in a filename on any system: 2026-09-09-174530.
function timestamp() {
    const now = new Date()
    return `${now.getFullYear()}-${twoDigits(now.getMonth() + 1)}-${twoDigits(now.getDate())}` +
        `-${twoDigits(now.getHours())}${twoDigits(now.getMinutes())}${twoDigits(now.getSeconds())}`
}

/**
 * Capture a window to the pasteboard and to a PNG file.
 *
 * Both, because the two are used differently: the pasteboard copy can be pasted straight
 * into a message, and the file remains available afterwards.
 *
 * PNG only, deliberately. A window is flat colour and sharp text, which is what PNG
 * compresses well and JPEG compresses badly: the same capture came to 710KB as a PNG and
 * 1.3MB as a JPEG at quality 80, with visible artefacts around the text. If these files
 * ever need to be smaller, scale the image down; JPEG will not make them smaller.
 *
 * @param {object} [window] The window. Defaults to the focused one.
 * @returns {Promise} Resolves to the path written, or to null if nothing was captured.
 */
function screenshot(window) {
    const target = window || focused()
    if (!target) {
        console.error("[hs_window-gt] no window to capture")
        return Promise.resolve(null)
    }

    const application = target.application ? target.application.title : "window"
    const directory = hs.fs.pathToAbsolute(config.screenshotDir) || config.screenshotDir
    const name = `${timestamp()}-${application}`.replace(/[^A-Za-z0-9._-]+/g, "_")
    const png = `${directory}/${name}.png`

    return target.snapshot().then((image) => {
        if (!image) return screenshotFailed(application, "nothing was captured")

        hs.pasteboard.writeImage(image)

        if (!image.saveToFile(png)) {
            return screenshotFailed(application, `could not write ${png}`)
        }

        // Said on screen, as info() does: the pasteboard copy is invisible, so without
        // this there is nothing to tell a capture that worked from one that did not.
        hs.ui.alert(`Copied, and saved to\n${png}`).duration(config.screenshotAlertSeconds).show()
        console.log(`[hs_window-gt] captured ${application} to ${png}`)
        return png
    }, (e) => {
        // Rejected rather than thrown: the window may have closed, or Screen Recording
        // permission may not have been granted.
        return screenshotFailed(application, e && e.message ? e.message : String(e))
    })
}

function screenshotFailed(application, reason) {
    console.error(`[hs_window-gt] could not capture ${application}: ${reason}`)
    hs.ui.alert(`Could not capture ${application}`).duration(config.screenshotAlertSeconds).show()
    return null
}

// MARK: - Lifecycle

function start() {
    installAdvice()

    if (!forgetTimer) {
        forgetTimer = hs.timer.doEvery(config.forgetInterval, () => forgetClosedWindows())
    }

    // For previousWindow(): each time the focused window changes, what was current becomes
    // previous. Driven by application activation, which is the closest event available —
    // moving between two windows of the same application is not seen.
    //
    // hs.application.addWatcher takes one handler and reports every event to it, so the
    // event this one cares about is selected here rather than at registration.
    if (!focusWatcher) {
        focusWatcher = (event) => {
            if (event !== "didActivate") return
            const window = hs.window.focusedWindow()
            if (!window || window.id === currentFocusedId) return
            previousFocusedId = currentFocusedId
            currentFocusedId = window.id
        }
        hs.application.addWatcher(focusWatcher)
    }
    return module.exports
}

function stop() {
    removeAdvice()
    stopIsolation()
    mouseHighlightClear()
    detachAllKeys()
    captureStop()
    if (forgetTimer) {
        forgetTimer.stop()
        forgetTimer = null
    }
    if (focusWatcher) {
        hs.application.removeWatcher(focusWatcher)
        focusWatcher = null
    }
    return module.exports
}

module.exports = {
    config,
    // History.
    undo,
    redo,
    historyDepth,
    clearHistory,
    forgetClosedWindows,
    isMaximized,
    isVerticallyMaximized,
    isHorizontallyMaximized,
    // Grid placement.
    place,
    maximize,
    leftHalf,
    rightHalf,
    topHalf,
    bottomHalf,
    leftThird,
    centerThird,
    rightThird,
    leftTwoThirds,
    rightTwoThirds,
    topLeft,
    topRight,
    bottomLeft,
    bottomRight,
    center,
    // Resizing in place.
    verticalMaximize,
    horizontalMaximize,
    halfHeight,
    halfWidth,
    fractionWidth,
    moveByOwnSize,
    // Screens.
    moveToScreen,
    fullscreenScreenIds,
    screenHasFullscreenWindow,
    // Windows among themselves.
    tileWith,
    swapWithWindow,
    swapWithPrevious,
    previousWindow,
    sendToBack,
    // The mouse.
    mouseWindowCenter,
    mouseWindowCenterNext,
    mouseScreenCenter,
    mouseScreenCenterNext,
    mouseMoveTo,
    mouseHighlight,
    // Isolation.
    toggleIsolation,
    startIsolation,
    stopIsolation,
    isolationOn,
    focusWindow,
    // Windows attached to number keys.
    attachKeyToWindow,
    attachDigit,
    focusAttached,
    detachKey,
    detachAllKeys,
    attachedWindows,
    // Information.
    info,
    screenshot,
    start,
    stop
}
