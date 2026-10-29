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
// than leaving the Spoon unusable, and reports that it did so.
//
// Two things here are not translations of the Lua:
//
// The streaming recorder's Python server is started by launchd, not by this Spoon, and the
// Spoon connects to it over a WebSocket. Version 1 started the server itself and spoke to
// it over TCP; Hammerspoon 2 has no TCP socket, but it has a WebSocket client. A server of
// its own lets Emacs use the same one, keeps its model loaded across reloads, and opens the
// microphone only while dictating. See the readme for the protocol and the LaunchAgent.
//
// Transcription is genuinely asynchronous. The Lua version deferred a blocking `io.popen`
// read by 10 ms and called that async, so Hammerspoon froze for the length of every
// transcription. Here a transcriber returns a promise and the state machine awaits it.
//
// Commands run through dmg-libs/shell.js, whose result has the same shape whether the
// command succeeds, fails or cannot be started.

const shell = require(hs.appinfo.configDir + "/dmg-libs/shell.js")

// MARK: - User-configurable settings

const config = {
    // Languages offered by the chooser. The first is selected at startup. The Spoon adds
    // "auto" after them, which lets Whisper detect the language of each recording or chunk.
    languages: ["en"],

    // Translate into English instead of transcribing in the language spoken. Whisper can
    // translate only into English. Models with "turbo" in their name were not trained to
    // translate, and often return the spoken language unchanged.
    translate: false,

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

    // Processors, offered by processorSelect(). A processor is how a dictation issues a
    // command rather than producing text: it is handed the transcription and is responsible
    // for whatever is done with it, and nothing is pasted or copied. Each entry is
    // {name, abbrev, cmd} or {name, abbrev, fn}:
    //   cmd     a shell command reading the text on stdin; WHISPER_LANG is set, and
    //           WHISPER_CHUNK when it is given one chunk
    //   fn      a function called as fn(text, {lang, chunk}); it may return a promise
    // With the streaming recorder the processor is called once for each chunk, as soon as
    // the chunk and every one before it are transcribed, one call at a time and in order.
    // Anything the processor prints or returns is shown when it has finished. Only a
    // dictation started with transcribeToProcessorToggle() goes to a processor, and it goes
    // to the selected one, which is the first in this list until another is chosen. The
    // filter is not applied to it.
    processors: [],

    // Transcriber to use for transcribeAgain(), or null for the current one.
    retranscribeTranscriber: null,
    // Recordings offered by transcribeAgain()'s chooser.
    retranscribeCount: 10,

    // sox
    soxCmd: "/opt/homebrew/bin/sox",
    soxAudioInputDevice: null,   // null for the system default

    // With no device configured, record from the built-in microphone when the system
    // default input is a Bluetooth headset. While its microphone is in use, a headset such
    // as AirPods stops playing sound, so recording from it means not hearing anything else.
    bluetoothInputAvoid: true,

    // streaming. The server is started by launchd (see the readme), and this is where it
    // listens. streamingLaunchAgent is the label serverRestart() asks launchd to restart.
    streamingUrl: "ws://127.0.0.1:12341",
    streamingLaunchAgent: "org.turingmachine.whisper-stream",
    streamingAudioInputDevice: null,
    streamingSilenceThreshold: 2.0,   // seconds of silence that ends a chunk
    streamingMinChunkDuration: 3.0,
    streamingMaxChunkDuration: 600.0,
    // Do not transcribe a chunk in which the server's voice-activity detector found no
    // speech. Whisper given silence tends to invent text for it, typically "Thank you.",
    // which would then be pasted or handed to a processor.
    streamingSilentChunkSkip: true,
    // When pasting, paste each chunk as soon as it and every chunk before it have been
    // transcribed, instead of pasting the whole dictation once at the end. It applies only
    // without a filter, because a filter is run over the whole text. Pasting stops, and the
    // rest goes to the clipboard, once focus leaves the window the dictation began in.
    streamingChunkInsert: true,

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
// has a noise floor around 0.005; one that is muted, off, or denied permission delivers
// about 0. Only
// the first chunk is judged — silence between later phrases is ordinary.
const SILENCE_PEAK_FLOOR = 0.001

// The values offered for the two chunking settings in the menu bar menu. Any other value can
// be set with silenceThresholdSet() and minChunkDurationSet(); a value set that way is added
// to the menu, ticked.
const SILENCE_THRESHOLD_PRESETS = [1, 1.5, 2, 3, 4, 5]
const MIN_CHUNK_DURATION_PRESETS = [0, 1, 2, 3, 5, 10]

// Placed between the chunks of a dictation, both when they are pasted one at a time and
// when they are joined at the end.
const CHUNK_SEPARATOR = "\n\n"

// Seconds to wait after a paste keystroke before the clipboard is written again. The
// application reads the clipboard when it handles the keystroke, which can be after
// keyStroke() returns. Writing the next chunk before then pastes the next chunk instead.
const PASTE_SETTLE_SECONDS = 0.25

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

// The language code that asks Whisper to detect the language. Always offered, after
// config.languages; see languagesOffered().
const LANGUAGE_AUTO = "auto"

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
// Index into config.processors of the processor that transcribeToProcessorToggle() uses.
let activeProcessor = 0

let menuBar = null
let hotkeys = []
let elapsedTimer = null
let timeoutTimer = null
let startTime = null
let indicatorCanvas = null

let activityTap = null
let activityAppListener = null
let activityCounts = {keys: 0, ownKeys: 0, clicks: 0, itemClicks: 0, appSwitches: 0}
let startingApp = null
let shouldPaste = false
let userCallback = null


let debugEnabled = false

// The input device chosen from the menu, by name, or null to choose automatically (see
// inputDeviceChoose()). Like the language, it lasts until the configuration is reloaded.
let inputDeviceSelected = null


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

/**
 * Reject if `promise` has not settled within `seconds`, so no await can hang for ever.
 *
 * The timer is stopped once the race is over rather than left to fire into nothing.
 */
function promiseTimeout(promise, seconds, what) {
    let timer = null
    const limit = new Promise((resolve, reject) => {
        timer = hs.timer.doAfter(seconds, () => {
            reject(new Error(`${what} timed out after ${seconds}s`))
        })
    })
    return Promise.race([promise, limit]).finally(() => { if (timer) timer.stop() })
}

function firstLine(text) {
    if (!text) return ""
    const line = String(text).trim().split("\n")[0]
    return line.length > 200 ? line.slice(0, 200) + "…" : line
}

/**
 * A multipart/form-data body holding text fields and one file.
 *
 * FormData cannot carry the file: its Blob converts a Uint8Array part with toString(), so
 * the bytes would arrive as "82,73,70,…". The body is therefore assembled by hand. There is
 * no TextEncoder either, so the field names, values and file name must be ASCII.
 *
 * @param {object} fields Field name -> text value.
 * @param {string} fileField Name of the file field.
 * @param {string} fileName File name sent with the file.
 * @param {Uint8Array} bytes Contents of the file.
 * @returns {{body: Uint8Array, contentType: string}}
 */
function multipartBodyBuild(fields, fileField, fileName, bytes) {
    const boundary = `----hswhisper${Date.now()}`
    const ascii = (text) => Uint8Array.from(text, (c) => c.charCodeAt(0))

    let head = ""
    for (const [name, value] of Object.entries(fields)) {
        head += `--${boundary}\r\nContent-Disposition: form-data; name="${name}"\r\n\r\n` +
            `${value}\r\n`
    }
    head += `--${boundary}\r\nContent-Disposition: form-data; name="${fileField}"; ` +
        `filename="${fileName}"\r\nContent-Type: application/octet-stream\r\n\r\n`

    const start = ascii(head)
    const end = ascii(`\r\n--${boundary}--\r\n`)
    const body = new Uint8Array(start.length + bytes.length + end.length)
    body.set(start, 0)
    body.set(bytes, start.length)
    body.set(end, start.length + bytes.length)
    return { body: body, contentType: `multipart/form-data; boundary=${boundary}` }
}

function filterActive() {
    if (activeFilter === null) return null
    return config.filters[activeFilter] || null
}

function filterAbbrev() {
    const filter = filterActive()
    return filter && filter.abbrev ? filter.abbrev : null
}

/** The processor that transcribeToProcessorToggle() uses, or null when none is configured. */
function processorActive() {
    return config.processors[activeProcessor] || config.processors[0] || null
}

/**
 * The abbreviation shown in brackets in the menu bar: the processor's during a dictation
 * that goes to one, and the active filter's otherwise. The filter is not applied to a
 * dictation that goes to a processor, so only the processor is worth showing then.
 */
function abbrevShown() {
    if (session && session.processor) return session.processor.abbrev || null
    return filterAbbrev()
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

/**
 * The menu shown when the menu bar item is right-clicked.
 *
 * Built fresh on each opening, so it reports the state it is opened in: what can be done
 * now, which language and filter are selected, and which backends are actually in use.
 *
 * Everything this Spoon can do is reachable here, because a Spoon's commands are otherwise
 * only reachable from a key or the command chooser, and neither says what exists.
 *
 * A left click dictates instead (see menuBarClick()), but the two dictation actions are
 * entries here as well, so that the menu lists everything.
 */
function menuBuild() {
    const idle = state === STATES.idle
    const entries = []

    if (state === STATES.recording) {
        entries.push({title: "Stop and transcribe", fn: () => transcribeEnd()})
        entries.push({title: "Abort", fn: () => transcribeAbort()})
    } else if (state === STATES.transcribing) {
        entries.push({title: "Transcribing…", disabled: true})
        entries.push({title: "Abort", fn: () => transcribeAbort()})
    } else {
        entries.push({title: "Dictate", fn: () => transcribeToggle(true)})
        entries.push({title: "Dictate to the clipboard", fn: () => transcribeToggle()})
        const processor = processorActive()
        if (processor) {
            entries.push({
                title: `Dictate to ${processor.name}`,
                fn: () => transcribeToProcessorToggle()
            })
        }
    }

    entries.push({title: "-"})

    // The language is fixed when a dictation starts, so changing it part way through would
    // do nothing to the dictation in progress. Shown, but not selectable, while one runs.
    entries.push({
        title: `Language: ${languageGet()}`,
        menu: languagesOffered().map((lang) => ({
            title: lang === LANGUAGE_AUTO ? "auto (detect)" : lang,
            checked: lang === languageGet(),
            disabled: !idle,
            fn: () => languageSet(lang)
        }))
    })

    // Fixed when a dictation starts, like the language.
    entries.push({
        title: `Output: ${config.translate ? "English" : "same as input"}`,
        menu: [
            {
                title: "Same as input",
                checked: !config.translate,
                disabled: !idle,
                fn: () => translateSet(false)
            },
            {
                title: "English (translate)",
                checked: !!config.translate,
                disabled: !idle,
                fn: () => translateSet(true)
            }
        ]
    })

    // The filter runs on the assembled text at the end, so changing it during a dictation
    // does apply to that dictation.
    const active = filterActive()
    entries.push({
        title: `Filter: ${active ? active.name : "none"}`,
        menu: [
            {title: "No filter", checked: active === null, fn: () => filterSet(null)}
        ].concat(config.filters.map((filter, i) => ({
            title: filter.name,
            checked: activeFilter === i,
            fn: () => filterSet(i)
        })))
    })

    // Decided when a dictation starts, like the language, so not selectable while one runs.
    // Only the streaming recorder produces more than one chunk, so these entries are
    // offered only with it.
    if (recorder && recorder.name === "streaming") {
        entries.push({
            title: "Paste each chunk as it is ready",
            checked: !!config.streamingChunkInsert,
            disabled: !idle,
            fn: () => chunkInsertToggle()
        })
        entries.push({
            title: `Chunking: ${config.streamingSilenceThreshold} s of silence, ` +
                `${config.streamingMinChunkDuration} s shortest`,
            menu: [{title: "Silence that ends a chunk", disabled: true}]
                .concat(chunkSettingMenu(SILENCE_THRESHOLD_PRESETS,
                    config.streamingSilenceThreshold, silenceThresholdSet, idle))
                .concat([{title: "-"}, {title: "Shortest chunk", disabled: true}])
                .concat(chunkSettingMenu(MIN_CHUNK_DURATION_PRESETS,
                    config.streamingMinChunkDuration, minChunkDurationSet, idle))
        })
    }

    // The processor is fixed when a dictation to it starts, so changing it applies to the
    // next one. Shown only when there is a processor to choose.
    const processor = processorActive()
    if (processor) {
        entries.push({
            title: `Processor: ${processor.name}`,
            menu: config.processors.map((entry, i) => ({
                title: entry.name,
                checked: entry === processor,
                fn: () => processorSet(i)
            }))
        })
    }

    // The streaming server opens the device when it starts, so changing it restarts the
    // server, which would throw away a dictation in progress. Not selectable while one runs.
    if (recorder) {
        entries.push({
            title: `Microphone: ${inputDeviceDescribe()}`,
            menu: [
                {
                    title: "Automatic",
                    checked: inputDeviceSelected === null,
                    disabled: !idle,
                    fn: () => inputDeviceSet(null)
                },
                {title: "-"}
            ].concat(hs.audiodevice.allInputDevices().map((device) => ({
                title: device.name,
                checked: device.name === inputDeviceSelected,
                disabled: !idle,
                fn: () => inputDeviceSet(device.name)
            })))
        })
    }

    entries.push({
        title: "Transcribe a recording again…",
        disabled: !idle,
        fn: () => transcribeAgain()
    })

    entries.push({title: "-"})

    const diagnostics = [
        {title: "Show diagnostics in the console", fn: () => diagnose()},
        {title: "Log every step", checked: debugEnabled, fn: () => debugSet(!debugEnabled)},
        {
            title: `Forget old recordings (keeping ${config.recordingsKeep || "all"})`,
            disabled: !config.recordingsKeep,
            fn: () => {
                const gone = recordingsPrune()
                notify("config", "info", `Deleted ${gone} recordings`)
            }
        }
    ]
    if (recorder && recorder.name === "streaming") {
        diagnostics.splice(2, 0, {
            title: "Restart the streaming server",
            disabled: !idle,
            fn: () => serverRestart("asked to from the menu")
        })
    }
    entries.push({title: "Diagnostics", menu: diagnostics})

    // Which backends are in use, rather than which were asked for: a fallback means those
    // differ, and this is where that is visible without running a command.
    entries.push({title: "-"})
    entries.push({
        title: starting
            ? "Checking the recorder and transcriber…"
            : (recorder && transcriber)
                ? `Using ${recorder.name} and ${transcriber.name}`
                : "No working recorder or transcriber",
        disabled: true
    })

    return entries
}

/**
 * Answer a click on the menu bar item.
 *
 * A left click does what the transcribeToggle key does: it starts a dictation into whatever
 * has focus, or stops the one in progress and transcribes it. Any other button, including
 * a Ctrl-click, opens the menu. The menu is built when it opens, so it shows the current
 * state.
 *
 * With monitorUserActivity, every click during a recording counts against auto-paste. A
 * click on this item is not a sign of having moved on, so it is recorded as one of ours
 * and autoPaste() subtracts it. This assumes the event tap counted the same press before
 * the activity monitor stopped. If it did not, a single click elsewhere would be cancelled
 * out by it.
 */
function menuBarClick(button) {
    if (state === STATES.recording) activityCounts.itemClicks += 1
    if (button === "left") transcribeToggle(true)
    else menuBar.popUpMenu(menuBuild())
}

function menuBarEnsure() {
    if (menuBar) return
    menuBar = hs.menubar.create()
    // No menu is set: a menu replaces the click callback, and the callback is what tells a
    // left click from a right one.
    menuBar.setClickCallback(menuBarClick)
}

function menuBarSet(title, tooltip) {
    if (!menuBar) return
    menuBar.title = title
    menuBar.setTooltip(tooltip)
}

function menuBarIdle() {
    const abbrev = abbrevShown()
    const filter = filterActive()
    let title = `${icons.idle} (${languageLabel(languageGet(), config.translate)})`
    let tooltip = "Idle"
    if (abbrev) title += ` [${abbrev}]`
    if (filter) tooltip = `Filter: ${filter.name}`
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
    // Counted from `order` and `settled` rather than from the transcriptions, so that a
    // chunk skipped for having no speech counts as done.
    if (!session || session.order.length < 2) return ""
    return `${session.settled.size}/${session.order.length}`
}

function menuBarElapsed() {
    if (state !== STATES.recording) return
    const elapsed = startTime ? Math.floor(hs.timer.secondsSinceEpoch() - startTime) : 0
    const abbrev = abbrevShown()
    const progress = sessionProgress()
    // The session's language, which an option to transcribeBegin() can make differ from the
    // selected one.
    const label = session ? languageLabel(session.lang, session.translate) : languageGet()
    let title = `${icons.recording} ${elapsed}s (${label})`
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
    activityCounts = {keys: 0, ownKeys: 0, clicks: 0, itemClicks: 0, appSwitches: 0}

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

/** Clicks during the recording, leaving out those on this Spoon's own menu bar item. */
function activityClicksElsewhere() {
    return Math.max(0, activityCounts.clicks - activityCounts.itemClicks)
}

/**
 * Keystrokes during the recording, leaving out the paste keystrokes this Spoon sent itself.
 * Those arrive at the event tap like any other once chunks are pasted while recording.
 */
function activityKeysElsewhere() {
    return Math.max(0, activityCounts.keys - activityCounts.ownKeys)
}

/** Why the user looks to have moved on since the recording started, or null if they have not. */
function activityMovedOn() {
    const busy = activityKeysElsewhere() >= config.activityKeyLimit ||
        activityClicksElsewhere() >= 1 ||
        activityCounts.appSwitches >= 1
    return busy ? `you were typing or clicking while recording (${activitySummary()})` : null
}

function activitySummary() {
    const parts = []
    const plural = (n, one, many) => `${n} ${n === 1 ? one : many}`
    const keys = activityKeysElsewhere()
    if (keys > 0) parts.push(plural(keys, "key", "keys"))
    const clicks = activityClicksElsewhere()
    if (clicks > 0) parts.push(plural(clicks, "click", "clicks"))
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

/** Quote a string for zsh, so it reaches the command as one word, unchanged. */
function shellQuote(value) {
    return `'${String(value).replace(/'/g, "'\\''")}'`
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

    const filterChooser = hs.chooser.create()
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

// MARK: - Processors

/**
 * Hand the text to a processor, and report how it went once the processor has finished.
 *
 * A processor is how a dictation issues a command rather than producing text. It is
 * responsible for whatever is done with the words, and nothing comes back to be pasted or
 * copied. What it prints, or what its function returns, is shown with the report, so it can
 * say what it did.
 *
 * `cmd` reads the text on its standard input, with WHISPER_LANG in its environment, and
 * WHISPER_CHUNK too when it is given one chunk. `fn` is called as fn(text, details) and may
 * return a promise.
 *
 * @param {object} processor The entry in config.processors.
 * @param {string} text The transcription, or one chunk of it.
 * @param {object} details {lang, chunk}. `chunk` is the chunk's number, counting from 1,
 *        or undefined when the processor is given the whole dictation.
 */
async function processorRun(processor, text, details) {
    logDebug(`sending to processor: ${processor.name}`)

    const failed = (reason) =>
        notify("transcription", "error", `Processor '${processor.name}' failed` +
            (details.chunk !== undefined ? ` on chunk ${details.chunk}` : "") + `: ${reason}`)
    const succeeded = (output) => {
        const said = typeof output === "string" ? output.trim() : ""
        notify("transcription", "info",
            `Sent to '${processor.name}'` +
            (details.chunk !== undefined ? ` (chunk ${details.chunk})` : "") +
            (said ? `: ${said}` : ""), said ? 6 : undefined)
    }

    if (typeof processor.fn === "function") {
        let result
        try {
            result = await processor.fn(text, details)
        } catch (e) {
            failed(`threw: ${e.message}`)
            return
        }
        succeeded(result)
        return
    }

    if (!processor.cmd) {
        failed("it has neither cmd nor fn")
        return
    }

    // The environment is set inside the shell, rather than given to hs.task, because a task
    // given an environment gets only that environment and loses everything else, PATH
    // included.
    const exports = [`WHISPER_LANG=${shellQuote(details.lang)}`]
    if (details.chunk !== undefined) exports.push(`WHISPER_CHUNK=${shellQuote(details.chunk)}`)
    const command = `export ${exports.join(" ")}; ${processor.cmd}`
    const result = await shell.commandRunInput("/bin/zsh", ["-l", "-c", command], text)
    if (result.code !== 0) {
        failed(`exit ${result.code}: ${firstLine(result.err || result.out)}`)
        return
    }
    succeeded(result.out)
}

/** The processor transcribeToProcessorToggle() uses, or null when none is configured. */
function processorGet() {
    return processorActive()
}

/**
 * Choose a processor without the chooser.
 *
 * @param {string|number} which A processor's `name`, or its index in `config.processors`.
 * @returns {boolean} Whether it was recognised.
 */
function processorSet(which) {
    const found = typeof which === "number"
        ? which
        : config.processors.findIndex((processor) => processor.name === which)

    if (found < 0 || found >= config.processors.length) {
        notify("config", "warning", `Not a configured processor: ${which}`)
        return false
    }

    activeProcessor = found
    notify("config", "info", `Processor: ${config.processors[found].name}`)
    menuBarIdle()
    return true
}

/** Offer the configured processors, and keep the chosen one until it is changed again. */
function processorSelect() {
    const selected = processorActive()
    const choices = config.processors.map((processor, i) => ({
        text: (processor === selected ? "● " : "") + processor.name,
        subText: processor.cmd || (processor.fn ? "(function)" : "(does nothing)"),
        index: i
    }))

    const processorChooser = hs.chooser.create()
    processorChooser.placeholder = "Dictation processor"
    processorChooser.setChoices(choices)
    processorChooser.onSelect = (choice) => {
        if (!choice) return
        processorSet(choice.index)
    }
    processorChooser.show()
    return module.exports
}

// MARK: - Transcribers

/**
 * Each transcriber is {validate, transcribe, cleanup?, fallback?}.
 *
 * validate()                      resolves to null when usable, or to why it is not
 * transcribe(audioFile, lang, translate)
 *                                 resolves to the text, or throws. `lang` may be "auto";
 *                                 `translate` true asks for English instead
 * cleanup()                       release anything held, when the Spoon stops
 * warm()                          get the model ready, called when a recording starts
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
        // whisperkit-cli has no "auto" language; it detects the language when given none.
        transcribe: async (audioFile, lang, translate) => {
            const args = [
                "transcribe",
                "--model", config.whisperkitModel,
                "--audio-path", audioFile,
                "--task", translate ? "translate" : "transcribe"
            ]
            if (lang !== LANGUAGE_AUTO) args.push("--language", lang)
            const result = await shell.commandRun(config.whisperkitCmd, args)
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
        transcribe: async (audioFile, lang, translate) => {
            const textFile = `${audioFile}.txt`
            const args = [
                "-np",
                "-m", config.whispercliModelPath,
                "-l", lang,
                "--output-txt", audioFile
            ]
            if (translate) args.push("--translate")
            const result = await shell.commandRun(config.whispercliCmd, args)
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
        // The server task, when this Spoon started it, kept so that it can be stopped again.
        task: null,

        validate: async () => {
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
            try {
                await fetch(url, { signal: AbortSignal.timeout(2000) })
                return true
            } catch (e) {
                return false
            }
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
                await new Promise((resolve) => hs.timer.doAfter(0.5, resolve))
            }

            if (self.task) self.task.terminate()
            self.task = null
            return `The whisper server did not answer within ` +
                `${config.whisperserverStartupTimeout}s`
        },

        /**
         * Transcribe a quarter of a second of silence, so that the model is in memory by the
         * time the first chunk arrives.
         *
         * The server keeps its model loaded for as long as it runs. After it has gone unused
         * for a while, macOS compresses or swaps those pages out, and the next transcription
         * has to bring them back first. Measured on 2026-10-23 with large-v3-turbo, the
         * server's resident memory was 8 MB of a 1.8 GB footprint. The first request took
         * 1.0s and the one after it 0.38s. Doing this when a recording starts moves that
         * cost to while you are speaking.
         */
        async warm() {
            const started = hs.timer.secondsSinceEpoch()
            try {
                await transcribers.whisperserver.transcribe(`${spoonDir}/assets/silence.wav`, "en")
            } catch (e) {
                logDebug(`warming the whisper server: ${e.message}`)
                return
            }
            logDebug(`warmed the whisper server in ` +
                `${(hs.timer.secondsSinceEpoch() - started).toFixed(2)}s`)
        },

        // The audio goes as multipart/form-data, through fetch(). hs.http.post takes only a
        // String body, so it cannot send the audio.
        // The server resets its parameters after every request, so a request that does not
        // ask to translate is transcribed even after one that did.
        transcribe: async (audioFile, lang, translate) => {
            const url = `http://${config.whisperserverHost}:${config.whisperserverPort}/inference`
            const file = hs.fs.open(audioFile, "r")
            if (!file) throw new Error(`Could not open ${audioFile}`)
            const audio = file.readBytes(file.size)
            file.close()
            if (!audio) throw new Error(`Could not read ${audioFile}`)

            const fields = {
                response_format: "text",
                language: lang,
                translate: translate ? "true" : "false"
            }
            const form = multipartBodyBuild(fields,
                "file", "audio.wav", audio)
            const response = await fetch(url, {
                method: "POST",
                headers: { "Content-Type": form.contentType },
                body: form.body
            })

            const body = await response.text()
            if (!response.ok) {
                throw new Error(`The whisper server answered ${response.status}: ${firstLine(body)}`)
            }
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
 * stderr; the peak is whichever is further from zero. This is what lets the silent-recording
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
 * onChunk(audioFile, chunkNum, isFinal, peak, speech) is called for each piece of audio
 * ready to transcribe. `peak` may be null when the recorder cannot measure it. `speech` is
 * whether the recorder found speech in the audio, or null when it cannot tell.
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

            const device = inputDeviceChoose(config.soxAudioInputDevice)
            const args = device
                ? ["-q", "-t", "coreaudio", device, self.audioFile]
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
        // The connection to the server, kept so that it can be used and closed.
        socket: null,
        // True from the server's server_ready until the connection fails or closes.
        connected: false,
        // The server's last report of itself: recording, microphone_open, device.
        status: null,
        // Resolved by server_ready, or with an error when the connection fails first.
        readyReached: null,
        // Resolved by recording_started, or with the error the server sent instead.
        startedReached: null,
        // Set while a session is stopping, resolved when the server says it has stopped.
        stopped: null,
        stoppedReached: null,
        // The session the current callbacks belong to, and where to send its chunks.
        mine: null,
        onChunk: null,

        validate: async () => recorders.streaming.connect(),

        /** Connect now, so the first recording does not wait for it. */
        warmup: async () => recorders.streaming.connect(),

        /**
         * Connect to the server, unless already connected.
         *
         * @returns {Promise<?string>} null once connected, or why it could not.
         */
        async connect() {
            const self = recorders.streaming
            if (self.connected) return null
            self.disconnect()

            const ready = new Promise((resolve) => { self.readyReached = resolve })
            const socket = hs.http.openWebSocket(config.streamingUrl)
            if (!socket) return `streamingUrl is not a WebSocket URL: ${config.streamingUrl}`
            self.socket = socket
            socket
                .setMessageCallback((message) => {
                    if (self.socket !== socket) return
                    let event
                    try {
                        event = JSON.parse(message)
                    } catch (e) {
                        logDebug(`unparseable message from the streaming server: ${message}`)
                        return
                    }
                    self.eventHandle(event)
                })
                // When the server goes away, only the error callback is called; the close
                // callback is not. Measured on 2026-10-15 against an hs.httpserver that was
                // stopped mid-connection. So both mean the connection is over.
                .setErrorCallback((error) => {
                    if (self.socket === socket) self.disconnected(error)
                })
                .setCloseCallback((code, reason) => {
                    if (self.socket === socket) self.disconnected(`closed (${code} ${reason})`)
                })

            let failed
            try {
                failed = await promiseTimeout(ready, 5, "connecting to the streaming server")
            } catch (e) {
                failed = e.message
            }
            if (failed) {
                self.disconnect()
                return `Could not reach the streaming server at ${config.streamingUrl}: ` +
                    `${failed}. It is started by the LaunchAgent ` +
                    `${config.streamingLaunchAgent}; see the readme.`
            }
            logDebug(`connected to the streaming server at ${config.streamingUrl}`)
            return null
        },

        /** Close the connection without treating it as a failure. */
        disconnect() {
            const self = recorders.streaming
            const socket = self.socket
            self.socket = null
            self.connected = false
            if (socket) {
                try {
                    socket.destroy()
                } catch (e) {
                    logDebug(`closing the connection to the streaming server: ${e.message}`)
                }
            }
        },

        /** The connection has failed or the server has gone. */
        disconnected(why) {
            const self = recorders.streaming
            self.socket = null
            self.connected = false
            logDebug(`the streaming server connection ended: ${why}`)

            // Release whatever is waiting on the server, since nothing more is coming.
            if (self.readyReached) self.readyReached(String(why))
            if (self.startedReached) self.startedReached(`the connection ended: ${why}`)
            if (self.mine) {
                notify("recording", "error",
                    `Lost the connection to the streaming server during a recording (${why})`)
            }
            if (self.stoppedReached) self.stoppedReached()
        },

        eventHandle(event) {
            const self = recorders.streaming

            switch (event.type) {
            case "server_ready":
                self.connected = true
                self.status = event
                if (self.readyReached) {
                    self.readyReached(null)
                    self.readyReached = null
                }
                break

            case "status":
                self.status = event
                break

            case "recording_started":
                logDebug(`the streaming server started recording from ${event.device || "the system default"}`)
                if (self.startedReached) {
                    self.startedReached(null)
                    self.startedReached = null
                }
                break

            case "chunk_ready": {
                const peak = typeof event.peak === "number" ? event.peak : null
                // Absent from a server older than the speech flag, which cannot tell.
                const speech = typeof event.speech === "boolean" ? event.speech : null
                logDebug(`chunk ${event.chunk_num}: ${event.audio_file} ` +
                    `peak=${peak} speech=${speech} final=${event.is_final}`)
                if (self.onChunk) {
                    self.onChunk(event.audio_file, event.chunk_num, event.is_final, peak, speech)
                }
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
                // An error in answer to start_recording is start()'s to report.
                if (self.startedReached) {
                    self.startedReached(event.error)
                    self.startedReached = null
                } else {
                    notify("recording", "error",
                        `The streaming server reported: ${event.error}`)
                }
                break

            default:
                logDebug(`unknown event from the streaming server: ${event.type}`)
            }
        },

        commandSend(command) {
            const self = recorders.streaming
            if (!self.connected || !self.socket) return false
            try {
                self.socket.send(JSON.stringify(command))
                return true
            } catch (e) {
                logDebug(`sending to the streaming server: ${e.message}`)
                return false
            }
        },

        async start(mine, onChunk) {
            const self = recorders.streaming

            const failed = await self.connect()
            if (failed) throw new Error(failed)

            self.mine = mine
            self.onChunk = onChunk
            self.stopped = new Promise((resolve) => { self.stoppedReached = resolve })
            const started = new Promise((resolve) => { self.startedReached = resolve })

            // Everything about the recording goes with the command, because the server is
            // shared: it keeps none of one client's settings for the next.
            const device = inputDeviceChoose(config.streamingAudioInputDevice)
            const sent = self.commandSend({
                command: "start_recording",
                filename_prefix: mine.prefix,
                output_dir: config.tempDir,
                audio_input: device,
                silence_threshold: config.streamingSilenceThreshold,
                min_chunk_duration: config.streamingMinChunkDuration,
                max_chunk_duration: config.streamingMaxChunkDuration,
                perfect_silence_duration: 0
            })
            if (!sent) {
                self.sessionRelease()
                throw new Error("Could not reach the streaming server")
            }

            // The server answers once the microphone is open, which after a pause takes
            // the device's opening time; it gives up on a microphone after 10 s itself.
            let refused
            try {
                refused = await promiseTimeout(started, 15, "the streaming server starting to record")
            } catch (e) {
                refused = e.message
            }
            if (refused) {
                self.sessionRelease()
                throw new Error(refused)
            }
        },

        async stop(mine, onChunk) {
            const self = recorders.streaming
            if (!self.commandSend({command: "stop_recording"})) {
                self.sessionRelease()
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
            self.sessionRelease()
        },

        sessionRelease() {
            const self = recorders.streaming
            self.startedReached = null
            self.stoppedReached = null
            self.onChunk = null
            self.mine = null
        },

        /**
         * Restart the server through launchd, and connect to the new one.
         *
         * @returns {Promise<?string>} null once connected again, or why not.
         */
        async restart() {
            const self = recorders.streaming
            self.disconnect()

            const user = await shell.commandRun("/usr/bin/id", ["-u"])
            const target = `gui/${(user.out || "").trim()}/${config.streamingLaunchAgent}`
            const kicked = await shell.commandRun("/bin/launchctl", ["kickstart", "-k", target])
            if (kicked.code !== 0) {
                return `launchctl kickstart ${target} failed: ${(kicked.err || kicked.out || "").trim()}`
            }

            // The new server loads its model before it listens, which takes a few seconds,
            // and a connection refused before then fails at once. So try until it answers.
            const pause = () => new Promise((resolve) => hs.timer.doAfter(0.5, resolve))
            let failed = null
            for (let attempt = 0; attempt < 60; attempt += 1) {
                failed = await self.connect()
                if (!failed) return null
                await pause()
            }
            return failed
        },

        cleanup() {
            recorders.streaming.sessionRelease()
            recorders.streaming.disconnect()
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

function sessionNew(lang, translate) {
    generation += 1
    return {
        generation: generation,
        lang: lang,
        // Whether to translate into English, fixed when the dictation starts like `lang`.
        translate: translate,
        prefix: sessionPrefix(lang),
        // One promise per chunk, each settling when that chunk has been transcribed.
        chunks: [],
        // chunkNum → text, so chunks are assembled in order however they finish.
        results: new Map(),
        // {num, reason} for each chunk that could not be transcribed.
        failures: [],
        // Chunk numbers in the order the recorder delivered them.
        order: [],
        // Chunk numbers that have come back, whether with text or not.
        settled: new Set(),

        // The processor the dictation goes to, or null when it produces text.
        processor: null,

        // What happens to each chunk as soon as it, and every chunk before it, has been
        // transcribed; set by sessionDeliveryChoose():
        //   null         nothing until the dictation ends, when the whole text is delivered
        //   "paste"      it is pasted where the dictation began; see chunkInsert()
        //   "processor"  it is handed to `processor`; see chunkProcess()
        chunkDelivery: null,
        // How many entries of `order` chunksDeliver() has dealt with.
        deliveredUpTo: 0,
        // The pastes or processor calls queued so far. Each finishes before the next one
        // starts: a paste before the next one writes the clipboard, and a processor call so
        // that the processor sees the chunks one at a time and in order.
        deliverChain: Promise.resolve(),

        // Used only when chunkDelivery is "paste".
        // The window the dictation began in, as {pid, id}. Chunks are pasted only there.
        target: null,
        // Chunk numbers whose text has been pasted.
        inserted: new Set(),
        // Why pasting stopped part way, or null while it continues.
        insertStopped: null,

        recorderDone: false,
        finalizing: false
    }
}

/**
 * Decide, as a dictation starts, where its text goes and whether that happens chunk by chunk.
 *
 * Only the streaming recorder produces more than one chunk, so with sox a processor or a
 * paste is given the whole dictation once it ends.
 *
 * @param {object} mine The new session.
 * @param {boolean} toProcessor Whether the dictation goes to the selected processor.
 */
function sessionDeliveryChoose(mine, toProcessor) {
    if (toProcessor) {
        mine.processor = processorActive()
        if (recorder.name === "streaming") mine.chunkDelivery = "processor"
        return
    }
    if (!chunkInsertApplies()) return

    // A chunk is pasted only into the window that had focus at the start, so with none
    // the dictation is pasted once at the end, as auto-paste always has been.
    const focused = hs.window.focusedWindow()
    if (!focused) return
    mine.chunkDelivery = "paste"
    mine.target = {pid: focused.pid, id: focused.id}
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
 * is what `mine` is for. A chunk the recorder found no speech in is passed over, with
 * config.streamingSilentChunkSkip, like one that came back empty.
 */
function chunkReceived(mine, audioFile, chunkNum, isFinal, peak, speech) {
    if (!sessionCurrent(mine)) {
        logDebug(`dropping chunk ${chunkNum} from an abandoned session`)
        return
    }

    notify("transcription", "debug",
        `chunk ${chunkNum} (final=${isFinal}, peak=${peak}, speech=${speech}): ${audioFile}`)

    // If the very first chunk is silent then the microphone is not delivering audio, and
    // going on would mean transcribing nothing while the user keeps talking into a
    // microphone that is delivering no signal. Later chunks are not judged: a pause between phrases is ordinary.
    if (chunkNum === 1 && peak !== null && peak < SILENCE_PEAK_FLOOR) {
        notify("recording", "error", silentAudioExplain(peak))
        transcribeAbort()
        return
    }

    mine.order.push(chunkNum)

    // Settled at once with no text, so the chunks after it are not held back waiting for
    // it, and the dictation ends with "Nothing was transcribed" if every chunk was silent.
    if (speech === false && config.streamingSilentChunkSkip) {
        logDebug(`chunk ${chunkNum} has no speech; not transcribing it`)
        mine.settled.add(chunkNum)
        chunkSettled(mine, chunkNum, isFinal, null)
        return
    }

    const work = transcriber.transcribe(audioFile, mine.lang, mine.translate)
        .then((text) => {
            if (!sessionCurrent(mine)) return
            if (text) mine.results.set(chunkNum, text)
            mine.settled.add(chunkNum)
            chunkSettled(mine, chunkNum, isFinal, text)
        })
        .catch((e) => {
            if (!sessionCurrent(mine)) return
            mine.failures.push({num: chunkNum, reason: e.message})
            mine.settled.add(chunkNum)
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
 * most needs to be shown.
 *
 * @param {object} mine The session the chunk belongs to.
 * @param {number} chunkNum Which chunk, counting from 1.
 * @param {boolean} isFinal Whether the recorder said this was the last chunk.
 * @param {?string} text What it said, or null if it could not be transcribed.
 */
function chunkSettled(mine, chunkNum, isFinal, text) {
    if (!sessionCurrent(mine)) return

    if (state === STATES.recording) menuBarElapsed()
    else if (state === STATES.transcribing) {
        menuBarTranscribing(languageLabel(mine.lang, mine.translate))
    }

    // Called with or without text: a chunk that failed or said nothing still has to be
    // passed over before the chunks after it can be delivered.
    if (mine.chunkDelivery) chunksDeliver(mine)

    if (!text) return
    notify("transcription", "debug", `chunk ${chunkNum}: ${text}`)

    // A chunk being pasted appears in the application, so an alert would only repeat it. A
    // chunk handed to a processor is reported when the processor has finished with it.
    if (mine.chunkDelivery === "paste" && !mine.insertStopped) return
    if (mine.chunkDelivery === "processor") return

    const onlyChunk = chunkNum === 1 && isFinal
    if (config.chunkAlertSeconds > 0 && !onlyChunk) {
        notify("transcription", "info", `${chunkNum}: ${text}`, config.chunkAlertSeconds)
    }
}

/**
 * Queue every chunk that is now ready, in the order the recorder delivered them: a paste,
 * or a call to the session's processor.
 *
 * Chunks are transcribed concurrently and can come back in any order. A chunk is delivered
 * only once every chunk before it has come back, so a slow chunk holds back the ones after
 * it. A chunk that failed or produced no text is passed over rather than waited for.
 */
function chunksDeliver(mine) {
    while (mine.deliveredUpTo < mine.order.length) {
        const num = mine.order[mine.deliveredUpTo]
        if (!mine.settled.has(num)) return
        mine.deliveredUpTo += 1
        if (!mine.results.has(num)) continue
        const deliver = mine.chunkDelivery === "processor" ? chunkProcess : chunkInsert
        mine.deliverChain = mine.deliverChain.then(() => deliver(mine, num))
    }
}

/** Hand one chunk to the session's processor, and wait for the processor to finish with it. */
async function chunkProcess(mine, num) {
    if (!sessionCurrent(mine)) return
    await processorRun(mine.processor, mine.results.get(num),
        {lang: languageOutput(mine.lang, mine.translate), chunk: num})
}

/** Resolve after `seconds`. */
function secondsWait(seconds) {
    return new Promise((resolve) => hs.timer.doAfter(seconds, resolve))
}

/** Paste one chunk where the dictation began, unless focus has left it. */
async function chunkInsert(mine, num) {
    if (!sessionCurrent(mine) || mine.insertStopped) return

    const lost = insertTargetLost(mine)
    if (lost) {
        mine.insertStopped = lost
        notify("transcription", "warning",
            `Stopped pasting: ${lost}. The rest of the dictation will be put on the clipboard.`)
        return
    }

    const text = mine.results.get(num)
    hs.pasteboard.writeString(mine.inserted.size > 0 ? CHUNK_SEPARATOR + text : text)
    await secondsWait(config.autoPasteDelay)
    if (!sessionCurrent(mine)) return

    try {
        pasteKeystroke()
    } catch (e) {
        mine.insertStopped = `the paste failed (${e.message})`
        notify("transcription", "error",
            `Could not paste (${e.message}). The rest of the dictation will be put on the ` +
            "clipboard.")
        return
    }
    mine.inserted.add(num)
    logDebug(`pasted chunk ${num}`)
    await secondsWait(PASTE_SETTLE_SECONDS)
}

/** Why a chunk should not be pasted now, or null if it should. */
function insertTargetLost(mine) {
    const focused = hs.window.focusedWindow()
    if (!focused) return "no window has focus"
    if (focused.pid !== mine.target.pid) {
        const app = focused.application
        return `focus moved to ${app ? app.name : "another application"}`
    }
    if (focused.id !== mine.target.id) return "focus moved to another window"
    if (config.monitorUserActivity) return activityMovedOn()
    return null
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
    const device = inputDeviceDescribe()

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
    // Every chunk has settled, so every paste or processor call has been queued by now.
    await mine.deliverChain
    if (!sessionCurrent(mine)) return

    const numbers = [...mine.results.keys()].sort((a, b) => a - b)
    const text = numbers.map((n) => mine.results.get(n)).join(CHUNK_SEPARATOR)

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

    if (mine.chunkDelivery === "paste") {
        sessionInsertFinish(mine, numbers, text)
        return
    }
    // Every chunk has already been handed to the processor.
    if (mine.chunkDelivery === "processor") {
        sessionEnd(mine)
        return
    }

    // Nothing is pasted, copied or given to a callback. The session stays open until the
    // processor has finished, so the menu bar shows it is still busy.
    if (mine.processor) {
        await processorRun(mine.processor, text, {lang: languageOutput(mine.lang, mine.translate)})
        // An abort while the processor ran may have been followed by a new dictation, which
        // sessionEnd() would otherwise end.
        if (sessionCurrent(mine)) sessionEnd(mine)
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

/**
 * End a dictation whose chunks were pasted one at a time, leaving the clipboard useful.
 *
 * When every chunk was pasted, the clipboard gets the whole dictation, as it would have
 * without pasting chunk by chunk. When pasting stopped part way, it gets only the chunks that
 * were not pasted, so that ⌘V back in the original window completes the dictation.
 *
 * No filter is applied here. Incremental pasting is used only without one, and a filter
 * chosen during the recording would otherwise run over text that has already been pasted.
 *
 * @param {object} mine The session.
 * @param {number[]} numbers The chunks that produced text, in order.
 * @param {string} text Those chunks joined.
 */
function sessionInsertFinish(mine, numbers, text) {
    const remaining = numbers.filter((n) => !mine.inserted.has(n))
    hs.pasteboard.writeString(remaining.length === 0
        ? text
        : remaining.map((n) => mine.results.get(n)).join(CHUNK_SEPARATOR))
    sessionEnd(mine)

    if (remaining.length === 0) {
        notify("transcription", "info", `Pasted ${text.length} characters`)
        return
    }
    notify("transcription", "warning",
        `Pasted ${mine.inserted.size} of ${numbers.length} chunks, then stopped because ` +
        `${mine.insertStopped}. The other ${remaining.length} are on the clipboard — paste ` +
        "them with ⌘V.")
}

/** Put the session away and return to idle. */
function sessionEnd(mine) {
    if (sessionCurrent(mine)) session = null
    recordingSessionStop()
    if (state === STATES.transcribing || state === STATES.error) {
        stateTransition(STATES.idle, "finished")
    }
    menuBarIdle()
}

// MARK: - Chunking settings

/**
 * Set one of the streaming recorder's chunking settings, after checking it.
 *
 * The server is given the settings when a recording starts, so a change applies to the next
 * dictation. It lasts until the configuration is reloaded.
 */
function chunkSettingSet(key, label, seconds, min, max) {
    const value = Number(seconds)
    if (!Number.isFinite(value) || value < min || value > max) {
        notify("config", "warning",
            `${label} must be from ${min} to ${max} seconds, not ${seconds}`)
        return false
    }
    config[key] = value
    notify("config", "info", `${label}: ${value} s`)
    return true
}

/**
 * Set how many seconds of silence end a chunk, `config.streamingSilenceThreshold`.
 *
 * The server starts counting only once two half-second blocks in a row have had no speech,
 * so a pause has to last between half a second and a second longer than this.
 *
 * @param {number} seconds From 0.5 to 30.
 * @returns {boolean} Whether it was accepted.
 */
function silenceThresholdSet(seconds) {
    return chunkSettingSet("streamingSilenceThreshold", "Silence that ends a chunk",
        seconds, 0.5, 30)
}

/**
 * Set the shortest a chunk can be, `config.streamingMinChunkDuration`. A pause before a chunk
 * is this long does not end it.
 *
 * @param {number} seconds From 0 to `config.streamingMaxChunkDuration`.
 * @returns {boolean} Whether it was accepted.
 */
function minChunkDurationSet(seconds) {
    return chunkSettingSet("streamingMinChunkDuration", "Shortest chunk",
        seconds, 0, config.streamingMaxChunkDuration)
}

/** Menu entries for each preset, and for the current value when it is not one of them. */
function chunkSettingMenu(presets, current, set, enabled) {
    const values = presets.includes(current)
        ? presets
        : presets.concat([current]).sort((a, b) => a - b)
    return values.map((value) => ({
        title: `${value} s`,
        checked: value === current,
        disabled: !enabled,
        fn: () => set(value)
    }))
}

// MARK: - Pasting

/**
 * Whether a dictation started now would paste each chunk as soon as it is ready.
 *
 * Only the streaming recorder produces more than one chunk, and only a dictation that
 * pastes has anywhere to put them. A filter rules it out because it runs over the whole text.
 */
function chunkInsertApplies() {
    return config.streamingChunkInsert && shouldPaste && !userCallback &&
        !!recorder && recorder.name === "streaming" && filterGet() === null
}

/**
 * Turn pasting each chunk as soon as it is ready on or off. It sets
 * `config.streamingChunkInsert`, so the change lasts until the configuration is reloaded.
 * A dictation already in progress keeps the setting it started with.
 *
 * @param {boolean} enable
 */
function chunkInsertSet(enable) {
    config.streamingChunkInsert = !!enable
    notify("config", "info",
        `Paste each chunk as it is ready: ${config.streamingChunkInsert ? "on" : "off"}`)
    return module.exports
}

function chunkInsertToggle() {
    return chunkInsertSet(!config.streamingChunkInsert)
}

function pasteKeystroke() {
    activityCounts.ownKeys += 1
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
        const movedOn = activityMovedOn()
        if (movedOn) {
            notify("transcription", "warning",
                `Not pasting: ${movedOn}. The text is on the clipboard — paste it with ⌘V.`)
            return
        }
        if (!sameAppFocused()) {
            notify("transcription", "warning",
                "Not pasting: the frontmost application changed while recording. " +
                "The text is on the clipboard — paste it with ⌘V.")
            return
        }
    }

    hs.timer.doAfter(config.autoPasteDelay, () => {
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
 * The input device the next recording will use, as text for the menu and messages.
 *
 * Both recorders choose the device for each recording, so this is always current.
 */
function inputDeviceDescribe() {
    const streaming = recorder && recorder.name === "streaming"
    const configured = streaming
        ? config.streamingAudioInputDevice
        : config.soxAudioInputDevice
    const chosen = inputDeviceChoose(configured)

    const standard = hs.audiodevice.defaultInputDevice()
    if (!chosen) return standard ? `${standard.name} (system default)` : "unknown"

    // Chosen by name, so there is nothing to explain.
    if (chosen === inputDeviceSelected || chosen === configured) return chosen
    if (!standard || standard.name === chosen) return chosen

    // Say why the default input is not being used, so that it does not look like a mistake.
    if (standard.transportType === "bluetooth") {
        return `${chosen} (the default, ${standard.name}, is Bluetooth)`
    }
    return chosen
}

/**
 * The name of the input device to record from, or null for the system default.
 *
 * A device chosen from the menu comes first, as long as it is still connected. Then a device
 * named in the configuration. Otherwise it is the system default,
 * unless that is a Bluetooth device and `bluetoothInputAvoid` is set, in which case it is
 * the built-in microphone. While anything records from the microphone of a Bluetooth
 * headset such as AirPods, the headset switches from its playback profile (A2DP) to its
 * headset profile (HFP), and sound playing through it stops. Measured on 2026-10-14: with
 * the AirPods as the default input, starting the streaming server stopped the sound in
 * them, recording with sox did the same, and the sound came back when sox finished.
 *
 * @param {?string} configured The device configured for the recorder in use.
 * @returns {?string}
 */
function inputDeviceChoose(configured) {
    if (inputDeviceSelected) {
        const connected = hs.audiodevice.allInputDevices()
            .some((device) => device.name === inputDeviceSelected)
        if (connected) return inputDeviceSelected
        logDebug(`${inputDeviceSelected} is not connected; choosing automatically`)
    }
    if (configured) return configured
    if (!config.bluetoothInputAvoid) return null

    const standard = hs.audiodevice.defaultInputDevice()
    if (!standard || standard.transportType !== "bluetooth") return null

    const builtIn = hs.audiodevice.allInputDevices()
        .find((device) => device.transportType === "built-in")
    if (!builtIn) {
        // A Mac with no microphone of its own, so the headset's microphone is the only
        // one available.
        logDebug(`${standard.name} is the only input; recording from it`)
        return null
    }
    logDebug(`the default input ${standard.name} is Bluetooth; recording from ${builtIn.name}`)
    return builtIn.name
}

/**
 * Record from the named input device, or choose automatically when `name` is null.
 *
 * Takes effect from the next recording; both recorders are given the device each time.
 * Refused during a dictation, so that what the menu shows is what is being recorded.
 *
 * @param {?string} name The device's name, as hs.audiodevice reports it.
 * @returns {boolean} Whether the choice was made.
 */
function inputDeviceSet(name) {
    if (state !== STATES.idle) {
        notify("config", "warning", "The microphone cannot be changed during a dictation")
        return false
    }
    if (name !== null && !hs.audiodevice.allInputDevices().some((d) => d.name === name)) {
        notify("config", "warning", `No input device is called ${name}`)
        return false
    }
    inputDeviceSelected = name
    notify("config", "info", `Microphone: ${name ?? "automatic"}`)
    return true
}

/**
 * Restart the streaming server through launchd, and connect to the new one.
 *
 * For a server that has got stuck. It is not needed to change the microphone, which each
 * recording names for itself.
 */
async function serverRestart(why) {
    if (!recorder || recorder.name !== "streaming") {
        return "The streaming recorder is not in use, so there is no server to restart"
    }
    if (state !== STATES.idle) {
        return "The streaming server cannot be restarted during a dictation"
    }

    notify("init", "info", `Restarting the streaming server (${why})`)
    const failed = await recorders.streaming.restart()
    if (failed) {
        notify("init", "error", `Could not restart the streaming server: ${failed}`)
        return failed
    }
    notify("init", "info", "The streaming server restarted")
    return null
}

// MARK: - Language

/** The languages that can be chosen: `config.languages`, followed by "auto". */
function languagesOffered() {
    return config.languages.includes(LANGUAGE_AUTO)
        ? config.languages
        : config.languages.concat([LANGUAGE_AUTO])
}

/** The language transcription is being asked for, which may be "auto". */
function languageGet() {
    return languagesOffered()[langIndex]
}

/**
 * The language the text comes out in: English when translating, otherwise the language
 * spoken, which is "auto" when it was left to Whisper to detect.
 */
function languageOutput(lang, translate) {
    return translate ? "en" : lang
}

/** The language for the menu bar and notifications, as "ja" or, when translating, "ja→en". */
function languageLabel(lang, translate) {
    return translate && lang !== "en" ? `${lang}→en` : lang
}

/**
 * Choose a language by code. It has to be one of `config.languages`, or "auto".
 *
 * @param {string} lang A language code, as "en".
 * @returns {boolean} Whether it was recognised.
 */
function languageSet(lang) {
    const found = languagesOffered().indexOf(lang)
    if (found === -1) {
        notify("config", "warning", `Not a configured language: ${lang}. ` +
            `Configured: ${languagesOffered().join(", ")}`)
        return false
    }
    langIndex = found
    notify("config", "info", `${icons.language} Language: ${lang}`)
    menuBarIdle()
    return true
}

/** Move to the next configured language, wrapping round. "auto" comes last. */
function languageNext() {
    const offered = languagesOffered()
    languageSet(offered[(langIndex + 1) % offered.length])
    return module.exports
}

/** Offer the configured languages, and "auto". */
function languageSelect() {
    const choices = languagesOffered().map((lang, i) => ({
        text: lang,
        subText: i === langIndex ? "✓ Selected" : "",
        lang: lang
    }))

    const languageChooser = hs.chooser.create()
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

/**
 * Translate into English, or transcribe in the language spoken. Applies from the next
 * dictation, so it is refused during one, as the menu refuses it.
 *
 * @param {boolean} enable True to translate into English.
 */
function translateSet(enable) {
    if (state !== STATES.idle) {
        notify("config", "warning", "Translation can be changed only between dictations")
        return module.exports
    }
    config.translate = !!enable
    notify("config", "info", config.translate
        ? `${icons.language} Output: English (translated)`
        : `${icons.language} Output: the language spoken`)
    const warning = translateModelWarning()
    if (warning) notify("config", "warning", warning)
    menuBarIdle()
    return module.exports
}

function translateToggle() {
    return translateSet(!config.translate)
}

/**
 * Why translation will probably not work with the transcriber in use, or null.
 *
 * The turbo models were fine-tuned without translation data, so asked to translate they
 * often return the spoken language unchanged. Only whisper.cpp's model files are checked,
 * through any symbolic link, because the file name is all there is to go on.
 */
function translateModelWarning() {
    if (!config.translate || !transcriber) return null
    const modelPath = transcriber.name === "whisperserver" ? config.whisperserverModelPath
        : transcriber.name === "whispercli" ? config.whispercliModelPath
        : config.whisperkitModel
    if (!modelPath) return null
    const resolved = hs.fs.pathToAbsolute(modelPath) || modelPath
    if (!/turbo/i.test(resolved)) return null
    return `${resolved.split("/").pop()} is a turbo model, which was not trained to ` +
        "translate. It will often return the language spoken instead of English."
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
 * @param {function|boolean|string} [callbackOrPaste] A function to be given the
 *        transcription instead of the clipboard, true to paste the text where the cursor
 *        is, or "processor" to hand it to the selected processor; see
 *        transcribeToProcessorToggle().
 * @param {object} [options] Settings for this dictation only, leaving the selected ones
 *        alone: `lang`, a language code or "auto", and `translate`, true to translate into
 *        English. Each defaults to the one selected.
 */
async function transcribeBegin(callbackOrPaste, options = {}) {
    if (!backendsReady()) return module.exports

    if (state === STATES.error) stateTransition(STATES.idle, "recovering")
    if (state !== STATES.idle) {
        notify("recording", "warning", `Already busy (${state})`)
        return module.exports
    }

    if (callbackOrPaste === "processor" && !processorActive()) {
        notify("config", "warning", "No processor is configured; see config.processors")
        return module.exports
    }

    const toProcessor = callbackOrPaste === "processor"
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
    // amplitude. The streaming server records in a process of its own, launchd's rather
    // than Hammerspoon's, so this permission is not the one it needs; it reports its own.
    if (recorder && recorder.name !== "streaming" && !hs.permissions.checkMicrophone()) {
        notify("recording", "error",
            "Hammerspoon 2 does not have microphone permission, so a recording would be " +
            "silent. Grant it in System Settings → Privacy & Security → Microphone.")
        hs.permissions.requestMicrophone()
        return module.exports
    }

    if (!dirEnsure(config.tempDir)) return module.exports

    const mine = sessionNew(options.lang ?? languageGet(),
        options.translate ?? config.translate)
    sessionDeliveryChoose(mine, toProcessor)
    session = mine
    if (!stateTransition(STATES.recording, "starting to record")) {
        session = null
        return module.exports
    }

    // Not awaited: the model gets ready while the microphone opens and you speak.
    if (transcriber.warm) transcriber.warm()

    try {
        await recorder.start(mine,
            (file, num, isFinal, peak, speech) =>
                chunkReceived(mine, file, num, isFinal, peak, speech ?? null))
    } catch (e) {
        session = null
        stateTransition(STATES.error, "the recorder would not start")
        stateTransition(STATES.idle, "recovering")
        menuBarIdle()
        notify("recording", "error", `Could not start recording: ${e.message}`)
        return module.exports
    }

    if (!sessionCurrent(mine)) return module.exports

    const abbrev = abbrevShown()
    notify("recording", "info",
        `${icons.recording} Recording (${languageLabel(mine.lang, mine.translate)})` +
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
    menuBarTranscribing(languageLabel(mine.lang, mine.translate))

    try {
        await recorder.stop(mine,
            (file, num, isFinal, peak, speech) =>
                chunkReceived(mine, file, num, isFinal, peak, speech ?? null))
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
 * @param {object} [options] As transcribeBegin(). Used only when a recording starts.
 */
function transcribeToggle(callbackOrPaste, options) {
    if (state === STATES.idle || state === STATES.error) {
        transcribeBegin(callbackOrPaste, options)
    }
    else if (state === STATES.recording) transcribeEnd()
    else notify("recording", "warning", `Busy transcribing — wait or abort`)
    return module.exports
}

/**
 * Start a dictation that goes to the selected processor, or stop the one in progress.
 *
 * The text is not pasted or copied. It is handed to the processor chosen with
 * processorSelect() or processorSet(), which is the first in config.processors until
 * another is chosen. The processor is fixed when the dictation starts.
 */
function transcribeToProcessorToggle() {
    return transcribeToggle("processor")
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
    const translate = config.translate
    const label = languageLabel(lang, translate)
    const app = hs.window.focusedWindow() ? hs.window.focusedWindow().application : null

    notify("transcription", "info", `Transcribing again with ${using.name} (${label})…`)
    menuBarSet(`${icons.transcribing} (${label})`, `Transcribing again with ${using.name}`)

    let text
    try {
        text = await using.transcribe(audioFile, lang, translate)
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
        hs.timer.doAfter(config.autoPasteDelay, () => {
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

    const recordingChooser = hs.chooser.create()
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
 * The streaming server's own log is ~/Library/Logs/whisper-stream.log; for audio levels
 * there, add --verbose to its LaunchAgent.
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
    say(`language: ${languageGet()} (${langIndex + 1} of ${languagesOffered().length}: ` +
        `${languagesOffered().join(", ")})`)
    say(`output: ${config.translate ? "English (translated)" : "the language spoken"}`)
    const translateWarning = translateModelWarning()
    if (translateWarning) say(translateWarning)
    say(`configured: recorder=${config.recorder} transcriber=${config.transcriber}`)
    say(`in use: recorder=${recorder ? recorder.name : "none"} ` +
        `transcriber=${transcriber ? transcriber.name : "none"}`)

    const filter = filterActive()
    say(`filter: ${filter ? filter.name : "none"} (${config.filters.length} configured)`)
    const processor = processorActive()
    say(`processor: ${processor ? processor.name : "none"} ` +
        `(${config.processors.length} configured)`)
    say(`chunking: ${config.streamingSilenceThreshold} s of silence ends a chunk, ` +
        `shortest ${config.streamingMinChunkDuration} s, longest ` +
        `${config.streamingMaxChunkDuration} s`)
    say(`paste each chunk as it is ready: ${config.streamingChunkInsert ? "on" : "off"}` +
        (config.streamingChunkInsert && filter ? " (but not while a filter is active)" : ""))

    if (session) {
        say(`session: ${session.prefix} chunks=${session.chunks.length} ` +
            `done=${session.results.size} failed=${session.failures.length} ` +
            `recorderDone=${session.recorderDone}`)
    } else {
        say("session: none")
    }

    if (recorder && recorder.name === "streaming") {
        const streaming = recorders.streaming
        say(`streaming server: ${config.streamingUrl} ` +
            (streaming.connected ? "connected" : "not connected") +
            ` (LaunchAgent ${config.streamingLaunchAgent})`)
        if (streaming.status) {
            say(`  recording=${streaming.status.recording} ` +
                `microphone_open=${streaming.status.microphone_open} ` +
                `device=${streaming.status.device || "(system default)"}`)
        }
        say(`  next recording's device: ${inputDeviceDescribe()}`)
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
    // Running tasks and pending one-shot timers, from every Spoon and not only this one.
    // An idle Spoon should leave only the streaming server's task running, so anything
    // else here is something that was not stopped.
    const active = hs.activeObjects().map((obj) => obj.toString())
        .filter((name) => name.startsWith("<HSTask") ||
            (name.startsWith("<HSTimer") && !name.includes("repeating")))
    say(`running tasks and pending timers: ${active.length}`)
    active.forEach((name) => say(`  ${name}`))
    say("--- end ---")
    return module.exports
}

// MARK: - Hotkeys, start and stop

/**
 * Bind keys to this Spoon's actions.
 *
 * @param {object} [mapping] Keyed by action name — any of `transcribeToggle`,
 *        `transcribeToClipboardToggle`, `transcribeToProcessorToggle`, `languageSelect`,
 *        `languageNext`, `filterSelect`, `processorSelect`, `chunkInsertToggle`,
 *        `transcribeAgain`, `transcribeAbort` — each holding `[[modifiers], key]`.
 *        Defaults to `config.defaultKeyBindings`.
 */
function bindHotkeys(mapping) {
    const actions = {
        // Dictating into whatever has focus is the ordinary case, so it has the plain
        // name; the one that goes to the clipboard says so. Both call the same function,
        // which takes where the text should go as its argument.
        transcribeToggle: () => transcribeToggle(true),
        transcribeToClipboardToggle: () => transcribeToggle(false),
        transcribeToProcessorToggle: () => transcribeToProcessorToggle(),
        languageSelect: () => languageSelect(),
        languageNext: () => languageNext(),
        translateToggle: () => translateToggle(),
        filterSelect: () => filterSelect(),
        processorSelect: () => processorSelect(),
        chunkInsertToggle: () => chunkInsertToggle(),
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

    notify("init", "info",
        `hs_whisper-gt ready: ${recorder.name} + ${transcriber.name}`)

    const translateWarning = translateModelWarning()
    if (translateWarning) notify("init", "warning", translateWarning)

    if (recorder.name !== "streaming" && !hs.permissions.checkMicrophone()) {
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

    for (const backend of [recorder, transcriber]) {
        if (backend && backend.cleanup) backend.cleanup()
    }
    recorder = null
    transcriber = null

    if (menuBar) {
        menuBar.destroy()
        menuBar = null
    }

    return module.exports
}

module.exports = {
    config,

    transcribeToggle,
    transcribeToProcessorToggle,
    transcribeBegin,
    transcribeEnd,
    transcribeAbort,
    transcribeAgain,
    recordingTranscribe,

    languageGet,
    languageSet,
    languageSelect,
    languageNext,

    translateSet,
    translateToggle,

    inputDeviceSet,

    filterGet,
    filterSet,
    filterSelect,

    processorGet,
    processorSet,
    processorSelect,

    chunkInsertSet,
    chunkInsertToggle,
    silenceThresholdSet,
    minChunkDurationSet,

    recordingsList,
    recordingsPrune,

    debugSet,
    diagnose,
    serverRestart: () => serverRestart("asked to"),

    isRecording,
    state: () => state,

    bindHotkeys,
    start,
    stop,

    // For tests/live only. Not an interface: these are the Spoon's internals.
    _test: {
        recorders,
        inputDeviceChoose,
        recorder: () => recorder,
        transcriber: () => transcriber,
        menuBuild
    }
}
