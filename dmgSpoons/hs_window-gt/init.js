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
// hs.window.filter to subscribe to window events; Hammerspoon 2 has no equivalent, and
// assembling one from hs.ax means an observer per application per notification. The advice
// costs one property redefinition and sees everything except a window moved by hand.
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
    // hs.ui windows cannot ignore mouse events, so a click inside the ring lands on it
    // rather than on the window beneath. mouseHighlightSeconds is therefore also how long
    // that square is unclickable, and is the reason it is short.
    mouseHighlightColor: "#FF0000",
    mouseHighlightSize: 60,
    mouseHighlightWidth: 4,
    mouseHighlightSeconds: 0.5,

    // Seconds between sweeps for records of windows that have closed.
    forgetInterval: 120,

    // Reapplying a size after moving a window to another screen: how many attempts, and
    // how long to wait between them. See setFrameOnScreen for why one is not enough.
    resizeAttempts: 5,
    resizeDelay: 0.05
}

// MARK: - State

// Window id -> { ring, walk, applied, unmaximized, onScreen }
//   ring         positions to walk back through, oldest first
//   walk         how far back undo has walked, null when not walking
//   applied      where we last put the window, for spotting a move we did not make
//   unmaximized  size to go back to when maximize is pressed a second time
//   onScreen     screen id -> the frame the window had when it last left that screen
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
        entry = { ring: [], walk: null, applied: null, unmaximized: null, onScreen: new Map() }
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

/** Fill the screen's height, keeping width and horizontal position. */
function verticalMaximize(win) {
    const window = win || focused()
    if (!window) return false
    const screen = window.screen.frame
    const frame = window.frame
    window.frame = new HSRect(frame.x, screen.y, frame.w, screen.h)
    return true
}

/** Fill the screen's width, keeping height and vertical position. */
function horizontalMaximize(win) {
    const window = win || focused()
    if (!window) return false
    const screen = window.screen.frame
    const frame = window.frame
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
        if (still) {
            still.focus()
            return true
        }
    }

    // Nothing remembered, or it has gone: the next window in order will do.
    const ordered = hs.window.orderedWindows()
    if (ordered.length < 2) {
        alert("No previous window")
        return false
    }
    ordered[1].focus()
    return true
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
 * As with the isolation overlays, an hs.ui window cannot ignore mouse events, so while the
 * ring is displayed a click inside its square lands on the ring rather than on the window
 * underneath. This is why it is measured in fractions of a second.
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

    highlightWindow = hs.ui.window({ x: rect.x, y: rect.y, w: rect.w, h: rect.h })
        .titled(false)
        .level("status")
        .backgroundColor("#00000000")
        .hstack()
        .spacing(0)
    highlightWindow.circle()
        .stroke(HSColor.hex(config.mouseHighlightColor))
        .strokeWidth(width)
        .frame({ w: diameter, h: diameter })
    highlightWindow.end()
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

/** Put the pointer in the middle of the next window in order. */
function mouseWindowCenterNext() {
    const ordered = hs.window.orderedWindows()
    if (ordered.length < 2) {
        alert("No other window")
        return false
    }
    return mouseWindowCenter(ordered[1])
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

function addOverlay(screenRect) {
    if (screenRect.w <= 0 || screenRect.h <= 0) return
    const rect = toUIRect(screenRect)

    const overlay = hs.ui.window({ x: rect.x, y: rect.y, w: rect.w, h: rect.h })
        .titled(false)
        .level("status")
        .hstack()
        .spacing(0)
    overlay.rectangle()
        .fill(HSColor.hex(config.isolationColor))
        .opacity(config.isolationOpacity)
        .frame({ w: "100%", h: "100%" })
    overlay.end()
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
 * hs.ui windows cannot ignore mouse events, so while this is on, clicks land on the
 * dimming rather than on the windows beneath it. The focused window stays clickable
 * because nothing covers it.
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

// MARK: - Lifecycle

function start() {
    installAdvice()

    if (!forgetTimer) {
        forgetTimer = hs.timer.doEvery(config.forgetInterval, () => forgetClosedWindows())
    }

    // For previousWindow(): each time the focused window changes, what was current becomes
    // previous. Driven by application activation, which is the closest event available —
    // moving between two windows of the same application is not seen.
    if (!focusWatcher) {
        focusWatcher = () => {
            const window = hs.window.focusedWindow()
            if (!window || window.id === currentFocusedId) return
            previousFocusedId = currentFocusedId
            currentFocusedId = window.id
        }
        hs.application.addWatcher("didActivate", focusWatcher)
    }
    return module.exports
}

function stop() {
    removeAdvice()
    stopIsolation()
    mouseHighlightClear()
    if (forgetTimer) {
        forgetTimer.stop()
        forgetTimer = null
    }
    if (focusWatcher) {
        hs.application.removeWatcher("didActivate", focusWatcher)
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
    mouseMoveTo,
    mouseHighlight,
    // Isolation.
    toggleIsolation,
    startIsolation,
    stopIsolation,
    isolationOn,
    // Information.
    info,
    start,
    stop
}
