// hs_time-gt — a port of the Hammerspoon 1 AClock spoon (hs_time.spoon) to Hammerspoon 2.
//
// A large clock, centred on the screen holding the focused window and floating above
// everything else. Show it for a few seconds, or leave it up until dismissed.
//
//     const clock = hs.loadSpoon("hs_time-gt")
//     clock.toggleShow()             // displayed for a few seconds
//     clock.toggleShowPersistent()   // displayed until toggled again, or Escape
//
// The clock is an hs.canvas: one text element, drawn in whatever font `textFont` names.
// It is built at each show() rather than moved, so it appears on whichever screen is
// current then — a canvas could be repositioned instead, but the clock is torn down when
// it is hidden, and building one costs microseconds.
//
// It ignores the mouse. The window spans the screen, and for the seconds it is up it would
// otherwise swallow every click behind it.

// MARK: - User-configurable settings

const config = {
    // strftime-style format. See formatTime() for the specifiers supported.
    format: "%H:%M",
    textFont: "Impact",
    textSize: 135,
    textColor: "#1891C3",
    // "full" spans the screen, so a long format is never truncated. A number gives a
    // fixed width in points, as the v1 Spoon had.
    width: "full",
    height: 230,
    // Seconds toggleShow() leaves the clock on screen.
    showDuration: 4,
    // Dismisses the clock while it is showing. Set hotkey to null for none.
    hotkey: "escape",
    hotkeyMods: [],
    // Window stacking level: "floating", "status", "screenSaver", "popUpMenu".
    level: "floating"
}

// MARK: - State

let clockCanvas = null
let tickTimer = null
let showTimer = null
let cancelHotkey = null

// MARK: - Time formatting
//
// Lua's os.date() is not available, and the v1 configuration is written in its terms, so
// the common strftime specifiers are supported here.

const dayNames = ["Sunday", "Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday"]
const monthNames = ["January", "February", "March", "April", "May", "June",
                    "July", "August", "September", "October", "November", "December"]

function pad(value, width, filler) {
    return String(value).padStart(width === undefined ? 2 : width, filler === undefined ? "0" : filler)
}

/**
 * Format a date with strftime-style specifiers.
 *
 * Supported: %H %I %M %S %p %P %d %e %m %y %Y %A %a %B %b %j %X %x %c %n %t %% — an
 * unknown specifier is left as written.
 *
 * @param {string} format The format string.
 * @param {Date} [date] The moment to format. Defaults to now.
 * @returns {string} The formatted time.
 */
function formatTime(format, date) {
    const now = date || new Date()
    const hours = now.getHours()
    const hours12 = hours % 12 === 0 ? 12 : hours % 12

    const startOfYear = new Date(now.getFullYear(), 0, 0)
    const dayOfYear = Math.floor((now - startOfYear) / 86400000)

    const specifiers = {
        H: pad(hours),
        I: pad(hours12),
        M: pad(now.getMinutes()),
        S: pad(now.getSeconds()),
        p: hours < 12 ? "AM" : "PM",
        P: hours < 12 ? "am" : "pm",
        d: pad(now.getDate()),
        e: pad(now.getDate(), 2, " "),
        m: pad(now.getMonth() + 1),
        y: pad(now.getFullYear() % 100),
        Y: String(now.getFullYear()),
        A: dayNames[now.getDay()],
        a: dayNames[now.getDay()].slice(0, 3),
        B: monthNames[now.getMonth()],
        b: monthNames[now.getMonth()].slice(0, 3),
        j: pad(dayOfYear, 3),
        // Locale representations, as os.date() gives them.
        X: now.toLocaleTimeString(),
        x: now.toLocaleDateString(),
        c: now.toLocaleString(),
        n: "\n",
        t: "\t",
        "%": "%"
    }

    return format.replace(/%(.)/g, (whole, specifier) =>
        specifier in specifiers ? specifiers[specifier] : whole)
}

// MARK: - The window

// The screen holding the focused window, or the main screen when nothing is focused.
function currentScreen() {
    const win = hs.window.focusedWindow()
    return win && win.screen ? win.screen : hs.screen.main()
}

// hs.screen frames have their origin at the top left of the primary display, while a
// canvas window's frame has its at that display's bottom left, with y growing upwards.
function windowFrameCentredOn(screen) {
    const reference = hs.screen.primary() || screen
    if (!screen || !reference) return null

    const primary = reference.fullFrame
    const area = screen.fullFrame

    // The text is centred within the window, so a full-width window centres the clock on
    // the screen, and a long format has the whole width available.
    const width = config.width === "full" ? area.w : config.width
    const left = area.x + (area.w - width) / 2
    const top = area.y + (area.h - config.height) / 2

    return {
        x: left,
        y: (primary.y + primary.h) - (top + config.height),
        w: width,
        h: config.height
    }
}

// Canvas colours are {red, green, blue, alpha} components in 0..1.
function canvasColor(value) {
    const text = String(value || "#000000").replace("#", "")
    const hex = text.length === 3 ? text.split("").map((c) => c + c).join("") : text
    const component = (at) => parseInt(hex.slice(at, at + 2), 16) / 255
    return {
        red: component(0),
        green: component(2),
        blue: component(4),
        alpha: hex.length >= 8 ? component(6) : 1
    }
}

function build() {
    const frame = windowFrameCentredOn(currentScreen())
    if (!frame) return

    clockCanvas = hs.canvas.create(frame)
        .level(config.level)
        // The clock is a caption, not a target. Without this a window spanning the screen
        // would swallow every click behind it for as long as it is up.
        .ignoreMouseEvents(true)
        .behaviorList(["canJoinAllSpaces", "stationary"])

    clockCanvas.appendElements([{
        type: "text",
        text: formatTime(config.format),
        textFont: config.textFont || undefined,
        textSize: config.textSize,
        textColor: canvasColor(config.textColor),
        textAlignment: "center",
        textLineBreak: "clip",
        frame: { x: 0, y: 0, w: frame.w, h: frame.h }
    }])
}

function setText(text) {
    if (!clockCanvas) return
    clockCanvas.setElementAttribute(0, "text", text)
}

function destroyWindow() {
    if (!clockCanvas) return
    clockCanvas.destroy()
    clockCanvas = null
}

// MARK: - Public API

/** Whether the clock is on screen. */
function isShowing() {
    return clockCanvas !== null
}

/**
 * Show the clock, centred on the screen holding the focused window. It stays until
 * `hide()` is called, or Escape is pressed.
 */
function show() {
    if (clockCanvas) hide()

    build()
    if (!clockCanvas) return module.exports
    clockCanvas.show()

    // Ticks every second, so the displayed time stays current.
    tickTimer = hs.timer.doEvery(1, () => {
        setText(formatTime(config.format))
    })

    if (config.hotkey) {
        // Bound only while the clock is displayed, so Escape reaches other applications
        // at all other times. The handle is kept: an unheld hotkey is garbage collected.
        cancelHotkey = hs.hotkey.bind(config.hotkeyMods, config.hotkey, () => hide(), null)
        if (!cancelHotkey) {
            console.error(`[hs_time-gt] could not bind ${config.hotkey} to dismiss the clock`)
        }
    }

    return module.exports
}

/** Hide the clock, if it is showing. */
function hide() {
    // The hotkey goes first: if anything below throws, Escape is not left bound.
    if (cancelHotkey) {
        cancelHotkey.destroy()
        cancelHotkey = null
    }
    if (tickTimer) {
        tickTimer.stop()
        tickTimer = null
    }
    destroyWindow()
    return module.exports
}

/** Show the clock for `config.showDuration` seconds, or hide it if it is showing. */
function toggleShow() {
    if (isShowing()) {
        hide()
        if (showTimer) {
            showTimer.stop()
            showTimer = null
        }
        return module.exports
    }

    show()
    showTimer = hs.timer.doAfter(config.showDuration, () => {
        hide()
        showTimer = null
    })
    return module.exports
}

/** Show the clock until it is toggled again or dismissed. No timeout. */
function toggleShowPersistent() {
    if (isShowing()) hide()
    else show()
    return module.exports
}

/**
 * Bind hotkeys for the clock.
 *
 * @param {object} [mapping] Keyed by action name — `toggleShow`, `toggleShowPersistent`,
 *        `show`, `hide` — each holding `[[modifiers], key]`.
 */
function bindHotkeys(mapping) {
    const actions = {
        toggleShow: () => toggleShow(),
        toggleShowPersistent: () => toggleShowPersistent(),
        show: () => show(),
        hide: () => hide()
    }

    for (const [name, spec] of Object.entries(mapping || {})) {
        if (!actions[name]) {
            console.error(`[hs_time-gt] unknown hotkey action: ${name}`)
            continue
        }
        hotkeys.push(hs.hotkey.bind(spec[0], spec[1], actions[name], null))
    }
    return module.exports
}

let hotkeys = []

function start() {
    return module.exports
}

/** Hide the clock and release every hotkey this Spoon bound. */
function stop() {
    hide()
    if (showTimer) {
        showTimer.stop()
        showTimer = null
    }
    for (const hotkey of hotkeys) {
        if (hotkey) hotkey.destroy()
    }
    hotkeys = []
    return module.exports
}

module.exports = {
    config,
    formatTime,
    isShowing,
    show,
    hide,
    toggleShow,
    toggleShowPersistent,
    bindHotkeys,
    start,
    stop
}
