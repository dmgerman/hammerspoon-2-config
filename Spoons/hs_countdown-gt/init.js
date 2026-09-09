// hs_countdown-gt — a port of the Hammerspoon 1 hs_countdown_timer.spoon (which
// declares itself as CountDown) to Hammerspoon 2.
//
// Three progress indicators:
//   * a horizontal bar along the bottom edge of the primary screen (always on)
//   * warnings showing the time left, at 1, 2, 4, 8, ... minutes remaining (optional)
//   * a menu bar item showing the time left, with pause/cancel entries (optional)
//
// When the time is up a sound plays, an alert is shown, and a dialog asks for
// acknowledgement.
//
// The progress bar is a row of fixed-width rectangles, re-coloured as the countdown
// advances: hs.ui element geometry is fixed once a window is built, while an HSColor
// passed to fill() is reactive. barSegments sets the bar's resolution.

// MARK: - User-configurable settings

const config = {
    // Timer length used by startFor() when no length is given.
    defaultLenMinutes: 25,
    // If true, the last length started becomes defaultLenMinutes.
    useLastTimerAsDefault: true,
    // If true, show a dialog that must be acknowledged when the time is up.
    notify: true,
    // Seconds a progress or error message stays on screen.
    messageDuration: 2,

    // Progress bar.
    barHeight: 5,
    barTransparency: 0.8,
    barColorPassed: "#28CD41",
    barColorToPass: "#FF3B30",
    barSegments: 240,

    // End of timer.
    alertLen: 5,
    alertSound: "Sonar",

    // Warnings, shown at 1, 2, 4, 8, ... minutes remaining.
    warningShow: true,
    warningDuration: 3,

    // Menu bar.
    menuBarAlwaysShow: true,
    menuBarIconIdle: "⏰",
    menuBarIconActive: "☣️",
    menuBarIconPlay: "▶️",
    menuBarIconPause: "⏸️",
    menuBarIconStop: "🛑",

    defaultKeyBindings: {
        startFor: [["cmd", "ctrl", "alt"], "t"],
        startInteractive: [["cmd", "ctrl", "alt", "shift"], "t"],
        pauseOrResume: [["cmd", "ctrl", "alt"], "p"],
        cancel: [["cmd", "ctrl", "alt"], "c"]
    }
}

// Event names passed to the caller's callback as its first argument.
const events = {
    start: "started",
    pause: "paused",
    resume: "resumed",
    cancel: "cancelled",
    end: "ended",
    setProgress: "setProgress"
}

// MARK: - State

let tickTimer = null
let timerRunning = false
// Wall-clock second at which the timer ends, adjusted forward while paused.
let endingTime = 0
let timeLeft = 0
let timerLenMinutes = 0
let pausedAt = null
let currentIcon = config.menuBarIconIdle
let userCallback = null

let menuBar = null
let hotkeys = []

let barCanvas = null
// How many segments the bar was built with. `config.barSegments` is what is asked for;
// this is what is there, which is what an index is checked against.
let barSegments = 0
// Number of segments currently coloured as elapsed, so a tick only re-colours
// the segments that have just been crossed.
let barFilled = 0
// Whether the bar is displayed. hs.ui windows do not report it, and a rebuild after a
// display change has to know whether to put the new one back on screen.
let barShowing = false
// The screen the bar was built for, so a countdown started on another one is noticed.
let barScreen = null
// Held so it can be removed again: the watcher is what notices that the primary screen
// has changed underneath the bar.
let screenWatcher = null

// MARK: - Helpers

function nowSeconds() {
    return Math.floor(hs.timer.secondsSinceEpoch())
}

function isPowerOfTwo(value) {
    if (!Number.isInteger(value) || value < 1) return false
    return (value & (value - 1)) === 0
}

function showMessage(message, duration) {
    hs.ui.alert(message).duration(duration ?? config.messageDuration).show()
}

function fireCallback(event, minutes) {
    if (!userCallback) return
    try {
        userCallback(event, minutes)
    } catch (e) {
        console.error(`[hs_countdown-gt] callback threw: ${e.message}`)
    }
}

// MARK: - Progress bar

// Canvas colours are {red, green, blue, alpha} components in 0..1, so the hex strings the
// settings are written in are converted here. config.barTransparency is folded in as the
// alpha, which is what opacity() used to carry on the hs.ui window.
function barColor(value) {
    const text = String(value || "#000000").replace("#", "")
    const hex = text.length === 3 ? text.split("").map((c) => c + c).join("") : text
    const component = (at) => parseInt(hex.slice(at, at + 2), 16) / 255
    const alpha = hex.length >= 8 ? component(6) : 1
    return {
        red: component(0),
        green: component(2),
        blue: component(4),
        alpha: alpha * (config.barTransparency === undefined ? 1 : config.barTransparency)
    }
}

// The screen the user is on: the one holding the focused window, as the other Spoons do
// it. Not hs.screen.primary(), which is the display carrying the menu bar — what System
// Settings calls the Main Display.
function currentScreen() {
    const focused = hs.window.focusedWindow()
    if (focused && focused.screen) return focused.screen
    return hs.screen.main() || hs.screen.primary()
}

// The bar's frame, along the bottom edge of the screen in use, at its full width.
// Returns null when there are no displays at all -- mid-disconnect, or a shut lid with
// nothing attached.
//
// hs.screen measures y downwards from the top of the primary display and a canvas window
// upwards from its bottom, so the screen's bottom edge has to be converted. On the primary
// screen this comes out as 0, which is what the bar used when it only ever drew there.
function barFrame() {
    const screen = currentScreen()
    const reference = hs.screen.primary() || screen
    if (!screen || !reference) return null

    const area = screen.fullFrame
    const primary = reference.fullFrame

    return {
        screen: screen,
        frame: {
            x: area.x,
            y: (primary.y + primary.h) - (area.y + area.h),
            w: area.w,
            h: config.barHeight
        }
    }
}

// Builds the bar. Each segment is a canvas element, recoloured in place by index as the
// countdown passes it, so a tick touches only the segments just crossed.
function barBuild() {
    const placement = barFrame()
    if (!placement) return

    const width = placement.frame.w
    const count = Math.max(1, Math.floor(config.barSegments))
    const segmentWidth = width / count

    const canvas = hs.canvas.create(placement.frame)
        .level("status")
        // A five point strip along the bottom edge of the screen sits exactly where the
        // Dock does. Without this it would swallow every click along that edge.
        .ignoreMouseEvents(true)
        .behaviorList(["canJoinAllSpaces", "stationary"])

    const elements = []
    for (let i = 0; i < count; i++) {
        elements.push({
            type: "rectangle",
            action: "fill",
            fillColor: barColor(config.barColorToPass),
            frame: { x: i * segmentWidth, y: 0, w: segmentWidth, h: config.barHeight }
        })
    }
    canvas.appendElements(elements)

    barCanvas = canvas
    barSegments = count
    barScreen = placement.screen.id
    barFilled = 0
}

function barEnsure() {
    if (!barCanvas) barBuild()
}

// progress is 0.0 to 1.0.
function barSetProgress(progress) {
    barEnsure()
    if (!barCanvas) return

    const target = Math.max(0, Math.min(barSegments, Math.round(progress * barSegments)))
    if (target === barFilled) return

    const passed = barColor(config.barColorPassed)
    const toPass = barColor(config.barColorToPass)
    if (target > barFilled) {
        for (let i = barFilled; i < target; i++) barCanvas.setElementAttribute(i, "fillColor", passed)
    } else {
        for (let i = target; i < barFilled; i++) barCanvas.setElementAttribute(i, "fillColor", toPass)
    }
    barFilled = target
}

function barShow() {
    // The bar outlives a countdown, so the one built for the last one may be on the screen
    // that countdown was started from. A new countdown belongs on the screen in use now.
    barReposition()

    barEnsure()
    if (!barCanvas) return
    barSetProgress(0)
    barCanvas.show()
    barShowing = true
}

function barHide() {
    barShowing = false
    if (!barCanvas) return
    barSetProgress(0)
    barCanvas.hide()
}

/**
 * Put the bar where it belongs for the display arrangement as it now stands.
 *
 * A canvas can be moved and resized after it is built, so the bar follows the screen
 * rather than being thrown away and made again. Only a change of width needs the segments
 * rebuilt, since each one's frame is a fraction of it; a move alone is a `setFrame`.
 */
function barReposition() {
    if (!barCanvas) return

    const placement = barFrame()
    if (!placement) return

    const current = barCanvas.frame()
    if (placement.frame.w !== current.w) {
        // A different width means every segment is the wrong size. Rebuilt at the progress
        // it was showing, so a countdown in flight does not lose its place.
        const progress = barSegments ? barFilled / barSegments : 0
        const wasShowing = barShowing
        barCanvas.destroy()
        barCanvas = null
        barSegments = 0
        barFilled = 0
        barEnsure()
        if (!barCanvas) return
        barSetProgress(progress)
        if (wasShowing) barCanvas.show()
        return
    }

    barCanvas.setFrame(placement.frame)
    barScreen = placement.screen.id
}

// MARK: - Menu bar

function menuBarEnsure() {
    if (menuBar) return
    menuBar = hs.menubar.create(!config.menuBarAlwaysShow)
    menuBarReset()
}

function menuBarReset() {
    if (!menuBar) return
    currentIcon = config.menuBarIconIdle
    menuBar.title = config.menuBarIconIdle
    menuBar.setMenu([
        {
            title: `${config.menuBarIconActive} Start ${config.defaultLenMinutes} min`,
            fn: () => startFor(config.defaultLenMinutes)
        },
        {
            title: `${config.menuBarIconActive} Start for ...`,
            fn: () => startForInteractive()
        }
    ])
    if (config.menuBarAlwaysShow) {
        menuBar.show()
    } else {
        menuBar.hide()
    }
}

function menuBarUpdateTitle() {
    if (!menuBar) return
    const hours = Math.floor(timeLeft / 3600)
    const minutes = Math.floor((timeLeft % 3600) / 60)
    const seconds = Math.floor(timeLeft % 60)
    const pad = (n) => String(n).padStart(2, "0")
    menuBar.title = hours > 0
        ? `${currentIcon} ${hours}:${pad(minutes)}:${pad(seconds)}`
        : `${currentIcon} ${pad(minutes)}:${pad(seconds)}`
}

function menuBarUpdate(isPaused) {
    menuBarEnsure()
    if (!menuBar.isVisible()) menuBar.show()

    currentIcon = isPaused ? config.menuBarIconPause : config.menuBarIconActive
    const resumeLabel = isPaused
        ? `${config.menuBarIconPlay} Resume`
        : `${config.menuBarIconPause} Pause`

    menuBar.setMenu([
        {title: `${config.menuBarIconStop} Stop`, fn: () => cancel()},
        {title: resumeLabel, fn: () => pauseOrResume()}
    ])
    menuBarUpdateTitle()
}

// MARK: - Warnings and end of timer

function warningUpdate() {
    if (!config.warningShow || timeLeft <= 0) return
    if (timeLeft % 60 !== 0) return
    const minutesLeft = timeLeft / 60
    if (minutesLeft < timerLenMinutes && isPowerOfTwo(minutesLeft)) {
        const hours = Math.floor(minutesLeft / 60)
        const minutes = minutesLeft % 60
        const pad = (n) => String(n).padStart(2, "0")
        showMessage(`Time left ${pad(hours)}:${pad(minutes)}`, config.warningDuration)
    }
}

function endOfTimerNotify(requestedMinutes) {
    // Kept so focus can be restored once the dialog is acknowledged.
    const previousWindow = hs.window.focusedWindow()

    fireCallback(events.end, requestedMinutes)

    const message = requestedMinutes
        ? `Time is up: ${requestedMinutes} minutes`
        : "Time is up"
    const timeString = `Time is ${new Date().toLocaleTimeString()}`

    if (config.alertSound) {
        const sound = hs.sound.named(config.alertSound)
        if (sound) sound.play()
        hs.notify.create({title: message, body: timeString}).send()
    }

    if (config.alertLen > 0) {
        hs.ui.alert(message).duration(config.alertLen).show()
    }

    if (config.notify) {
        hs.ui.dialog(message)
            .informativeText(timeString)
            .buttons(["OK"])
            .onButton(() => {
                if (previousWindow) previousWindow.focus()
            })
            .show()
    }
}

// MARK: - Timer

function resetTimer() {
    timerRunning = false
    if (tickTimer) {
        tickTimer.stop()
        tickTimer = null
    }
    pausedAt = null
    timeLeft = 0
    barHide()
    menuBarReset()
}

function tick() {
    // The timer keeps ticking while paused is not possible — pause stops it — but a
    // tick can still arrive after the countdown ends, between expiry and stop().
    if (!timerRunning) return

    timeLeft = endingTime - nowSeconds()

    if (timeLeft <= 0) {
        timerRunning = false
        // Saved before the reset, which clears it, and needed by the notification.
        const requestedMinutes = timerLenMinutes
        resetTimer()
        endOfTimerNotify(requestedMinutes)
        return
    }

    barSetProgress(1 - timeLeft / (timerLenMinutes * 60))
    warningUpdate()
    menuBarUpdateTitle()
}

// MARK: - Public API

/**
 * Start a countdown for `minutes` minutes. Refuses to start while another
 * countdown is running.
 *
 * @param {number} [minutes] Length in whole minutes. Defaults to
 *        `config.defaultLenMinutes`.
 * @param {function} [callback] Called as `(event, minutes)` on each timer event.
 *        Not called for the end event if the timer is cancelled.
 */
function startFor(minutes, callback) {
    if (minutes === undefined || minutes === null) minutes = config.defaultLenMinutes

    if (timerRunning) {
        showMessage("Error. Timer is already running. It is not possible to start another one.")
        return module.exports
    }
    if (!Number.isInteger(minutes)) {
        showMessage(`Error. Minutes should be an integer [${minutes}]`)
        return module.exports
    }
    if (minutes < 0) {
        showMessage(`Error. Trying to start a timer for negative minutes [${minutes}]`)
        return module.exports
    }
    if (callback !== undefined && callback !== null && typeof callback !== "function") {
        showMessage("Error. Second parameter should be a function")
        return module.exports
    }

    timerLenMinutes = minutes
    userCallback = callback ?? null

    barShow()

    endingTime = nowSeconds() + minutes * 60
    timerRunning = true
    timeLeft = minutes * 60
    // The handle is kept: pauseOrResume() and resetTimer() need it, and a timer with no
    // remaining reference is garbage collected, which stops the countdown.
    tickTimer = hs.timer.doEvery(1, () => tick())

    menuBarUpdate(false)

    if (config.useLastTimerAsDefault) config.defaultLenMinutes = minutes
    showMessage(`Timer started for ${minutes} minutes`)

    fireCallback(events.start, 0)
    return module.exports
}

/**
 * Convert a time of day to minutes past midnight.
 *
 * @param {string} time `hh:mm` on a 24-hour clock, or `h:mm am` / `h:mm pm`. The
 *        suffix may be upper or lower case, and the space before it is optional.
 * @returns {{minutes: number}|{error: string}} One key or the other, never both.
 */
function parseTimeOfDay(time) {
    // Anchored, so trailing text is reported rather than ignored. An ignored suffix would
    // otherwise shift the end time by twelve hours with no error reported.
    const match = /^\s*(\d{1,2}):(\d{2})\s*([ap]m)?\s*$/i.exec(time)
    if (!match) {
        return { error: `Illegal time [${time}]. Must be <hour>:<min>, optionally followed by am or pm` }
    }

    let hour = Number(match[1])
    const minute = Number(match[2])
    const suffix = match[3] ? match[3].toLowerCase() : null

    if (minute > 59) {
        return { error: `Illegal time [${time}]. Minutes must be 00 to 59` }
    }
    if (suffix) {
        if (hour < 1 || hour > 12) {
            return { error: `Illegal time [${time}]. With ${suffix} the hour must be 1 to 12` }
        }
        // 12am is hour 0 and 12pm is hour 12, so reduce 12 to 0 before adding the shift.
        hour = hour % 12 + (suffix === "pm" ? 12 : 0)
    } else if (hour > 23) {
        return { error: `Illegal time [${time}]. Hours must be 00 to 23` }
    }

    return { minutes: hour * 60 + minute }
}

/**
 * Start a countdown that ends at a given time of day. A time earlier than the
 * current time is taken to mean tomorrow.
 *
 * @param {string} time A time of day, in the forms `parseTimeOfDay` accepts.
 * @param {function} [callback] Called as `(event, minutes)` on each timer event.
 */
function startUntil(time, callback) {
    const parsed = parseTimeOfDay(time)
    if (parsed.error) {
        showMessage(parsed.error)
        return module.exports
    }

    const now = new Date()
    const current = now.getHours() * 60 + now.getMinutes()
    // Positive remainder, so a target earlier than now lands tomorrow.
    const minutes = ((parsed.minutes - current) % (24 * 60) + 24 * 60) % (24 * 60)
    return startFor(minutes, callback)
}

/**
 * Start the countdown described by one answer to the prompt.
 *
 * @param {string} answer A number of minutes, or a time of day.
 * @param {function} [callback] Passed through to the timer.
 * @returns {?string} What was wrong with the answer, or null once the timer runs.
 */
function startFromAnswer(answer, callback) {
    if (answer.includes(":")) {
        const parsed = parseTimeOfDay(answer)
        if (parsed.error) return parsed.error
        startUntil(answer, callback)
        return null
    }

    // Number("") and Number(" ") are both 0, so an empty answer needs its own test.
    const minutes = Number(answer)
    if (answer.trim() === "" || !Number.isFinite(minutes)) {
        return `Illegal number [${answer}]`
    }
    if (minutes <= 0) {
        return `Illegal number [${answer}]. Must be more than zero`
    }

    startFor(Math.round(minutes), callback)
    return null
}

/**
 * Ask for a duration and start a countdown with it. The prompt accepts either a
 * number of minutes or a time of day (`10:30`, `9:30 pm`). An answer that is
 * neither is reported in the prompt, which is shown again with that answer left
 * in place to be corrected. Cancel abandons the countdown.
 *
 * The prompt is modal, so this returns once it has been answered or cancelled.
 *
 * @param {function} [callback] Called as `(event, minutes)` on each timer event.
 */
function startForInteractive(callback) {
    const previousWindow = hs.window.focusedWindow()
    const hint = "in minutes or specific time (e.g. 10:30 or 9:30 pm)"
    let informative = hint
    let defaultText = String(config.defaultLenMinutes)

    for (;;) {
        let answer = null
        // show() releases its callback, so each attempt needs a prompt of its own.
        hs.ui.textPrompt("Enter time")
            .informativeText(informative)
            .defaultText(defaultText)
            .buttons(["OK", "Cancel"])
            .onButton((buttonIndex, text) => {
                if (buttonIndex === 0) answer = text
            })
            .show()

        if (answer === null) break

        const error = startFromAnswer(answer, callback)
        if (!error) break

        // Report the error in the prompt itself, rather than in a message the prompt
        // would obscure, and present the rejected answer instead of the default.
        informative = `${error}\n\n${hint}`
        defaultText = answer
    }

    if (previousWindow) previousWindow.focus()
    return module.exports
}

/**
 * Pause a running countdown, or resume a paused one. Time spent paused does not
 * count against the countdown.
 */
function pauseOrResume() {
    if (!tickTimer) return module.exports

    if (tickTimer.running()) {
        pausedAt = nowSeconds()
        tickTimer.stop()
        menuBarUpdate(true)
        fireCallback(events.pause, timeLeft / 60)
        showMessage("Timer paused")
    } else {
        endingTime += nowSeconds() - pausedAt
        pausedAt = null
        tickTimer.start()
        menuBarUpdate(false)
        fireCallback(events.resume, timeLeft / 60)
        showMessage("Timer resumed")
    }
    return module.exports
}

/**
 * Cancel a running countdown. The end event is not fired; the cancel event is.
 */
function cancel() {
    if (!timerRunning) {
        showMessage("Error. Timer not running")
        return module.exports
    }
    const minutesLeft = timeLeft / 60
    fireCallback(events.cancel, minutesLeft)
    resetTimer()
    showMessage(`Timer was cancelled (time left ${minutesLeft.toFixed(1)} min).`)
    return module.exports
}

/**
 * Move a running countdown to a given point in its progress.
 *
 * @param {number} progress How far through the countdown to jump to, 0.0 to 1.0.
 */
function setProgress(progress) {
    if (!timerRunning) {
        showMessage("Error. Timer not running")
        return module.exports
    }
    const minutesLeft = timerLenMinutes * (1 - progress)
    endingTime = nowSeconds() + minutesLeft * 60
    showMessage(`Timer reset to ${(progress * 100).toFixed(1)}% (${minutesLeft.toFixed(1)} minutes left)`)
    fireCallback(events.setProgress, minutesLeft)
    return module.exports
}

/**
 * Bind hotkeys for the countdown's actions.
 *
 * @param {object} [mapping] Keyed by action name — `startFor`,
 *        `startInteractive`, `pauseOrResume`, `cancel` — each holding
 *        `[[modifiers], key]`. Defaults to `config.defaultKeyBindings`.
 */
function bindHotkeys(mapping) {
    const actions = {
        startFor: () => startFor(),
        startInteractive: () => startForInteractive(),
        pauseOrResume: () => pauseOrResume(),
        cancel: () => cancel()
    }
    const keymap = mapping ?? config.defaultKeyBindings

    for (const [name, spec] of Object.entries(keymap)) {
        if (!actions[name]) {
            console.error(`[hs_countdown-gt] unknown hotkey action: ${name}`)
            continue
        }
        hotkeys.push(hs.hotkey.bind(spec[0], spec[1], actions[name], null))
    }
    return module.exports
}

/** Create the menu bar item and the progress bar. */
function start() {
    menuBarEnsure()
    barEnsure()

    // Fires when a display is connected or disconnected, when a resolution or the
    // arrangement changes, and when the menu bar moves to another display — every way the
    // primary screen the bar was built for can stop being the one it is drawn on.
    if (!screenWatcher) {
        screenWatcher = () => barReposition()
        hs.screen.addWatcher(screenWatcher)
    }
    return module.exports
}

/** Cancel any running countdown and remove the menu bar item, bar and hotkeys. */
function stop() {
    if (timerRunning) resetTimer()
    if (screenWatcher) {
        hs.screen.removeWatcher(screenWatcher)
        screenWatcher = null
    }
    barShowing = false
    if (barCanvas) {
        barCanvas.destroy()
        barCanvas = null
        barSegments = 0
        barFilled = 0
    }
    if (menuBar) {
        menuBar.destroy()
        menuBar = null
    }
    for (const hotkey of hotkeys) {
        if (hotkey) hotkey.destroy()
    }
    hotkeys = []
    return module.exports
}

module.exports = {
    config,
    events,
    startFor,
    startUntil,
    startForInteractive,
    pauseOrResume,
    cancel,
    setProgress,
    bindHotkeys,
    start,
    stop,
    isRunning: () => timerRunning,
    timeLeft: () => timeLeft
}
