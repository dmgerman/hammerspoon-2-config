// hs_whisper-gt — a port of the Hammerspoon 1 hs_whisperDictation.spoon (which declares
// itself as WhisperDictation) to Hammerspoon 2.
//
// Press a key, speak, press it again, and the transcription is on the clipboard — or typed
// straight into whatever had focus. Everything runs on this machine: the audio never leaves
// it, and only a filter can send the text anywhere.
//
// Two recorders and three transcribers, each chosen by name in `config`:
//
//   sox        records one file for the whole session. Simple and reliable.
//   streaming  a Python server with voice-activity detection, which cuts the audio into
//              chunks at pauses and hands each one over while you are still talking.
//
//   whisperkit    whisperkit-cli, on the Apple Neural Engine
//   whispercli    whisper.cpp's whisper-cli, on CPU or GPU
//   whisperserver a local whisper.cpp HTTP server, with the model already in memory
//
// A recorder or transcriber that does not validate falls back once to a simpler one rather
// than leaving the Spoon dead, and says so.
//
// Two things here are not translations of the Lua:
//
// The streaming recorder talks to its Python server over the server's own stdin and stdout
// rather than over TCP, because Hammerspoon 2 has no socket module. See
// ai/issue_unfiled_socket-tcp-client.md. The protocol is the same newline-delimited JSON
// either way, and a pipe is the better of the two: no port to find free, nothing left
// listening, and the server exits with Hammerspoon.
//
// Transcription is genuinely asynchronous. The Lua version deferred a blocking `io.popen`
// read by 10 ms and called that async, so Hammerspoon froze for the length of every
// transcription. Here a transcriber returns a promise and the state machine awaits it.
//
// Commands run through dmg-libs/shell.js rather than hs.task.shell(), which loses its task
// to garbage collection; see that file and ai/issue_267_task-gc.md.

const shell = require(hs.appinfo.configDir + "/dmg-libs/shell.js")
const timers = require(hs.appinfo.configDir + "/dmg-libs/timer.js")

// MARK: - User-configurable settings

const config = {
    // Languages offered by the chooser. The first is selected at startup.
    languages: ["en"],

    // Which backends to use. A name not in `recorders` or `transcribers` is an error.
    recorder: "sox",            // "sox" | "streaming"
    transcriber: "whispercli",  // "whispercli" | "whisperkit" | "whisperserver"

    // Where recordings are written.
    tempDir: "/tmp/whisper_dict",
    // How many recordings to keep there, oldest deleted first, checked at start() and by
    // recordingsPrune(). 0 keeps every recording ever made, as version 1 did.
    recordingsKeep: 50,

    // Stop recording after this many seconds, so a key pressed by accident does not record
    // all afternoon. 0 or null for no limit.
    timeoutSeconds: 1800,

    // Show the sound-wave image in the middle of the screen while recording.
    indicatorShow: true,

    // Seconds to show each chunk's text as it comes back, while the rest of the dictation
    // is still being recorded. This is the point of chunking: with the streaming recorder
    // and a transcriber that keeps the model loaded, a sentence is transcribed while you
    // are still saying the next one, and this is where you see it. 0 shows nothing.
    // Only used when a dictation produces more than one chunk.
    chunkAlertSeconds: 3,

    // Auto-paste, used by transcribeToggle(true). With monitorUserActivity the paste is
    // abandoned if you typed, clicked or changed application while recording — on the
    // assumption that you have moved on and no longer want text arriving under the cursor.
    // It needs an event tap, so it needs Accessibility permission.
    monitorUserActivity: false,
    // Keystrokes during a recording that count as having moved on. Clicking or changing
    // application always counts.
    activityKeyLimit: 2,
    autoPasteDelay: 0.1,
    // Paste into Emacs with ctrl-y rather than cmd-v.
    pasteWithEmacsYank: false,

    // Post-transcription filters, offered by filterSelect(). Each entry is
    // {name, abbrev, cmd} or {name, abbrev, fn}:
    //   cmd     a shell command reading the text on stdin and writing the result to stdout
    //   fn      a function taking the text and returning the replacement
    //   abbrev  shown in the menu bar while the filter is active; optional
    // `fn` wins if an entry has both. A filter that fails leaves the text untouched.
    filters: [],

    // Transcriber to use for transcribeAgain(), or null for the current one.
    retranscribeTranscriber: null,
    // Recordings offered by transcribeAgain()'s chooser.
    retranscribeCount: 10,

    // sox
    soxCmd: "/opt/homebrew/bin/sox",
    soxAudioInputDevice: null,   // null for the system default

    // streaming. No port: the server speaks over its own stdin and stdout.
    streamingPythonPath: "/usr/bin/python3",
    streamingAudioInputDevice: null,
    streamingSilenceThreshold: 2.0,   // seconds of silence that ends a chunk
    streamingMinChunkDuration: 3.0,
    streamingMaxChunkDuration: 600.0,

    // whisperkit
    whisperkitCmd: "/opt/homebrew/bin/whisperkit-cli",
    whisperkitModel: "large-v3",

    // whispercli
    whispercliCmd: "/opt/homebrew/bin/whisper-cli",
    whispercliModelPath: "/usr/local/whisper/ggml-large-v3.bin",

    // whisperserver. Set whisperserverCmd and whisperserverModelPath to have the Spoon
    // start a server when one is not already answering.
    whisperserverHost: "127.0.0.1",
    whisperserverPort: 8080,
    whisperserverCurlCmd: "/usr/bin/curl",
    whisperserverCmd: null,
    whisperserverModelPath: null,
    whisperserverStartupTimeout: 10,

    defaultKeyBindings: {
        transcribeToggle: [["cmd", "ctrl"], "return"],
        transcribeToClipboardToggle: [["cmd", "ctrl", "alt"], "return"],
        languageSelect: [["cmd", "ctrl", "alt"], ";"]
    }
}

// MARK: - Constants

const icons = {
    idle: "🎤",
    recording: "🎙️",
    transcribing: "⏳",
    language: "🌐"
}

// Icons by notification category, and by severity where the severity matters more.
const CATEGORY_ICONS = {init: "✓", config: "⚙️", recording: "🎙️", transcription: "📝"}
const SEVERITY_ICONS = {warning: "⚠️", error: "❌"}
// Seconds each severity stays on screen. debug is logged and never shown.
const SEVERITY_DURATIONS = {debug: 0, info: 3, warning: 5, error: 10}

// Peak amplitude, 0 to 1, below which the first chunk of a session counts as silence and
// the session is abandoned rather than transcribed. A working microphone in a quiet room
// floors around 0.005; one that is muted, off, or denied permission delivers about 0. Only
// the first chunk is judged — silence between later phrases is ordinary.
const SILENCE_PEAK_FLOOR = 0.001

const STATES = {
    idle: "IDLE",
    recording: "RECORDING",
    transcribing: "TRANSCRIBING",
    error: "ERROR"
}

// Transitions that are allowed. Anything else is a bug, and is reported as one.
const TRANSITIONS = {
    IDLE: {RECORDING: true, ERROR: true},
    RECORDING: {TRANSCRIBING: true, IDLE: true, ERROR: true},
    TRANSCRIBING: {IDLE: true, ERROR: true},
    ERROR: {IDLE: true}
}

// Where this Spoon's own files are. __dirname is injected by require(); see
// Hammerspoon 2's Engine/require.js.
const spoonDir = __dirname

const EMACS_BUNDLE_ID = "org.gnu.Emacs"

// MARK: - State

let state = STATES.idle
// The session in flight: see sessionNew(). null when idle.
let session = null
// Incremented per session, and carried by every recorder callback, so that a chunk or a
// completion arriving from a session that was aborted is recognised and dropped. The Lua
// version tested `state == IDLE` instead, which cannot tell a late callback from the
// previous session apart from an early one from the next.
let generation = 0

let recorder = null
let transcriber = null
// Set while start() is resolving backends, so a key pressed in that window is answered
// rather than silently doing nothing.
let starting = false

let langIndex = 0
// Index into config.filters, or null for no filter.
let activeFilter = null

let menuBar = null
let hotkeys = []
let elapsedTimer = null
let timeoutTimer = null
let startTime = null
let indicatorCanvas = null

let activityTap = null
let activityAppListener = null
let activityCounts = {keys: 0, clicks: 0, appSwitches: 0}
let startingApp = null
let shouldPaste = false
let userCallback = null

// Choosers are held at module level because a chooser is lost to garbage collection like
// everything else with no reference: shown from a local variable, it can be collected
// between being shown and being chosen from. Same reason as dmg-libs/timer.js.
let languageChooser = null
let filterChooser = null
let recordingChooser = null

let debugEnabled = false

let audioListener = null
// A device change during a recording is deferred to the end of it, because restarting the
// server mid-session would discard the audio.
let audioRestartPending = false
let audioRestartTimer = null

// MARK: - Logging and notification

function logDebug(message) {
    if (debugEnabled) console.log(`[hs_whisper-gt] ${message}`)
}

/**
 * Report something to the user and the console.
 *
 * The only place in this Spoon that calls hs.ui.alert, so that every message is shaped the
 * same way and `debug` really is quiet. The Lua version declared this boundary and then
 * broke it in seven places.
 *
 * @param {string} category One of init, config, recording, transcription. Picks the icon.
 * @param {string} severity One of debug, info, warning, error. Picks the icon and how long
 *        the message stays up; `debug` is logged only, and only when debugging is on.
 * @param {string} message
 * @param {number} [seconds] How long to show it, overriding the severity's own duration.
 *        0 logs without showing anything.
 */
function notify(category, severity, message, seconds) {
    const line = `[hs_whisper-gt ${category}] ${message}`

    if (severity === "debug") {
        logDebug(`${category}: ${message}`)
        return
    }
    if (severity === "error") console.error(line)
    else if (severity === "warning") console.warn(line)
    else console.log(line)

    const duration = seconds ?? SEVERITY_DURATIONS[severity] ?? 3
    if (duration > 0) {
        const icon = SEVERITY_ICONS[severity] || CATEGORY_ICONS[category] || ""
        hs.ui.alert(`${icon} ${message}`).duration(duration).show()
    }
}

// MARK: - Helpers

function dirEnsure(path) {
    if (!hs.fs.exists(path) && !hs.fs.mkdir(path)) {
        notify("config", "error", `Could not create directory ${path}`)
        return false
    }
    return true
}

/**
 * Resolve a command to a path, or null if there is no such command.
 *
 * A configured command may be a full path or a bare name to be found on PATH, and the
 * defaults here are full paths while someone overriding them is likely to write a name.
 */
async function executableResolve(command) {
    if (!command) return null
    if (command.startsWith("/")) return hs.fs.exists(command) ? command : null

    // A login shell, so that PATH is the one the user would see.
    const found = await shell.commandRun("/bin/zsh", ["-l", "-c", `command -v ${command}`])
    const path = (found.out || "").trim()
    return found.code === 0 && path ? path : null
}

// Timers this Spoon may stop before they fire, held so that a garbage collection cannot
// take one while it is waiting — the same hazard dmg-libs/timer.js exists for. They are not
// put through that module because it forgets a timer only when it fires, so one stopped
// early stays in its count for good; `diagnose()` reports pending timers as a way of
// noticing a leak, and a count that only ever rises would say nothing.
const heldTimers = new Set()

function timerAfter(seconds, fn) {
    const timer = hs.timer.doAfter(seconds, () => {
        heldTimers.delete(timer)
        fn()
    })
    if (timer) heldTimers.add(timer)
    return timer
}

function timerStop(timer) {
    if (!timer) return
    timer.stop()
    heldTimers.delete(timer)
}

/**
 * Reject if `promise` has not settled within `seconds`, so no await can hang for ever.
 *
 * The timer is stopped once the race is over rather than left to fire into nothing.
 */
function promiseTimeout(promise, seconds, what) {
    let timer = null
    const limit = new Promise((resolve, reject) => {
        timer = timerAfter(seconds, () => {
            reject(new Error(`${what} timed out after ${seconds}s`))
        })
    })
    return Promise.race([promise, limit]).finally(() => timerStop(timer))
}

function firstLine(text) {
    if (!text) return ""
    const line = String(text).trim().split("\n")[0]
    return line.length > 200 ? line.slice(0, 200) + "…" : line
}

function filterActive() {
    if (activeFilter === null) return null
    return config.filters[activeFilter] || null
}

function filterAbbrev() {
    const filter = filterActive()
    return filter && filter.abbrev ? filter.abbrev : null
}

/** A filename stem naming the language and the moment, unique per session. */
function sessionPrefix(lang) {
    const now = new Date()
    const pad = (n) => String(n).padStart(2, "0")
    const stamp = `${now.getFullYear()}${pad(now.getMonth() + 1)}${pad(now.getDate())}` +
        `-${pad(now.getHours())}${pad(now.getMinutes())}${pad(now.getSeconds())}`
    return `${lang}-${stamp}`
}

// MARK: - Menu bar

function menuBarEnsure() {
    if (menuBar) return
    menuBar = hs.menubar.create()
    menuBar.setClickCallback(() => transcribeToggle())
}

function menuBarSet(title, tooltip) {
    if (!menuBar) return
    menuBar.title = title
    menuBar.setTooltip(tooltip)
}

function menuBarIdle() {
    const abbrev = filterAbbrev()
    const filter = filterActive()
    let title = `${icons.idle} (${languageGet()})`
    let tooltip = "Idle"
    if (abbrev) {
        title += ` [${abbrev}]`
        tooltip = `Filter: ${filter.name}`
    }
    menuBarSet(title, tooltip)
}

/**
 * How far through its chunks the session is, as "2/3", or "" when there is nothing worth
 * reporting.
 *
 * Empty for a single-chunk dictation, which is every dictation with the sox recorder: "1/1"
 * says nothing that the transcribing icon does not already say.
 */
function sessionProgress() {
    if (!session || session.chunks.length < 2) return ""
    const settled = session.results.size + session.failures.length
    return `${settled}/${session.chunks.length}`
}

function menuBarElapsed() {
    if (state !== STATES.recording) return
    const elapsed = startTime ? Math.floor(hs.timer.secondsSinceEpoch() - startTime) : 0
    const abbrev = filterAbbrev()
    const progress = sessionProgress()
    let title = `${icons.recording} ${elapsed}s (${languageGet()})`
    // Chunks are transcribed while the recording continues, so the count climbs during it.
    if (progress) title += ` ${progress}`
    if (abbrev) title += ` [${abbrev}]`
    menuBarSet(title, progress ? `Recording — ${progress} chunks transcribed` : "Recording…")
}

function menuBarTranscribing(lang) {
    const progress = sessionProgress()
    menuBarSet(`${icons.transcribing}${progress ? ` ${progress}` : ""} (${lang})`,
        progress ? `Transcribing — ${progress} chunks done` : "Transcribing…")
}

// MARK: - Recording indicator

function indicatorShow() {
    if (indicatorCanvas) return

    const focused = hs.window.focusedWindow()
    const screen = (focused && focused.screen) || hs.screen.main() || hs.screen.primary()
    const reference = hs.screen.primary() || screen
    if (!screen || !reference) return

    const image = HSImage.fromPath(`${spoonDir}/assets/sound_wave.png`)
    if (!image) {
        notify("config", "warning", "Recording indicator image is missing from the Spoon")
        return
    }

    const area = screen.frame
    const width = (image.size.w * (area.h / 5)) / image.size.h
    const height = area.h / 5

    // hs.screen measures y downwards from the top of the primary display and a canvas
    // measures it upwards from that display's bottom, so the screen's bottom edge has to be
    // worked out before anything can be centred above it.
    const primary = reference.fullFrame
    const bottom = (primary.y + primary.h) - (area.y + area.h)

    indicatorCanvas = hs.canvas.create({
        x: area.x + (area.w - width) / 2,
        y: bottom + (area.h - height) / 2,
        w: width,
        h: height
    })
        .level("status")
        // It sits over the middle of the screen while recording, so it must not swallow the
        // clicks of whatever is underneath it.
        .ignoreMouseEvents(true)
        .behaviorList(["canJoinAllSpaces", "stationary"])

    indicatorCanvas.appendElements([{
        type: "image",
        image: image,
        frame: {x: 0, y: 0, w: width, h: height},
        imageScaling: "scaleToFit"
    }])

    indicatorCanvas.show()
}

function indicatorHide() {
    if (!indicatorCanvas) return
    indicatorCanvas.hide()
    indicatorCanvas.destroy()
    indicatorCanvas = null
}

// MARK: - Activity monitoring

/**
 * Start counting what the user does, so auto-paste can decide whether they are still
 * waiting for the text.
 *
 * Modifier presses arrive as flagsChanged, which is not watched, so holding cmd does not
 * count as typing and there is no need to filter modifier key codes out — the Lua version
 * carried a table of them that nothing could ever match.
 */
function activityMonitorStart() {
    activityCounts = {keys: 0, clicks: 0, appSwitches: 0}

    const focused = hs.window.focusedWindow()
    startingApp = focused ? focused.application : null

    if (!hs.permissions.checkAccessibility()) {
        notify("config", "warning",
            "monitorUserActivity needs Accessibility permission; auto-paste will not be " +
            "guarded. Grant it in System Settings → Privacy & Security → Accessibility.")
        return
    }

    const types = hs.eventtap.eventTypes
    activityTap = hs.eventtap.addWatcher(
        [types.keyDown, types.leftMouseDown, types.rightMouseDown, types.otherMouseDown],
        (event) => {
            if (event.type === types.keyDown) activityCounts.keys += 1
            else activityCounts.clicks += 1
        },
        true)

    if (activityTap) activityTap.start()
    else notify("config", "warning", "Could not create the activity event tap")

    activityAppListener = (app) => {
        if (!startingApp || !app) return
        if (app.bundleID !== startingApp.bundleID) activityCounts.appSwitches += 1
    }
    hs.application.on("activated", activityAppListener)

    logDebug("activity monitoring started")
}

function activityMonitorStop() {
    if (activityTap) {
        activityTap.stop()
        // An event tap is not collected by itself; it has to be handed back.
        hs.eventtap.removeWatcher(activityTap)
        activityTap = null
    }
    if (activityAppListener) {
        hs.application.off("activated", activityAppListener)
        activityAppListener = null
    }
    logDebug("activity monitoring stopped")
}

function activitySummary() {
    const parts = []
    const plural = (n, one, many) => `${n} ${n === 1 ? one : many}`
    if (activityCounts.keys > 0) parts.push(plural(activityCounts.keys, "key", "keys"))
    if (activityCounts.clicks > 0) parts.push(plural(activityCounts.clicks, "click", "clicks"))
    if (activityCounts.appSwitches > 0) {
        parts.push(plural(activityCounts.appSwitches, "app switch", "app switches"))
    }
    return parts.length ? parts.join(", ") : "no activity"
}

function sameAppFocused() {
    if (!startingApp) return false
    const focused = hs.window.focusedWindow()
    const current = focused ? focused.application : null
    return !!current && current.bundleID === startingApp.bundleID
}

// MARK: - Recordings on disk

/** Recordings in tempDir, newest first. */
function recordingsList() {
    const names = hs.fs.list(config.tempDir)
    if (!names) return []

    const found = []
    for (const name of names) {
        if (!name.endsWith(".wav")) continue
        const path = `${config.tempDir}/${name}`
        const attributes = hs.fs.attributes(path)
        if (!attributes) continue
        found.push({
            path: path,
            name: name,
            modified: attributes.modificationDate,
            size: attributes.size
        })
    }
    found.sort((a, b) => b.modified - a.modified)
    return found
}

/**
 * Delete all but the newest `config.recordingsKeep` recordings.
 *
 * Nothing in version 1 ever removed one, so /tmp/whisper_dict grew for as long as the
 * configuration lived — every recording ever made, in whole.
 *
 * @returns {number} How many were deleted.
 */
function recordingsPrune() {
    const keep = config.recordingsKeep
    if (!keep || keep <= 0) return 0

    const found = recordingsList()
    if (found.length <= keep) return 0

    let deleted = 0
    for (const recording of found.slice(keep)) {
        if (hs.fs.deletePath(recording.path)) deleted += 1
    }
    if (deleted > 0) logDebug(`pruned ${deleted} recordings, keeping ${keep}`)
    return deleted
}

// MARK: - Filters

/**
 * Pass `text` through the active filter, or return it unchanged if there is none.
 *
 * A filter that fails — missing command, non-zero exit, empty output, a function that
 * throws or returns something that is not a string — is reported and the original text is
 * used. Losing the dictation because a grammar filter broke would be the worse failure.
 */
async function filterApply(text) {
    const filter = filterActive()
    if (!filter || (!filter.fn && !filter.cmd)) return text

    logDebug(`applying filter: ${filter.name}`)

    const failed = (reason) => {
        notify("transcription", "warning",
            `Filter '${filter.name}' failed (${reason}) — using unfiltered text`)
        return text
    }

    if (typeof filter.fn === "function") {
        let result
        try {
            result = filter.fn(text)
        } catch (e) {
            return failed(`threw: ${e.message}`)
        }
        if (typeof result !== "string") return failed(`returned ${typeof result}, not a string`)
        if (result.length === 0) return failed("returned an empty string")
        return result
    }

    // A login shell, so the filter sees the PATH the user would have at a prompt. That is
    // slow — a shell startup per filtered dictation — and deliberate: these commands are
    // usually scripts in the user's own bin directory.
    const result = await shell.commandRunInput("/bin/zsh", ["-l", "-c", filter.cmd], text)
    if (result.code !== 0) {
        return failed(`exit ${result.code}: ${firstLine(result.err || result.out)}`)
    }
    const filtered = (result.out || "").replace(/\n$/, "")
    if (!filtered) return failed("produced no output")
    return filtered
}

/** The active filter, or null when the transcription is passed through unchanged. */
function filterGet() {
    return filterActive()
}

/**
 * Choose a filter without the chooser.
 *
 * @param {string|number|null} which A filter's `name`, its index in `config.filters`, or
 *        null for no filter.
 * @returns {boolean} Whether it was recognised.
 */
function filterSet(which) {
    if (which === null || which === undefined) {
        activeFilter = null
        notify("config", "info", "Filter: none")
        menuBarIdle()
        return true
    }

    const found = typeof which === "number"
        ? which
        : config.filters.findIndex((filter) => filter.name === which)

    if (found < 0 || found >= config.filters.length) {
        notify("config", "warning", `Not a configured filter: ${which}`)
        return false
    }

    activeFilter = found
    notify("config", "info", `Filter: ${config.filters[found].name}`)
    menuBarIdle()
    return true
}

/** Offer the configured filters, and keep the chosen one until it is changed again. */
function filterSelect() {
    const choices = [{
        text: activeFilter === null ? "● No Filter" : "No Filter",
        subText: "Pass the transcription through unchanged",
        index: -1
    }]

    config.filters.forEach((filter, i) => {
        choices.push({
            text: (activeFilter === i ? "● " : "") + filter.name,
            subText: filter.cmd || (filter.fn ? "(function)" : "(does nothing)"),
            index: i
        })
    })

    filterChooser = hs.chooser.create()
    filterChooser.placeholder = "Transcription filter"
    filterChooser.setChoices(choices)
    filterChooser.onSelect = (choice) => {
        if (!choice) return
        activeFilter = choice.index === -1 ? null : choice.index
        const filter = filterActive()
        notify("config", "info", `Filter: ${filter ? filter.name : "none"}`)
        menuBarIdle()
    }
    filterChooser.show()
    return module.exports
}

// MARK: - Transcribers

/**
 * Each transcriber is {validate, transcribe, cleanup?, fallback?}.
 *
 * validate()                      resolves to null when usable, or to why it is not
 * transcribe(audioFile, lang)     resolves to the text, or throws
 * cleanup()                       release anything held, when the Spoon stops
 * fallback                        the name to try instead if validate fails
 *
 * The Lua version wrote this as 160 lines of one near-identical branch per backend, each
 * with its own hand-written fallback.
 */
const transcribers = {
    whisperkit: {
        fallback: "whispercli",

        validate: async () => {
            const found = await executableResolve(config.whisperkitCmd)
            return found ? null
                : `whisperkit-cli not found at ${config.whisperkitCmd}. ` +
                  "Install it with: brew install whisperkit-cli"
        },

        // whisperkit-cli writes the transcription to stdout and nothing else, so stdout is
        // the text. The Lua version appended 2>&1, which mixed any warning the tool emitted
        // into the transcription.
        transcribe: async (audioFile, lang) => {
            const result = await shell.commandRun(config.whisperkitCmd, [
                "transcribe",
                "--model", config.whisperkitModel,
                "--audio-path", audioFile,
                "--language", lang
            ])
            if (result.code !== 0) {
                throw new Error(`whisperkit-cli exited ${result.code}: ` +
                    firstLine(result.err || result.out))
            }
            return (result.out || "").trim()
        }
    },

    whispercli: {
        validate: async () => {
            const found = await executableResolve(config.whispercliCmd)
            if (!found) {
                return `whisper-cli not found at ${config.whispercliCmd}. ` +
                    "Install it with: brew install whisper-cpp"
            }
            if (!config.whispercliModelPath) return "whispercliModelPath is not set"
            if (!hs.fs.exists(config.whispercliModelPath)) {
                return `Model not found at ${config.whispercliModelPath}`
            }
            return null
        },

        // whisper-cli's stdout is timestamped segments; --output-txt writes the plain text
        // beside the audio, and that is what is wanted.
        transcribe: async (audioFile, lang) => {
            const textFile = `${audioFile}.txt`
            const result = await shell.commandRun(config.whispercliCmd, [
                "-np",
                "-m", config.whispercliModelPath,
                "-l", lang,
                "--output-txt", audioFile
            ])
            if (result.code !== 0) {
                throw new Error(`whisper-cli exited ${result.code}: ` +
                    firstLine(result.err || result.out))
            }

            const text = hs.fs.read(textFile)
            hs.fs.deletePath(textFile)
            if (text === null) throw new Error(`whisper-cli wrote no text to ${textFile}`)
            return text.trim()
        }
    },

    whisperserver: {
        fallback: "whispercli",
        // The server task, when this Spoon started it. Held so it can be stopped again, and
        // so it is not collected while running.
        task: null,

        validate: async () => {
            const curl = await executableResolve(config.whisperserverCurlCmd)
            if (!curl) return `curl not found at ${config.whisperserverCurlCmd}`

            if (await transcribers.whisperserver.isAnswering()) {
                logDebug("whisper server is already answering")
                return null
            }
            if (!config.whisperserverCmd) {
                return `No whisper server on ${config.whisperserverHost}:` +
                    `${config.whisperserverPort}, and whisperserverCmd is not set to start one`
            }
            return await transcribers.whisperserver.serverStart()
        },

        async isAnswering() {
            const url = `http://${config.whisperserverHost}:${config.whisperserverPort}/health`
            const result = await shell.commandRun(config.whisperserverCurlCmd,
                ["-s", "--connect-timeout", "2", "-o", "/dev/null", url])
            return result.code === 0
        },

        /** Start a server and wait for it to answer. Resolves to null, or to the error. */
        async serverStart() {
            if (!hs.fs.exists(config.whisperserverCmd)) {
                return `whisper server not found at ${config.whisperserverCmd}`
            }
            if (!config.whisperserverModelPath || !hs.fs.exists(config.whisperserverModelPath)) {
                return `whisper server model not found at ${config.whisperserverModelPath}`
            }

            notify("init", "info", "Starting the whisper server…")
            const self = transcribers.whisperserver
            self.task = shell.commandStart(config.whisperserverCmd, [
                "--host", config.whisperserverHost,
                "--port", String(config.whisperserverPort),
                "--model", config.whisperserverModelPath
            ], {
                onOutput: (kind, chunk) => logDebug(`whisper-server ${kind}: ${chunk.trim()}`),
                onExit: (code) => {
                    logDebug(`whisper-server exited ${code}`)
                    self.task = null
                }
            })
            if (!self.task) return "Could not start the whisper server"

            // Poll rather than sleep: the Lua version blocked the whole runtime here with
            // hs.timer.usleep for up to ten seconds while the model loaded.
            const deadline = hs.timer.secondsSinceEpoch() + config.whisperserverStartupTimeout
            while (hs.timer.secondsSinceEpoch() < deadline) {
                if (await self.isAnswering()) {
                    notify("init", "info", "The whisper server is ready")
                    return null
                }
                if (!self.task) return "The whisper server exited while starting"
                await new Promise((resolve) => timers.later(0.5, resolve))
            }

            if (self.task) self.task.terminate()
            self.task = null
            return `The whisper server did not answer within ` +
                `${config.whisperserverStartupTimeout}s`
        },

        // The audio goes as multipart/form-data, which hs.http cannot send: hs.http.post
        // takes a String body, so there is no way to attach a file or any binary content.
        // Hence curl. See ai/issue_unfiled_http-multipart-body.md.
        transcribe: async (audioFile, lang) => {
            const url = `http://${config.whisperserverHost}:${config.whisperserverPort}/inference`
            const result = await shell.commandRun(config.whisperserverCurlCmd, [
                "-s", "-S",
                "-X", "POST", url,
                "-F", `file=@${audioFile}`,
                "-F", "response_format=text",
                "-F", `language=${lang}`
            ])
            if (result.code !== 0) {
                throw new Error(`curl exited ${result.code}: ${firstLine(result.err)}`)
            }

            const body = result.out || ""
            if (!body) throw new Error("The whisper server returned nothing")
            if (/^\s*\{\s*"error"/.test(body)) {
                throw new Error(`The whisper server reported: ${firstLine(body)}`)
            }

            // The server indents its lines, so each is trimmed and the empties dropped.
            const text = body.split("\n").map((line) => line.trim())
                .filter((line) => line !== "").join("\n")
            return text
        },

        cleanup() {
            if (!this.task) return
            logDebug("stopping the whisper server this Spoon started")
            this.task.terminate()
            this.task = null
        }
    }
}

// MARK: - Recorders

/**
 * Peak amplitude of a WAV file, 0 to 1, or null if it cannot be measured.
 *
 * `sox file -n stat` reports the largest positive and the largest negative sample on
 * stderr; the peak is whichever is further from zero. This is what lets the dead-microphone
 * check below apply to the sox recorder: in the Lua version only the streaming recorder
 * reported a peak, so the check — and the recovery runbook written for it — never ran for
 * anyone recording with sox.
 */
async function audioPeak(audioFile) {
    const result = await shell.commandRun(config.soxCmd, [audioFile, "-n", "stat"])
    const report = `${result.err || ""}${result.out || ""}`

    const read = (label) => {
        const found = new RegExp(`${label} amplitude:\\s*(-?[0-9.]+)`).exec(report)
        return found ? Math.abs(parseFloat(found[1])) : null
    }
    const high = read("Maximum")
    const low = read("Minimum")
    if (high === null && low === null) return null
    return Math.max(high ?? 0, low ?? 0)
}

/**
 * Each recorder is {validate, start, stop, cleanup?, warmup?, fallback?}.
 *
 * validate()                 resolves to null when usable, or to why it is not
 * start(mine, onChunk)       begin recording; throws if it cannot
 * stop(mine, onChunk)        finish, delivering any last chunk; resolves when done
 * warmup()                   optional, called by start() to absorb startup cost
 * cleanup()                  release anything held, when the Spoon stops
 *
 * onChunk(audioFile, chunkNum, isFinal, peak) is called for each piece of audio ready to
 * transcribe. `peak` may be null when the recorder cannot measure it.
 */
const recorders = {
    sox: {
        task: null,
        audioFile: null,
        exited: null,

        validate: async () => {
            const found = await executableResolve(config.soxCmd)
            return found ? null
                : `sox not found at ${config.soxCmd}. Install it with: brew install sox`
        },

        async start(mine, onChunk) {
            const self = recorders.sox
            self.audioFile = `${config.tempDir}/${mine.prefix}.wav`

            const args = config.soxAudioInputDevice
                ? ["-q", "-t", "coreaudio", config.soxAudioInputDevice, self.audioFile]
                : ["-q", "-d", self.audioFile]

            let exitReached
            self.exited = new Promise((resolve) => { exitReached = resolve })

            self.task = shell.commandStart(config.soxCmd, args, {
                onOutput: (kind, chunk) => logDebug(`sox ${kind}: ${chunk.trim()}`),
                onExit: (code) => {
                    self.task = null
                    exitReached(code)
                }
            })
            if (!self.task) throw new Error("Could not start sox")
        },

        async stop(mine, onChunk) {
            const self = recorders.sox
            const audioFile = self.audioFile
            self.audioFile = null

            if (self.task) {
                self.task.terminate()
                // Wait for sox to actually exit, rather than guessing at how long it needs
                // to flush the file. The Lua version waited a flat 0.1 s and read the file
                // whether or not sox had finished writing it.
                try {
                    await promiseTimeout(self.exited, 5, "sox exit")
                } catch (e) {
                    logDebug(e.message)
                }
                self.task = null
            }

            if (!audioFile || !hs.fs.exists(audioFile)) {
                throw new Error("sox wrote no recording")
            }
            const peak = await audioPeak(audioFile)
            onChunk(audioFile, 1, true, peak)
        },

        cleanup() {
            if (this.task) {
                this.task.terminate()
                this.task = null
            }
        }
    },

    streaming: {
        fallback: "sox",
        task: null,
        // Output arrives in whatever sizes the pipe delivers, so a partial last line is
        // kept here until the rest of it turns up.
        pending: "",
        // Resolved by the server_ready event, so start() can wait for the server to be up.
        ready: null,
        readyReached: null,
        // Set while a session is stopping, resolved when the server says it has stopped.
        stopped: null,
        stoppedReached: null,
        // The session the current callbacks belong to, and where to send its chunks.
        mine: null,
        onChunk: null,
        sawFinalChunk: false,

        validate: async () => {
            const python = await executableResolve(config.streamingPythonPath)
            if (!python) return `Python not found at ${config.streamingPythonPath}`

            const script = `${spoonDir}/whisper_stream.py`
            if (!hs.fs.exists(script)) return `whisper_stream.py is missing from the Spoon`

            const checked = await shell.commandRun(python, [script, "--check-deps"])
            if (checked.code !== 0) {
                let missing = ""
                try {
                    missing = (JSON.parse(checked.out || "{}").missing || []).join(", ")
                } catch (e) { /* not JSON; the generic message below will do */ }
                return missing
                    ? `Missing Python packages: ${missing}`
                    : "whisper_stream.py reported missing Python dependencies " +
                      "(run it with --check-deps to see which)"
            }
            return null
        },

        /**
         * Start the Python server, if it is not already running.
         *
         * Pre-started by start(), so the first recording is not held up by loading the VAD
         * model. The filename prefix is sent with each start_recording rather than given
         * here, because this one server serves every later recording.
         */
        async warmup() {
            const self = recorders.streaming
            if (self.task && self.task.isRunning) return null

            // Without microphone permission the server does not fail: it blocks inside
            // PortAudio opening the input stream, emits nothing further, and cannot then
            // be stopped by asking or by SIGTERM because its main thread never returns to
            // Python. Starting it would buy a thirty-second wait and a process to kill,
            // so say what is wrong instead.
            if (!hs.permissions.checkMicrophone()) {
                return "Hammerspoon 2 has no microphone permission, so the streaming " +
                    "server would hang trying to open the input device. Grant it in " +
                    "System Settings → Privacy & Security → Microphone."
            }

            const python = await executableResolve(config.streamingPythonPath)
            if (!python) return `Python not found at ${config.streamingPythonPath}`

            if (!dirEnsure(config.tempDir)) return `Could not create ${config.tempDir}`

            const args = [
                `${spoonDir}/whisper_stream.py`,
                "--transport", "stdio",
                "--output-dir", config.tempDir,
                // Replaced per recording by the start_recording command.
                "--filename-prefix", "warmup",
                "--silence-threshold", String(config.streamingSilenceThreshold),
                "--min-chunk-duration", String(config.streamingMinChunkDuration),
                "--max-chunk-duration", String(config.streamingMaxChunkDuration),
                "--perfect-silence-duration", "0"
            ]
            if (config.streamingAudioInputDevice) {
                args.push("--audio-input", config.streamingAudioInputDevice)
            }
            if (debugEnabled) args.push("--verbose")

            self.pending = ""
            self.sawFinalChunk = false
            self.ready = new Promise((resolve) => { self.readyReached = resolve })

            self.task = shell.commandStart(python, args, {
                onOutput: (kind, chunk) => {
                    if (kind === "stdout") self.outputRead(chunk)
                    // The server's own diagnostics, including the --verbose audio levels.
                    else logDebug(`whisper_stream: ${chunk.trim()}`)
                },
                onExit: (code) => {
                    self.task = null
                    if (code !== 0) {
                        notify("recording", "error",
                            `The streaming server exited with code ${code}`)
                    } else {
                        logDebug("the streaming server exited")
                    }
                    // Nothing more is coming, so release anything waiting on it.
                    if (self.readyReached) self.readyReached()
                    if (self.stoppedReached) self.stoppedReached()
                }
            })
            if (!self.task) return "Could not start the streaming server"

            try {
                await promiseTimeout(self.ready, 30, "streaming server startup")
            } catch (e) {
                // Left running it would hold the input device, and the next attempt would
                // then block on the open exactly as this one did.
                await self.serverStop()
                return `${e.message}. The commonest cause is that it could not open the ` +
                    "microphone: either Hammerspoon 2 has no microphone permission, or " +
                    "another process still holds the input device."
            }
            if (!self.task) return "The streaming server exited while starting"

            logDebug("the streaming server is ready")
            return null
        },

        /** Split the server's stdout into whole lines and handle each as an event. */
        outputRead(chunk) {
            const self = recorders.streaming
            self.pending += chunk

            const lines = self.pending.split("\n")
            // Whatever follows the last newline is an incomplete line; keep it.
            self.pending = lines.pop()

            for (const line of lines) {
                const text = line.trim()
                if (!text) continue
                let event
                try {
                    event = JSON.parse(text)
                } catch (e) {
                    logDebug(`unparseable line from the streaming server: ${text}`)
                    continue
                }
                self.eventHandle(event)
            }
        },

        eventHandle(event) {
            const self = recorders.streaming

            switch (event.type) {
            case "server_ready":
                if (self.readyReached) self.readyReached()
                break

            case "recording_started":
                logDebug("the streaming server started recording")
                break

            case "chunk_ready": {
                const peak = typeof event.peak === "number" ? event.peak : null
                logDebug(`chunk ${event.chunk_num}: ${event.audio_file} ` +
                    `peak=${peak} final=${event.is_final}`)
                if (self.onChunk) {
                    self.onChunk(event.audio_file, event.chunk_num, event.is_final, peak)
                }
                if (event.is_final) self.sawFinalChunk = true
                break
            }

            case "recording_stopped":
                logDebug("the streaming server stopped recording")
                if (self.stoppedReached) self.stoppedReached()
                break

            case "silence_warning":
                notify("recording", "warning",
                    event.message || "The microphone appears to be off")
                break

            case "complete_file":
                logDebug(`complete recording saved: ${event.file_path}`)
                break

            case "error":
                notify("recording", "error",
                    `The streaming server reported: ${event.error}`)
                break

            default:
                logDebug(`unknown event from the streaming server: ${event.type}`)
            }
        },

        commandSend(command) {
            const self = recorders.streaming
            if (!self.task || !self.task.isRunning) return false
            self.task.sendInput(JSON.stringify(command) + "\n")
            return true
        },

        async start(mine, onChunk) {
            const self = recorders.streaming

            if (!self.task || !self.task.isRunning) {
                const failed = await self.warmup()
                if (failed) throw new Error(failed)
            }

            self.mine = mine
            self.onChunk = onChunk
            self.sawFinalChunk = false
            self.stopped = new Promise((resolve) => { self.stoppedReached = resolve })

            // The prefix goes with the command, so this recording's chunks are named after
            // it. Were the prefix the one the server was started with, every recording
            // would be named after the warmup and each session's chunks would overwrite the
            // last session's — both true of the Lua version.
            if (!self.commandSend({command: "start_recording", filename_prefix: mine.prefix})) {
                throw new Error("Could not reach the streaming server")
            }
        },

        async stop(mine, onChunk) {
            const self = recorders.streaming
            if (!self.commandSend({command: "stop_recording"})) {
                throw new Error("Could not reach the streaming server")
            }

            // The server answers with any last chunk and then recording_stopped. A session
            // that recorded nothing at all produces only the latter, which is why this
            // waits on that event rather than on a final chunk.
            try {
                await promiseTimeout(self.stopped, 15, "streaming server stop")
            } catch (e) {
                notify("recording", "warning", e.message)
            }
            self.stoppedReached = null
            self.onChunk = null
            self.mine = null
        },

        /**
         * Stop the server and do not return until the process has gone.
         *
         * Waiting matters for a restart: the input device cannot be opened twice, so a
         * new server started while the old one still holds it blocks inside PortAudio on
         * the open and never becomes ready. Measured on 2026-10-08: restarting without
         * waiting timed out after 30 s with the old server still running and no new one.
         *
         * Getting rid of it takes all three of asking, SIGTERM and SIGKILL. The shutdown
         * command is read by the command loop and SIGTERM is handled in Python, so both
         * need the main thread to come back to Python — which a server blocked on the
         * device open never does. Version 1 stopped after SIGTERM, which is why reloading
         * it left servers behind still holding the microphone.
         *
         * The process is watched and killed by pid rather than through the task, because
         * `hs.task` stops reporting a terminated task as running while its process is in
         * fact still there, and its termination callback does not arrive either, so
         * neither can answer "has it gone yet".
         */
        async serverStop() {
            const self = recorders.streaming
            const task = self.task
            self.task = null
            self.pending = ""
            self.onChunk = null
            self.mine = null
            self.readyReached = null
            self.stoppedReached = null

            if (!task) return
            const pid = task.pid

            // Asking first: it is the only path that closes the audio device tidily.
            try {
                task.sendInput(JSON.stringify({command: "shutdown"}) + "\n")
            } catch (e) {
                logDebug(`could not ask the streaming server to shut down: ${e.message}`)
            }
            try {
                task.terminate()
            } catch (e) {
                logDebug(`could not terminate the streaming server: ${e.message}`)
            }

            const alive = async () => {
                // kill -0 reports whether the process exists without signalling it.
                const checked = await shell.commandRun("/bin/kill", ["-0", String(pid)])
                return checked.code === 0
            }
            const pause = () => new Promise((resolve) => timers.later(0.25, resolve))

            // Up to two seconds to go of its own accord, then insist.
            for (let waited = 0; waited < 8; waited += 1) {
                if (!(await alive())) {
                    logDebug(`the streaming server (pid ${pid}) stopped when asked`)
                    return
                }
                await pause()
            }

            logDebug(`killing the streaming server (pid ${pid})`)
            await shell.commandRun("/bin/kill", ["-9", String(pid)])

            for (let waited = 0; waited < 8; waited += 1) {
                if (!(await alive())) return
                await pause()
            }
            notify("recording", "warning",
                `The streaming server (pid ${pid}) could not be stopped`)
        },

        cleanup() {
            // stop() is not async, and nothing it does should wait, so this is left to
            // finish on its own. serverRestart() awaits serverStop() directly, because
            // there it has to be finished before the next server starts.
            recorders.streaming.serverStop()
                .catch((e) => logDebug(`stopping the streaming server: ${e.message}`))
        }
    }
}

// MARK: - Choosing backends

/**
 * Resolve the backend named in the configuration, falling back once if it will not work.
 *
 * @param {object} registry `recorders` or `transcribers`.
 * @param {string} wanted The configured name.
 * @param {string} kind "recorder" or "transcriber", for the messages.
 * @returns {Promise<?object>} The backend, with `name` set, or null if none worked.
 */
async function backendResolve(registry, wanted, kind) {
    const backend = registry[wanted]
    if (!backend) {
        notify("init", "error", `Unknown ${kind}: ${wanted}. ` +
            `Known: ${Object.keys(registry).join(", ")}`)
        return null
    }

    const failed = await backend.validate()
    if (!failed) {
        backend.name = wanted
        logDebug(`${kind}: ${wanted}`)
        return backend
    }

    if (!backend.fallback) {
        notify("init", "error", `The ${wanted} ${kind} cannot be used: ${failed}`)
        return null
    }

    notify("init", "warning",
        `The ${wanted} ${kind} cannot be used: ${failed}. Trying ${backend.fallback} instead.`)

    const alternative = registry[backend.fallback]
    const alsoFailed = await alternative.validate()
    if (alsoFailed) {
        notify("init", "error",
            `No usable ${kind}: ${backend.fallback} cannot be used either: ${alsoFailed}`)
        return null
    }

    alternative.name = backend.fallback
    notify("init", "info", `Using the ${backend.fallback} ${kind}`)
    return alternative
}

// MARK: - Session state machine

/**
 * Move to `next`, reporting a move that the state machine does not allow.
 *
 * @returns {boolean} Whether the transition happened.
 */
function stateTransition(next, why) {
    const allowed = TRANSITIONS[state]
    if (!allowed || !allowed[next]) {
        notify("recording", "error",
            `Cannot go from ${state} to ${next} (${why}) — this is a bug in hs_whisper-gt`)
        return false
    }
    logDebug(`${state} → ${next} (${why})`)
    state = next
    return true
}

function sessionNew(lang) {
    generation += 1
    return {
        generation: generation,
        lang: lang,
        prefix: sessionPrefix(lang),
        // One promise per chunk, each settling when that chunk has been transcribed.
        chunks: [],
        // chunkNum → text, so chunks are assembled in order however they finish.
        results: new Map(),
        // {num, reason} for each chunk that could not be transcribed.
        failures: [],
        recorderDone: false,
        finalizing: false
    }
}

/** Whether `mine` is still the session in flight, or has been overtaken by an abort. */
function sessionCurrent(mine) {
    return !!mine && !!session && session.generation === mine.generation
}

function recordingSessionStart() {
    startTime = hs.timer.secondsSinceEpoch()

    if (elapsedTimer) elapsedTimer.stop()
    elapsedTimer = hs.timer.doEvery(1, () => menuBarElapsed())

    if (config.timeoutSeconds && config.timeoutSeconds > 0) {
        if (timeoutTimer) timeoutTimer.stop()
        timeoutTimer = hs.timer.doAfter(config.timeoutSeconds, () => {
            if (state !== STATES.recording) return
            notify("recording", "warning",
                `Recording stopped after the ${config.timeoutSeconds}s limit`)
            transcribeEnd()
        })
    }

    if (config.indicatorShow) indicatorShow()
    // Pointless when the text is going to a callback rather than being pasted.
    if (config.monitorUserActivity && !userCallback) activityMonitorStart()
}

function recordingSessionStop() {
    if (elapsedTimer) {
        elapsedTimer.stop()
        elapsedTimer = null
    }
    if (timeoutTimer) {
        timeoutTimer.stop()
        timeoutTimer = null
    }
    startTime = null
    indicatorHide()
    if (activityTap || activityAppListener) activityMonitorStop()
}

/**
 * Take one chunk of audio and start transcribing it.
 *
 * Called by the recorder. Chunks from a session that has been abandoned are dropped, which
 * is what `mine` is for.
 */
function chunkReceived(mine, audioFile, chunkNum, isFinal, peak) {
    if (!sessionCurrent(mine)) {
        logDebug(`dropping chunk ${chunkNum} from an abandoned session`)
        return
    }

    notify("transcription", "debug",
        `chunk ${chunkNum} (final=${isFinal}, peak=${peak}): ${audioFile}`)

    // If the very first chunk is silent then the microphone is not delivering audio, and
    // going on would mean transcribing nothing while the user keeps talking into a dead
    // microphone. Later chunks are not judged: a pause between phrases is ordinary.
    if (chunkNum === 1 && peak !== null && peak < SILENCE_PEAK_FLOOR) {
        notify("recording", "error", silentAudioExplain(peak))
        transcribeAbort()
        return
    }

    const work = transcriber.transcribe(audioFile, mine.lang)
        .then((text) => {
            if (!sessionCurrent(mine)) return
            if (text) mine.results.set(chunkNum, text)
            chunkSettled(mine, chunkNum, isFinal, text)
        })
        .catch((e) => {
            if (!sessionCurrent(mine)) return
            mine.failures.push({num: chunkNum, reason: e.message})
            notify("transcription", "debug", `chunk ${chunkNum} failed: ${e.message}`)
            chunkSettled(mine, chunkNum, isFinal, null)
        })

    mine.chunks.push(work)
}

/**
 * One chunk has come back. Show it, and bring the menu bar count up to date.
 *
 * The text is reported as each chunk arrives rather than only once the whole dictation is
 * assembled. That is what chunking is for: with the streaming recorder and a transcriber
 * holding the model in memory, a sentence is transcribed while the next one is still being
 * spoken, so the words appear as you go and a chunk that came back wrong is visible before
 * the end. Version 1 showed each chunk the same way.
 *
 * Nothing is shown for a dictation that produced a single chunk, where the alert would only
 * repeat what is about to be pasted or copied anyway. That is known from the first chunk
 * being the final one, not from counting the chunks so far: when chunk 1 comes back, chunk
 * 2 has usually not been recorded yet, so a count would suppress exactly the chunk that
 * most wants showing.
 *
 * @param {object} mine The session the chunk belongs to.
 * @param {number} chunkNum Which chunk, counting from 1.
 * @param {boolean} isFinal Whether the recorder said this was the last chunk.
 * @param {?string} text What it said, or null if it could not be transcribed.
 */
function chunkSettled(mine, chunkNum, isFinal, text) {
    if (!sessionCurrent(mine)) return

    if (state === STATES.recording) menuBarElapsed()
    else if (state === STATES.transcribing) menuBarTranscribing(mine.lang)

    if (!text) return
    notify("transcription", "debug", `chunk ${chunkNum}: ${text}`)

    const onlyChunk = chunkNum === 1 && isFinal
    if (config.chunkAlertSeconds > 0 && !onlyChunk) {
        notify("transcription", "info", `${chunkNum}: ${text}`, config.chunkAlertSeconds)
    }
}

/**
 * Explain a silent recording, as far as it can be told from the peak alone.
 *
 * A process without microphone permission is handed samples that have been replaced with
 * zero — no error, no warning — so bit-exact silence points at permission or at a
 * disconnected device, while a tiny but non-zero floor means the device is producing
 * samples that carry no signal. It is a guess, and says so.
 */
function silentAudioExplain(peak) {
    let device = "unknown"
    const configured = config.recorder === "streaming"
        ? config.streamingAudioInputDevice
        : config.soxAudioInputDevice
    if (configured) {
        device = configured
    } else {
        const standard = hs.audiodevice.defaultInputDevice()
        if (standard) device = `${standard.name} (system default)`
    }

    const because = peak === 0
        ? "Likely cause: Hammerspoon 2 has not been given microphone permission, or the " +
          "input device is disconnected. Check System Settings → Privacy & Security → " +
          "Microphone."
        : "Likely cause: the microphone is muted, its gain is at zero, or it is powered " +
          "off. The device is producing samples, but no signal."

    return `No audio in the first chunk (peak=${peak.toFixed(5)}, device="${device}"). ${because}`
}

/** Called by the recorder when it has produced everything it is going to. */
function recorderFinished(mine) {
    if (!sessionCurrent(mine)) return
    mine.recorderDone = true
    sessionFinalize(mine)
}

/** Assemble and deliver, once the recorder is done and every chunk has settled. */
async function sessionFinalize(mine) {
    if (!sessionCurrent(mine) || mine.finalizing) return
    if (state !== STATES.transcribing) return
    if (!mine.recorderDone) return

    mine.finalizing = true
    await Promise.allSettled(mine.chunks)
    if (!sessionCurrent(mine)) return

    const numbers = [...mine.results.keys()].sort((a, b) => a - b)
    const text = numbers.map((n) => mine.results.get(n)).join("\n\n")

    if (mine.failures.length > 0) {
        const which = mine.failures.map((f) => f.num).sort((a, b) => a - b).join(", ")
        const total = mine.failures.length + numbers.length
        // Reported rather than written into the text. The Lua version put
        // "[chunk 3: error - …]" in among the words, so the error reached the clipboard and
        // from there whatever the user pasted into.
        notify("transcription", "warning",
            `${mine.failures.length} of ${total} chunks could not be transcribed ` +
            `(${which}): ${firstLine(mine.failures[0].reason)}. The text is incomplete.`)
    }

    if (!text) {
        if (mine.failures.length === 0) {
            notify("transcription", "warning", "Nothing was transcribed")
        }
        sessionEnd(mine)
        return
    }

    const filtered = await filterApply(text)
    if (!sessionCurrent(mine)) return

    if (userCallback) {
        const callback = userCallback
        userCallback = null
        sessionEnd(mine)
        try {
            callback(filtered)
        } catch (e) {
            notify("transcription", "error", `The transcription callback threw: ${e.message}`)
        }
        return
    }

    hs.pasteboard.writeString(filtered)

    // The paste decision is made here, with the clipboard already written, rather than from
    // a state-change handler as in the Lua version — which had to hand a "now go to idle"
    // callback down into the state machine to get the ordering right.
    const paste = shouldPaste
    shouldPaste = false
    sessionEnd(mine)

    if (!paste) {
        notify("transcription", "info", `Copied ${filtered.length} characters to the clipboard`)
        return
    }
    autoPaste(filtered)
}

/** Put the session away and return to idle. */
function sessionEnd(mine) {
    if (sessionCurrent(mine)) session = null
    recordingSessionStop()
    if (state === STATES.transcribing || state === STATES.error) {
        stateTransition(STATES.idle, "finished")
    }
    menuBarIdle()

    // A microphone change during the recording was put off until now.
    if (audioRestartPending) {
        audioRestartPending = false
        audioRestartSchedule()
    }
}

// MARK: - Pasting

function pasteKeystroke() {
    if (config.pasteWithEmacsYank) {
        const focused = hs.window.focusedWindow()
        const app = focused ? focused.application : null
        if (app && app.bundleID === EMACS_BUNDLE_ID) {
            logDebug("pasting into Emacs with ctrl-y")
            hs.eventtap.keyStroke(["ctrl"], "y")
            return
        }
    }
    hs.eventtap.keyStroke(["cmd"], "v")
}

/** Paste the transcription, unless the user looks to have moved on while it was recorded. */
function autoPaste(text) {
    if (config.monitorUserActivity) {
        const busy = activityCounts.keys >= config.activityKeyLimit ||
            activityCounts.clicks >= 1 ||
            activityCounts.appSwitches >= 1
        if (busy) {
            notify("transcription", "warning",
                `Not pasting: you were typing or clicking while recording ` +
                `(${activitySummary()}). The text is on the clipboard — paste it with ⌘V.`)
            return
        }
        if (!sameAppFocused()) {
            notify("transcription", "warning",
                "Not pasting: the frontmost application changed while recording. " +
                "The text is on the clipboard — paste it with ⌘V.")
            return
        }
    }

    timers.later(config.autoPasteDelay, () => {
        try {
            pasteKeystroke()
            notify("transcription", "info", `Pasted ${text.length} characters`)
        } catch (e) {
            notify("transcription", "error",
                `Could not paste (${e.message}). The text is on the clipboard — ` +
                "paste it with ⌘V.")
        }
    })
}

// MARK: - Audio input device changes

/**
 * Restart the streaming server so it binds to the input device now in use.
 *
 * PortAudio resolves the device when the input stream is opened, so a microphone changed
 * afterwards leaves the server reading from the old one.
 */
async function serverRestart(why) {
    if (!recorder || recorder.name !== "streaming") {
        return "The streaming recorder is not in use, so there is no server to restart"
    }

    notify("init", "info", `Restarting the streaming server (${why})`)
    // Awaited, not left to finish: the new server cannot open the input device until the
    // old one has let go of it.
    await recorders.streaming.serverStop()
    const failed = await recorders.streaming.warmup()
    if (failed) {
        notify("init", "error", `Could not restart the streaming server: ${failed}`)
        return failed
    }
    notify("init", "info", "The streaming server restarted")
    return null
}

function audioRestartSchedule() {
    if (state !== STATES.idle) {
        // Restarting now would throw away the recording in progress.
        audioRestartPending = true
        logDebug(`input device changed during ${state}; deferring the server restart`)
        return
    }
    if (audioRestartTimer) audioRestartTimer.stop()
    // Changing a device can produce several notifications in a row, so settle first.
    audioRestartTimer = hs.timer.doAfter(0.75, () => {
        audioRestartTimer = null
        serverRestart("the audio input device changed")
    })
}

// MARK: - Language

/** The language transcription is being asked for. */
function languageGet() {
    return config.languages[langIndex]
}

/**
 * Choose a language by code. It has to be one of `config.languages`.
 *
 * @param {string} lang A language code, as "en".
 * @returns {boolean} Whether it was recognised.
 */
function languageSet(lang) {
    const found = config.languages.indexOf(lang)
    if (found === -1) {
        notify("config", "warning", `Not a configured language: ${lang}. ` +
            `Configured: ${config.languages.join(", ")}`)
        return false
    }
    langIndex = found
    notify("config", "info", `${icons.language} Language: ${lang}`)
    menuBarIdle()
    return true
}

/** Move to the next configured language, wrapping round. */
function languageNext() {
    languageSet(config.languages[(langIndex + 1) % config.languages.length])
    return module.exports
}

/** Offer the configured languages. */
function languageSelect() {
    const choices = config.languages.map((lang, i) => ({
        text: lang,
        subText: i === langIndex ? "✓ Selected" : "",
        lang: lang
    }))

    languageChooser = hs.chooser.create()
    languageChooser.placeholder = "Transcription language"
    // setChoices(), not a `choices` property: assigning one of those is accepted in
    // silence and leaves the chooser empty. Same for onSelect, which is a property.
    languageChooser.setChoices(choices)
    languageChooser.onSelect = (choice) => {
        if (choice) languageSet(choice.lang)
    }
    languageChooser.show()
    return module.exports
}

// MARK: - Recording and transcribing

function backendsReady() {
    if (recorder && transcriber) return true
    notify("init", "warning", starting
        ? "hs_whisper-gt is still checking its recorder and transcriber — try again"
        : "hs_whisper-gt has no working recorder or transcriber. Run whisper-diagnose.")
    return false
}

/**
 * Start recording.
 *
 * @param {function|boolean} [callbackOrPaste] A function to be given the transcription
 *        instead of the clipboard, or true to paste the text where the cursor is.
 */
async function transcribeBegin(callbackOrPaste) {
    if (!backendsReady()) return module.exports

    if (state === STATES.error) stateTransition(STATES.idle, "recovering")
    if (state !== STATES.idle) {
        notify("recording", "warning", `Already busy (${state})`)
        return module.exports
    }

    if (typeof callbackOrPaste === "function") {
        userCallback = callbackOrPaste
        shouldPaste = false
    } else {
        userCallback = null
        shouldPaste = callbackOrPaste === true
    }

    // macOS hands a process without this permission samples that have been replaced with
    // zero, with no error of any kind, so without the check the only symptom is an empty
    // transcription. The Lua version had no equivalent and guessed after the fact from the
    // amplitude.
    if (!hs.permissions.checkMicrophone()) {
        notify("recording", "error",
            "Hammerspoon 2 does not have microphone permission, so a recording would be " +
            "silent. Grant it in System Settings → Privacy & Security → Microphone.")
        hs.permissions.requestMicrophone()
        return module.exports
    }

    if (!dirEnsure(config.tempDir)) return module.exports

    const mine = sessionNew(languageGet())
    session = mine
    if (!stateTransition(STATES.recording, "starting to record")) {
        session = null
        return module.exports
    }

    try {
        await recorder.start(mine,
            (file, num, isFinal, peak) => chunkReceived(mine, file, num, isFinal, peak))
    } catch (e) {
        session = null
        stateTransition(STATES.error, "the recorder would not start")
        stateTransition(STATES.idle, "recovering")
        menuBarIdle()
        notify("recording", "error", `Could not start recording: ${e.message}`)
        return module.exports
    }

    if (!sessionCurrent(mine)) return module.exports

    const abbrev = filterAbbrev()
    notify("recording", "info", `${icons.recording} Recording (${mine.lang})` +
        (abbrev ? ` [${abbrev}]` : ""))
    recordingSessionStart()
    return module.exports
}

/** Stop recording and transcribe what was recorded. */
async function transcribeEnd() {
    if (state !== STATES.recording) {
        notify("recording", "warning", `Not recording (${state})`)
        return module.exports
    }

    const mine = session
    if (!stateTransition(STATES.transcribing, "stopping")) return module.exports

    // The recording is over even though the transcription is not, so the recording-only
    // parts of the display go now and the rest waits for the text.
    if (elapsedTimer) {
        elapsedTimer.stop()
        elapsedTimer = null
    }
    if (timeoutTimer) {
        timeoutTimer.stop()
        timeoutTimer = null
    }
    startTime = null
    indicatorHide()
    menuBarTranscribing(mine.lang)

    try {
        await recorder.stop(mine,
            (file, num, isFinal, peak) => chunkReceived(mine, file, num, isFinal, peak))
    } catch (e) {
        notify("recording", "error", `Could not stop recording cleanly: ${e.message}`)
    }

    recorderFinished(mine)
    return module.exports
}

/**
 * Start recording, or stop and transcribe if already recording.
 *
 * @param {function|boolean} [callbackOrPaste] As transcribeBegin().
 */
function transcribeToggle(callbackOrPaste) {
    if (state === STATES.idle || state === STATES.error) transcribeBegin(callbackOrPaste)
    else if (state === STATES.recording) transcribeEnd()
    else notify("recording", "warning", `Busy transcribing — wait or abort`)
    return module.exports
}

/** Abandon the recording or transcription in progress. Does nothing when idle. */
function transcribeAbort() {
    if (state === STATES.idle) {
        notify("recording", "info", "Nothing to abort")
        return module.exports
    }

    const from = state
    const mine = session
    // Dropped before the recorder is told, so that a chunk already on its way is recognised
    // as belonging to an abandoned session and discarded.
    session = null
    shouldPaste = false
    userCallback = null

    if (from === STATES.recording && recorder) {
        // Only to stop the microphone; the audio is not wanted.
        Promise.resolve()
            .then(() => recorder.stop(mine, () => {}))
            .catch((e) => logDebug(`aborting the recorder: ${e.message}`))
    }

    recordingSessionStop()
    stateTransition(STATES.idle, "aborted")
    menuBarIdle()
    notify("recording", "info", `Aborted (${from.toLowerCase()})`)
    return module.exports
}

/** Whether a recording is in progress. */
function isRecording() {
    return state === STATES.recording
}

// MARK: - Transcribing a recording again

/**
 * Transcribe a recording that is already on disk.
 *
 * @param {string} audioFile The recording.
 * @param {function} [callback] Given the text instead of the clipboard.
 */
async function recordingTranscribe(audioFile, callback) {
    let using = transcriber
    if (config.retranscribeTranscriber) {
        const wanted = transcribers[config.retranscribeTranscriber]
        if (!wanted) {
            notify("transcription", "error",
                `Unknown retranscribeTranscriber: ${config.retranscribeTranscriber}`)
            return module.exports
        }
        const failed = await wanted.validate()
        if (failed) {
            notify("transcription", "error",
                `${config.retranscribeTranscriber} cannot be used: ${failed}`)
            return module.exports
        }
        wanted.name = config.retranscribeTranscriber
        using = wanted
    }

    const lang = languageGet()
    const app = hs.window.focusedWindow() ? hs.window.focusedWindow().application : null

    notify("transcription", "info", `Transcribing again with ${using.name} (${lang})…`)
    menuBarSet(`${icons.transcribing} (${lang})`, `Transcribing again with ${using.name}`)

    let text
    try {
        text = await using.transcribe(audioFile, lang)
    } catch (e) {
        menuBarIdle()
        notify("transcription", "error", `Could not transcribe again: ${e.message}`)
        return module.exports
    }

    menuBarIdle()
    if (!text) {
        notify("transcription", "warning", "Nothing was transcribed")
        return module.exports
    }

    const filtered = await filterApply(text)

    if (callback) {
        try {
            callback(filtered)
        } catch (e) {
            notify("transcription", "error", `The transcription callback threw: ${e.message}`)
        }
        return module.exports
    }

    hs.pasteboard.writeString(filtered)

    // Pasted only if the same application still has focus — the chooser was open in the
    // meantime, so the user may well have gone elsewhere.
    const focused = hs.window.focusedWindow()
    const current = focused ? focused.application : null
    if (app && current && current.bundleID === app.bundleID) {
        timers.later(config.autoPasteDelay, () => {
            pasteKeystroke()
            notify("transcription", "info", "Pasted")
        })
    } else {
        notify("transcription", "info", "Copied to the clipboard")
    }
    return module.exports
}

/**
 * Offer recent recordings and transcribe the chosen one again.
 *
 * For a dictation that came back wrong, to try with another language or another transcriber
 * without saying it all again.
 *
 * @param {function} [callback] Given the text instead of the clipboard.
 */
function transcribeAgain(callback) {
    const found = recordingsList().slice(0, config.retranscribeCount)
    if (found.length === 0) {
        notify("recording", "warning", `No recordings in ${config.tempDir}`)
        return module.exports
    }

    const choices = found.map((recording) => ({
        text: new Date(recording.modified * 1000).toLocaleString(),
        subText: `${recording.name} (${(recording.size / 1024 / 1024).toFixed(2)} MB)`,
        path: recording.path
    }))

    recordingChooser = hs.chooser.create()
    recordingChooser.placeholder = "Transcribe which recording again"
    // The filename is in the subtext, and it carries the language and the time, so
    // searching it is how a particular recording is found.
    recordingChooser.searchSubText = true
    recordingChooser.setChoices(choices)
    recordingChooser.onSelect = (choice) => {
        if (choice) recordingTranscribe(choice.path, callback)
    }
    recordingChooser.show()
    return module.exports
}

// MARK: - Diagnostics

/**
 * Turn detailed logging on or off, without reloading.
 *
 * Also decides whether the streaming server is started with --verbose, which makes it
 * report audio levels. A server already running keeps whatever it was started with, so
 * follow this with serverRestart() to change that.
 *
 * @param {boolean} enable
 */
function debugSet(enable) {
    debugEnabled = !!enable
    notify("config", "info", `Debug logging ${debugEnabled ? "on" : "off"}`)
    return module.exports
}

/** Print what the Spoon is doing and what it is using, for when something is not working. */
function diagnose() {
    const say = (line) => console.log(`[hs_whisper-gt diagnose] ${line}`)

    say("--- hs_whisper-gt ---")
    say(`state: ${state}${starting ? " (still starting)" : ""}`)
    say(`language: ${languageGet()} (${langIndex + 1} of ${config.languages.length}: ` +
        `${config.languages.join(", ")})`)
    say(`configured: recorder=${config.recorder} transcriber=${config.transcriber}`)
    say(`in use: recorder=${recorder ? recorder.name : "none"} ` +
        `transcriber=${transcriber ? transcriber.name : "none"}`)

    const filter = filterActive()
    say(`filter: ${filter ? filter.name : "none"} (${config.filters.length} configured)`)

    if (session) {
        say(`session: ${session.prefix} chunks=${session.chunks.length} ` +
            `done=${session.results.size} failed=${session.failures.length} ` +
            `recorderDone=${session.recorderDone}`)
    } else {
        say("session: none")
    }

    if (recorder && recorder.name === "streaming") {
        const task = recorders.streaming.task
        say(`streaming server: ${task ? `pid ${task.pid} running=${task.isRunning}` : "not running"}`)
        say(`  device: ${config.streamingAudioInputDevice || "(system default)"}`)
    }
    if (transcriber && transcriber.name === "whisperserver") {
        const task = transcribers.whisperserver.task
        say(`whisper server: ${config.whisperserverHost}:${config.whisperserverPort}` +
            (task ? `, started here as pid ${task.pid}` : ", not started here"))
    }

    const input = hs.audiodevice.defaultInputDevice()
    if (input) {
        say(`system default input: ${input.name} (uid=${input.uid} muted=${input.muted} ` +
            `inputMuted=${input.inputMuted})`)
    }
    say(`microphone permission: ${hs.permissions.checkMicrophone()}`)
    say(`accessibility permission: ${hs.permissions.checkAccessibility()}`)

    const recordings = recordingsList()
    say(`recordings in ${config.tempDir}: ${recordings.length} (keeping ` +
        `${config.recordingsKeep || "all"})`)
    say(`debug logging: ${debugEnabled}`)
    // An idle Spoon should hold no timers, and one task only when the streaming server is
    // running. Anything else is something that was not put away.
    say(`held: ${shell.runningCount()} tasks, ${heldTimers.size} timers ` +
        `(${timers.pendingCount()} pending in dmg-libs/timer.js, shared with other Spoons)`)
    say("--- end ---")
    return module.exports
}

// MARK: - Hotkeys, start and stop

/**
 * Bind keys to this Spoon's actions.
 *
 * @param {object} [mapping] Keyed by action name — any of `transcribeToggle`,
 *        `transcribeToClipboardToggle`, `languageSelect`, `languageNext`,
 *        `filterSelect`, `transcribeAgain`, `transcribeAbort` — each holding
 *        `[[modifiers], key]`. Defaults to `config.defaultKeyBindings`.
 */
function bindHotkeys(mapping) {
    const actions = {
        // Dictating into whatever has focus is the ordinary case, so it has the plain
        // name; the one that goes to the clipboard says so. Both call the same function,
        // which takes where the text should go as its argument.
        transcribeToggle: () => transcribeToggle(true),
        transcribeToClipboardToggle: () => transcribeToggle(false),
        languageSelect: () => languageSelect(),
        languageNext: () => languageNext(),
        filterSelect: () => filterSelect(),
        transcribeAgain: () => transcribeAgain(),
        transcribeAbort: () => transcribeAbort()
    }

    for (const [name, spec] of Object.entries(mapping ?? config.defaultKeyBindings)) {
        if (!actions[name]) {
            console.error(`[hs_whisper-gt] unknown hotkey action: ${name}`)
            continue
        }
        hotkeys.push(hs.hotkey.bind(spec[0], spec[1], actions[name], null))
    }
    return module.exports
}

/**
 * Put the menu bar item up and choose the recorder and transcriber.
 *
 * Returns at once. Choosing a backend means running commands — `command -v`, a dependency
 * check, a server health probe — and none of that may block the runtime, so it finishes in
 * the background and reports what it found. A key pressed before it is done is answered
 * rather than ignored.
 */
function start() {
    menuBarEnsure()
    menuBarIdle()
    dirEnsure(config.tempDir)
    recordingsPrune()

    starting = true
    backendsStart()
    return module.exports
}

async function backendsStart() {
    recorder = await backendResolve(recorders, config.recorder, "recorder")
    transcriber = await backendResolve(transcribers, config.transcriber, "transcriber")
    starting = false

    if (!recorder || !transcriber) {
        notify("init", "error", "hs_whisper-gt is not usable — run whisper-diagnose")
        return
    }

    // Absorb the startup cost now rather than in front of the first recording.
    if (recorder.warmup) {
        const failed = await recorder.warmup()
        if (failed) {
            notify("init", "warning",
                `The ${recorder.name} recorder could not be pre-started (${failed}); ` +
                "it will be tried again on the first recording")
        }
    }

    // The streaming server binds its input device when it opens the stream, so a later
    // change to the default microphone leaves it reading from the old one.
    if (recorder.name === "streaming" && !audioListener) {
        audioListener = () => audioRestartSchedule()
        hs.audiodevice.on("dIn", audioListener)
    }

    notify("init", "info",
        `hs_whisper-gt ready: ${recorder.name} + ${transcriber.name}`)

    if (!hs.permissions.checkMicrophone()) {
        notify("init", "warning",
            "Hammerspoon 2 has no microphone permission yet, so recordings would be " +
            "silent. Grant it in System Settings → Privacy & Security → Microphone.")
    }
}

/** Abandon anything in progress and take everything down. */
function stop() {
    if (state !== STATES.idle) transcribeAbort()

    for (const hotkey of hotkeys) {
        if (hotkey) hotkey.destroy()
    }
    hotkeys = []

    recordingSessionStop()

    if (audioListener) {
        hs.audiodevice.off("dIn", audioListener)
        audioListener = null
    }
    if (audioRestartTimer) {
        audioRestartTimer.stop()
        audioRestartTimer = null
    }
    audioRestartPending = false

    for (const backend of [recorder, transcriber]) {
        if (backend && backend.cleanup) backend.cleanup()
    }
    recorder = null
    transcriber = null

    if (menuBar) {
        menuBar.destroy()
        menuBar = null
    }

    languageChooser = null
    filterChooser = null
    recordingChooser = null

    return module.exports
}

module.exports = {
    config,

    transcribeToggle,
    transcribeBegin,
    transcribeEnd,
    transcribeAbort,
    transcribeAgain,
    recordingTranscribe,

    languageGet,
    languageSet,
    languageSelect,
    languageNext,

    filterGet,
    filterSet,
    filterSelect,

    recordingsList,
    recordingsPrune,

    debugSet,
    diagnose,
    serverRestart: () => serverRestart("asked to"),

    isRecording,
    state: () => state,

    bindHotkeys,
    start,
    stop
}
