// hs_emacs-gt — Emacs from Hammerspoon 2.
//
// Three things, which were two Spoons in Hammerspoon 1 (hs_emacs_helper and, to come,
// editWithEmacs):
//
//   1. Running elisp through emacsclient, and bringing Emacs forward.
//   2. Forwarding a key to Emacs, so a chord that macOS or another application would
//      otherwise take reaches Emacs instead.
//   3. Showing what Emacs has to say, on screen and in the menu bar.
//
//     const emacs = hs.loadSpoon("hs_emacs-gt")
//     emacs.execute("(dmg-agenda)", { raise: true })
//     emacs.bindKey(["cmd", "ctrl"], "space")
//     emacs.message("saved")
//
// The elisp this Spoon runs is the caller's: nothing here names a function that is not
// part of Emacs itself.

// MARK: - User-configurable settings

const config = {
    emacsClient: "/opt/homebrew/bin/emacsclient",
    bundleID: "org.gnu.Emacs",

    // How long focus() waits for Emacs to come forward, and how often it looks.
    focusTimeout: 1,
    focusPollInterval: 0.05,

    // Report a failed emacsclient on screen as well as in the console.
    alertOnFailure: true,

    // Editing the focused text field in Emacs.
    editing: {
        // Where the focused window's identity is left for Emacs to read.
        infoFile: "/tmp/emacs-everywhere.txt",
        // Opens the editing buffer. Receives the text through the pasteboard.
        openEditor: "(emacs-everywhere)",
        // Put on the pasteboard before falling back to keystrokes, so that an
        // application which ignores them leaves something recognisable behind rather
        // than whatever was on the pasteboard before.
        captureFailureSentinel: "(application did not allow clipboard extraction)",
        // How long the application is given to answer the copy keystrokes.
        captureDelay: 0.2,
        // Between raising an application and focusing one of its windows, and between
        // that and typing into it.
        focusDelay: 0.4,
        // Post a notification naming the window being edited.
        notify: true
    },

    // The on-screen message. In Hammerspoon 1 this was an hs.canvas; Hammerspoon 2 has no
    // canvas, so it is an hs.ui window.
    message: {
        width: 500,
        height: 120,
        duration: 3,
        font: "Helvetica",
        textSize: 30,
        textColor: "#FFFFFF",
        background: "#000000DD",
        level: "floating"
    },

    // The menu bar indicator.
    menubar: {
        enabled: true,
        // Shown when there is nothing to report, and when there is.
        iconEmpty: "🦬",
        iconMessage: "🦄️"
    }
}

// MARK: - State

let menubarItem = null
let messageWindow = null
let messageTimer = null

// Keyed by "cmd+ctrl+space". Held, since a hotkey with no reference left stops firing.
const forwardedKeys = new Map()

// Timers are held for the same reason.
const pendingTimers = new Set()

function later(seconds, fn) {
    const timer = hs.timer.doAfter(seconds, () => {
        pendingTimers.delete(timer)
        fn()
    })
    pendingTimers.add(timer)
    return timer
}

// MARK: - Reaching Emacs

/** Whether Emacs is the frontmost application. */
function isFrontmost() {
    const app = hs.application.frontmost()
    return Boolean(app) && app.bundleID === config.bundleID
}

/** Whether Emacs is running at all. */
function isRunning() {
    return Boolean(hs.application.matchingBundleID(config.bundleID))
}

/**
 * Wait for Emacs to come forward.
 *
 * Polls rather than blocking. The Hammerspoon 1 version used a busy-wait, which stopped
 * everything else in Hammerspoon — timers included — for as long as it ran.
 *
 * @param {number} [seconds] How long to wait. Defaults to `config.focusTimeout`.
 * @returns {Promise} Resolves to whether Emacs became frontmost.
 */
function waitForFrontmost(seconds) {
    if (isFrontmost()) return Promise.resolve(true)

    const deadline = Date.now() + (seconds === undefined ? config.focusTimeout : seconds) * 1000

    return new Promise((resolve) => {
        let settled = false

        const finish = (result) => {
            if (settled) return
            settled = true
            poll.stop()
            pendingTimers.delete(poll)
            resolve(result)
        }

        const poll = hs.timer.doEvery(config.focusPollInterval, () => {
            if (isFrontmost()) finish(true)
            else if (Date.now() > deadline) finish(false)
        })
        pendingTimers.add(poll)
    })
}

/**
 * Bring Emacs forward.
 *
 * Not app.activate(): macOS does not let an application that is not frontmost activate
 * another one, and Hammerspoon never is at the moment a key is pressed. launchOrFocus goes
 * through NSWorkspace, which is not restricted.
 *
 * @returns {Promise} Resolves to whether Emacs is frontmost.
 */
function focus() {
    if (isFrontmost()) return Promise.resolve(true)

    hs.application.launchOrFocus(config.bundleID)
    return waitForFrontmost()
}

// MARK: - Running elisp

// The Emacs server socket, once it has had to be looked for. Emacs started from the
// Finder does not put its socket where emacsclient looks by default, so the socket is
// found from the running process and remembered until it stops working.
let socketPath = null

/**
 * Find the Emacs server socket belonging to the running Emacs.
 *
 * @returns {Promise} Resolves to the socket's path, or to null.
 */
function discoverSocket() {
    const app = hs.application.matchingBundleID(config.bundleID)
    if (!app) {
        console.error("[hs_emacs-gt] Emacs is not running, so it has no socket")
        return Promise.resolve(null)
    }

    const command = `/usr/sbin/lsof -p ${app.pid} 2>&1 | ` +
        `/usr/bin/grep -Eo '/[^[:space:]]*/emacs[0-9]+/[^[:space:]/]+' | /usr/bin/head -1`

    return hs.task.shell(command).then((result) => {
        const found = result && result.stdout ? String(result.stdout).trim() : ""
        if (!found) {
            console.error("[hs_emacs-gt] could not find the Emacs server socket")
            return null
        }
        socketPath = found
        return found
    }).catch(() => {
        console.error("[hs_emacs-gt] could not find the Emacs server socket")
        return null
    })
}

/**
 * Run emacsclient.
 *
 * When the socket cannot be found, it is looked for and the call retried once. Arguments
 * are passed as an argument list rather than through a shell, so elisp — which is full of
 * parentheses, quotes and backslashes — needs no quoting.
 *
 * @param {string[]} args Arguments for emacsclient.
 * @param {boolean} [retried] Set on the retry, so it happens only once.
 * @returns {Promise} Resolves to `{ok, stdout, stderr}`.
 */
function runClient(args, retried) {
    const argv = socketPath ? ["--socket-name=" + socketPath].concat(args) : args.slice()

    return hs.task.runAsync(config.emacsClient, argv).then((result) => ({
        ok: true,
        stdout: result && result.stdout ? String(result.stdout) : "",
        stderr: ""
    })).catch((failure) => {
        const stderr = failure && failure.stderr ? String(failure.stderr) : ""

        if (!retried && stderr.indexOf("can't find socket") !== -1) {
            socketPath = null
            return discoverSocket().then((path) => {
                if (path) return runClient(args, true)
                return { ok: false, stdout: "", stderr: stderr }
            })
        }
        return { ok: false, stdout: "", stderr: stderr }
    })
}

function reportFailure(stderr) {
    const detail = stderr ? String(stderr).trim() : "unknown"
    console.error(`[hs_emacs-gt] emacsclient failed: ${detail}`)
    if (config.alertOnFailure) message("emacsclient failed: " + detail)
}

/**
 * Run elisp in Emacs, without waiting for a result.
 *
 * @param {string} elisp The code to evaluate, as `(message "hello")`.
 * @param {object} [options] `{raise}` to bring Emacs forward first.
 * @returns {Promise} Resolves to whether emacsclient succeeded.
 */
function execute(elisp, options) {
    if (typeof elisp !== "string" || elisp === "") {
        console.error("[hs_emacs-gt] execute() needs elisp to run")
        return Promise.resolve(false)
    }

    // Raising is best effort: the code runs whether or not Emacs comes forward.
    if (options && options.raise) focus()

    return runClient(["-n", "-e", elisp]).then((result) => {
        if (!result.ok) reportFailure(result.stderr)
        return result.ok
    })
}

/**
 * Run elisp and return what it evaluated to.
 *
 * Unlike `execute`, this waits for Emacs to answer.
 *
 * @param {string} elisp The code to evaluate.
 * @returns {Promise} Resolves to the printed result, or to null on failure.
 */
function evaluate(elisp) {
    return runClient(["-e", elisp]).then((result) => {
        if (!result.ok) {
            reportFailure(result.stderr)
            return null
        }
        return result.stdout.trim()
    })
}

/** Run elisp with Emacs brought forward. */
function executeAndRaise(elisp) {
    return execute(elisp, { raise: true })
}

// MARK: - Forwarding keys to Emacs
//
// A chord bound here is sent on to Emacs rather than acted on: Emacs is brought forward
// and the same chord is typed into it. The binding is disabled while the key is sent, so
// it does not catch its own keystroke and recurse.

/**
 * Forward a chord to Emacs.
 *
 * @param {string[]} mods Modifiers, as `["cmd", "ctrl"]`.
 * @param {string} key The key, as "space".
 * @returns {string} An identifier for the binding, as "cmd+ctrl+space".
 */
function bindKey(mods, key) {
    const id = mods.concat([key]).join("+")

    if (forwardedKeys.has(id)) return id

    const send = () => {
        const hotkey = forwardedKeys.get(id)
        if (!hotkey) return

        // Disabled first, so typing the chord does not trigger this again.
        hotkey.disable()
        const restore = () => hotkey.enable()

        if (!isRunning()) {
            message("Emacs is not running")
            hs.eventtap.keyStroke(mods, key)
            restore()
            return
        }

        focus().then((frontmost) => {
            if (frontmost) hs.eventtap.keyStroke(mods, key)
            else message("Emacs could not be brought forward")
            restore()
        }).catch(() => restore())
    }

    const hotkey = hs.hotkey.bind(mods, key, send, null)
    if (!hotkey) {
        console.error(`[hs_emacs-gt] could not bind ${id}`)
        return id
    }

    forwardedKeys.set(id, hotkey)
    return id
}

/**
 * Enable or disable one forwarded key.
 *
 * @param {string} id The identifier `bindKey` returned.
 * @param {boolean} [enable] Omit to toggle.
 * @returns {boolean} Whether it is now enabled.
 */
function toggleKey(id, enable) {
    const hotkey = forwardedKeys.get(id)
    if (!hotkey) {
        message("No forwarded key: " + id)
        return false
    }

    const wanted = enable === undefined ? !hotkey.isEnabled() : Boolean(enable)
    if (wanted) hotkey.enable()
    else hotkey.disable()

    message(id + (wanted ? " goes to Emacs" : " does not go to Emacs"))
    return wanted
}

/** Enable or disable every forwarded key. */
function toggleAllKeys(enable) {
    const wanted = enable === undefined
        ? !Array.from(forwardedKeys.values()).some((h) => h.isEnabled())
        : Boolean(enable)

    for (const hotkey of forwardedKeys.values()) {
        if (wanted) hotkey.enable()
        else hotkey.disable()
    }

    message(wanted ? "Keys go to Emacs" : "Keys do not go to Emacs")
    return wanted
}

/** Every forwarded key, as `{id, enabled}`. */
function keys() {
    return Array.from(forwardedKeys.entries()).map(([id, hotkey]) => ({
        id: id,
        enabled: hotkey.isEnabled()
    }))
}

/** Release every forwarded key. */
function unbindAll() {
    for (const hotkey of forwardedKeys.values()) hotkey.destroy()
    forwardedKeys.clear()
    return module.exports
}

// MARK: - Editing a text field in Emacs
//
// Take the text of whatever field is focused, hand it to Emacs to edit, and paste the
// result back when Emacs is done. Emacs closes the loop by calling endEditing() through
// the Hammerspoon command line; see hammerspoon.el.

/** The window with this identifier, or null. hs.window has no lookup by id. */
function windowById(id) {
    const wanted = Number(id)
    return hs.window.allWindows().filter((w) => w.id === wanted)[0] || null
}

/**
 * A window's geometry and identity, for Emacs to read.
 *
 * @param {number} id The window's identifier.
 * @returns {string} `x||y||w||h||application||title`.
 */
function windowInfo(id) {
    const window = windowById(id)
    if (!window) return "0||0||0||0||unknown||unknown"

    const frame = window.frame
    const application = window.application ? window.application.title : "unknown"
    return [
        Math.floor(frame.x), Math.floor(frame.y),
        Math.floor(frame.w), Math.floor(frame.h),
        application, window.title
    ].join("||")
}

/**
 * The text of the focused element, through accessibility.
 *
 * @param {boolean} everything True for the whole field, false for the selection.
 * @returns {string} The text, or null when the element does not expose it.
 */
function readFocusedText(everything) {
    let element
    try {
        element = hs.ax.focusedElement()
    } catch (e) {
        return null
    }
    if (!element) return null

    let text
    try {
        text = element.attributeValue(everything ? "AXValue" : "AXSelectedText")
    } catch (e) {
        return null
    }

    // An empty string counts as a miss. A terminal such as kitty exposes an AXTextArea
    // whose AXValue is always empty, because its content is drawn rather than held in a
    // text element; falling through to the keystrokes gives an honest answer there. The
    // cost is that editing a genuinely empty field also takes the slow path.
    if (typeof text !== "string" || text === "") return null
    return text
}

/**
 * Put the text to be edited on the pasteboard.
 *
 * Accessibility first; failing that, the sentinel is placed on the pasteboard and the
 * copy keystrokes are sent. If the pasteboard has not changed afterwards, the application
 * ignored them and the sentinel is what Emacs will show — which is the point of it.
 *
 * @param {boolean} everything True for the whole field, false for the selection.
 * @returns {Promise} Resolves when the pasteboard is ready.
 */
function prepareClipboard(everything) {
    const text = readFocusedText(everything)
    if (text !== null) {
        hs.pasteboard.writeString(text)
        return Promise.resolve(true)
    }

    hs.pasteboard.writeString(config.editing.captureFailureSentinel)
    const before = hs.pasteboard.changeCount

    if (everything) {
        hs.eventtap.keyStroke(["cmd"], "a")
        hs.eventtap.keyStroke(["cmd"], "c")
    } else {
        hs.eventtap.keyStroke(["cmd"], "x")
    }

    return new Promise((resolve) => {
        later(config.editing.captureDelay, () => {
            if (hs.pasteboard.changeCount === before) {
                const chord = everything ? "cmd-a and cmd-c" : "cmd-x"
                message(`Could not read the text: this application ignores ${chord}`)
                resolve(false)
                return
            }
            resolve(true)
        })
    })
}

/**
 * Edit the focused text field in Emacs.
 *
 * @param {boolean} [everything] True for the whole field, false for the selection.
 * @returns {Promise} Resolves to whether editing began.
 */
function beginEditing(everything) {
    const window = hs.window.focusedWindow()
    if (!window) {
        message("Nothing is focused")
        return Promise.resolve(false)
    }
    if (window.application && window.application.bundleID === config.bundleID) {
        message("Already in Emacs")
        return Promise.resolve(false)
    }
    if (!isRunning()) {
        message("Emacs is not running")
        return Promise.resolve(false)
    }

    const application = window.application ? window.application.title : "unknown"
    const title = window.title || ""

    // Written to a file rather than answered over IPC: Emacs reads it while Hammerspoon
    // is still busy handing over, and a file needs no round trip.
    const info = [window.id, windowInfo(window.id)].join("||")
    if (!hs.fs.write(config.editing.infoFile, info)) {
        console.error(`[hs_emacs-gt] could not write ${config.editing.infoFile}`)
    }

    return prepareClipboard(everything).then(() => {
        if (config.editing.notify) {
            hs.notify.create({
                title: application,
                subTitle: "Editing in Emacs",
                informativeText: "«" + title + "»"
            }).send()
        }
        execute(config.editing.openEditor)
        focus()
        return true
    })
}

/**
 * Paste what Emacs sends back into the window editing began in.
 *
 * Called by Emacs through the Hammerspoon command line once the editing buffer is
 * finished. The text arrives on the pasteboard, put there by Emacs.
 *
 * @param {number} id The window identifier `beginEditing` recorded.
 * @param {boolean} [everything] True when the whole field is being replaced.
 * @returns {Promise} Resolves to whether the text was pasted.
 */
function endEditing(id, everything) {
    const window = windowById(id)
    if (!window) {
        message("The window being edited has gone")
        return Promise.resolve(false)
    }

    // Raising the application and focusing the window are separate steps: macOS does not
    // let an application that is not frontmost activate another one, so window.focus()
    // alone reports success while the application stays behind. launchOrFocus raises it;
    // focus() then picks the right window within it.
    const application = window.application
    if (application && application.bundleID) hs.application.launchOrFocus(application.bundleID)

    return new Promise((resolve) => {
        later(config.editing.focusDelay, () => {
            window.focus()
            later(config.editing.focusDelay, () => {
                if (everything) hs.eventtap.keyStroke(["cmd"], "a")
                hs.eventtap.keyStroke(["cmd"], "v")
                resolve(true)
            })
        })
    })
}

/** Edit the selection in the focused field. */
function editSelection() {
    return beginEditing(false)
}

/** Edit the whole content of the focused field. */
function editAll() {
    return beginEditing(true)
}

// MARK: - Saying something
//
// hs.ui windows take their frame when they are created, so the window is rebuilt at each
// message rather than reused, which is also what lets it follow the primary screen.

/** Hide the on-screen message, if one is displayed. */
function messageHide() {
    if (messageTimer) {
        messageTimer.stop()
        messageTimer = null
    }
    if (messageWindow) {
        messageWindow.destroy()
        messageWindow = null
    }
    return module.exports
}

/**
 * Show a message on screen for a few seconds.
 *
 * @param {string} text What to show.
 * @param {number} [duration] Seconds. Defaults to `config.message.duration`.
 */
function message(text, duration) {
    messageHide()

    const settings = config.message
    const primary = hs.screen.primary().fullFrame

    // Upper left, as the Hammerspoon 1 canvas was. hs.screen measures y downwards from the
    // top of the primary display and hs.ui upwards from its bottom, hence the conversion.
    const left = primary.x + (primary.w - settings.width) / 8
    const top = primary.y + (primary.h - settings.height) / 4

    messageWindow = hs.ui.window({
        x: left,
        y: (primary.y + primary.h) - (top + settings.height),
        w: settings.width,
        h: settings.height
    })
        .titled(false)
        .level(settings.level)
        .backgroundColor(settings.background)
        .text(String(text))
            .font(HSFont.customSize(settings.font, settings.textSize))
            .foregroundColor(settings.textColor)

    messageWindow.show()

    messageTimer = hs.timer.doAfter(
        duration === undefined ? settings.duration : duration,
        () => {
            messageTimer = null
            messageHide()
        }
    )
    return module.exports
}

/** Show a message in the menu bar until it is cleared. */
function setStatus(text) {
    if (!menubarItem) return module.exports
    menubarItem.title = config.menubar.iconMessage + " " + text
    return module.exports
}

/** Return the menu bar to its resting state. */
function clearStatus() {
    if (!menubarItem) return module.exports
    menubarItem.title = config.menubar.iconEmpty
    return module.exports
}

// MARK: - Lifecycle

function start() {
    if (config.menubar.enabled && !menubarItem) {
        menubarItem = hs.menubar.create(false)
        clearStatus()
    }
    return module.exports
}

function stop() {
    unbindAll()
    messageHide()

    for (const timer of pendingTimers) timer.stop()
    pendingTimers.clear()

    if (menubarItem) {
        menubarItem.destroy()
        menubarItem = null
    }
    return module.exports
}

module.exports = {
    config,
    // Reaching Emacs.
    isRunning,
    isFrontmost,
    focus,
    waitForFrontmost,
    // Running elisp.
    execute,
    executeAndRaise,
    evaluate,
    discoverSocket,
    // Editing a text field in Emacs.
    beginEditing,
    endEditing,
    editSelection,
    editAll,
    readFocusedText,
    prepareClipboard,
    windowById,
    windowInfo,
    // Forwarding keys.
    bindKey,
    toggleKey,
    toggleAllKeys,
    keys,
    unbindAll,
    // Saying something.
    message,
    messageHide,
    setStatus,
    clearStatus,
    start,
    stop
}
