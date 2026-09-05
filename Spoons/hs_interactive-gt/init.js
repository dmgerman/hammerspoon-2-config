// hs_interactive-gt — named commands, interactive argument readers, and key bindings by name.
//
// A command is a function a user can invoke directly. A function becomes a command by
// being defined here with a name, a docstring and, when it takes arguments, an
// `interactive` specification stating how each is to be read. The specification applies
// only when a person invokes the command: this layer reads the values, from the current
// state or through a chooser or dialog, so no command contains input handling of its own.
// Called from other code, a command receives its arguments directly and nothing is read.
//
// Keys are bound to command *names*, not to functions, so binding order does not matter,
// a command can be redefined without rebinding, and every binding can be listed and
// reported.
//
//     const interactive = hs.loadSpoon("hs_interactive-gt")
//
//     interactive.define({
//         name: "window-move-left-half",
//         doc:  "Move a window to the left half of its screen.",
//         interactive: [
//             {
//                 name: "window",
//                 reader: interactive.readers.window.auto
//             }
//         ],
//         fn: (win) => { /* ... */ }
//     })
//
//     interactive.setKeys({ "cmd-ctrl-alt left": "window-move-left-half" })
//
// A parameter names the reader variant it uses — `.implicit`, `.prompted` or `.auto` — so
// whether a command prompts is the command's decision, not this layer's. Implicit values
// are read from a snapshot taken when the command is invoked, before any chooser or dialog
// takes focus, so `.auto` returns the window that was focused at that point.

// MARK: - Sentinels

// Returned by a reader when the user dismissed its prompt: the whole command is
// abandoned. Distinct from null, which some readers return as a real value.
const CANCEL = Symbol("cancel")

// Returned by a reader when the user chose to leave the parameter unset: the argument
// is dropped so the command's own default applies.
const SKIP = Symbol("skip")

// MARK: - State

const registry = new Map()          // name -> command spec
const keymap = new Map()            // chord -> {chord, mods, key, command, hotkey}

// How the chooser and commands() order commands: "mru" or "alphabetic".
let order = "mru"

// Use order, as a counter: only the relative order matters, and a counter cannot go
// backwards when the system clock does.
const lastUsed = new Map()          // name -> use number
let useCount = 0

// Choosers and the alerts they raise must outlive the call that created them, or
// JavaScriptCore collects the object and the callback never fires.
let activeChooser = null

// MARK: - Prompt observers
//
// A prompt takes the keyboard, so whatever else is bound to it has to stand down for as
// long as one is up. The on-screen menu binds a hotkey per button, arrow keys among them,
// and a hotkey outranks the chooser's own key handling: without this the arrows would move
// windows while a chooser waits for one to be chosen.
//
// Counted rather than a flag, since a command that reads two parameters shows one chooser
// after another. Observers hear about the first opening and the last closing.
const promptObservers = new Set()
let promptDepth = 0

/**
 * Be told when a prompt appears and when the last one goes away.
 *
 * @param {function} fn Called with true when a prompt opens, false when none is left.
 * @returns {function} Call it to stop being told.
 */
function onPromptChange(fn) {
    promptObservers.add(fn)
    return () => promptObservers.delete(fn)
}

/** Whether a prompt is on screen. */
function promptIsOpen() {
    return promptDepth > 0
}

function promptOpened() {
    promptDepth += 1
    if (promptDepth === 1) notifyPrompt(true)
}

function promptClosed() {
    if (promptDepth === 0) return
    promptDepth -= 1
    if (promptDepth === 0) notifyPrompt(false)
}

function notifyPrompt(open) {
    for (const observer of promptObservers) {
        try {
            observer(open)
        } catch (e) {
            console.error(`[hs_interactive-gt] a prompt observer failed: ${e.message}`)
        }
    }
}

// MARK: - Describing values
//
// Every bridged Hammerspoon type carries `typeName` and a `toString()` of the form
// "<HSScreen: LC49G95T>", so unknown types still render sensibly. Entries here exist
// only where the type's own description reads poorly in a parameter list.

const describers = {
    HSWindow: (w) => `${w.title || "(untitled)"} — ${w.application ? w.application.title : "?"}`,
    HSScreen: (s) => `${s.name} (${s.frame.w}×${s.frame.h})`,
    HSApplication: (a) => a.title
}

/**
 * Render a value for display in a prompt or a command listing.
 *
 * @param {*} value Any value, including bridged Hammerspoon objects.
 * @returns {string} A short human-readable description.
 */
function describe(value) {
    if (value === null) return "null"
    if (value === undefined) return "—"
    if (Array.isArray(value)) return value.map(describe).join(", ")
    if (typeof value === "string") return JSON.stringify(value)
    if (typeof value !== "object") return String(value)

    const typeName = value.typeName
    if (typeName && describers[typeName]) return describers[typeName](value)
    if (typeName) return String(value).replace(/^<[^:]+:\s*/, "").replace(/>$/, "")

    try {
        return JSON.stringify(value)
    } catch (e) {
        return String(value)
    }
}

// MARK: - Prompting
//
// The mapping from a button index to an action is made in this one function.
// hs.ui.textPrompt reports an index into the array given to .buttons(), so labels and
// indices are in the same order. Builds older than cmsj/Hammerspoon2#183 reverse it,
// and exchange accepting for cancelling here.

/**
 * Show a text prompt with OK / Skip / Cancel and report which was chosen.
 *
 * @param {object} options `message`, `context`, `defaultText`, `optional`.
 * @returns {{action: string, text: string}} action is "ok", "skip" or "cancel".
 */
function ask(options) {
    const labels = options.optional ? ["OK", "Skip", "Cancel"] : ["OK", "Cancel"]
    let result = { action: "cancel", text: "" }

    promptOpened()
    try {
        hs.ui.textPrompt(options.message)
            .informativeText(options.context || "")
            .defaultText(options.defaultText === undefined ? "" : String(options.defaultText))
            .buttons(labels)
            .onButton((index, text) => {
                result = { action: (labels[index] || "Cancel").toLowerCase(), text: text }
            })
            .show()
    } finally {
        // show() is modal, so the prompt is gone by the time it returns.
        promptClosed()
    }

    return result
}

/**
 * Show a chooser and resolve to the chosen row's `value`, or to CANCEL / SKIP.
 *
 * @param {object} options `placeholder`, `context`, `choices`, `optional`.
 * @returns {Promise<*>} The selected value.
 */
function pick(options) {
    return new Promise((resolve) => {
        const rows = []
        if (options.optional) rows.push({ text: "(skip — use the default)", skip: true })
        for (const choice of options.choices) rows.push(choice)

        const chooser = hs.chooser.create()
        chooser.placeholder = options.placeholder || "Choose"
        chooser.searchSubText = true
        chooser.setChoices(rows)
        chooser.onSelect = (item) => {
            activeChooser = null
            promptClosed()
            if (!item) resolve(CANCEL)
            else if (item.skip) resolve(SKIP)
            else resolve(item.value)
        }
        activeChooser = chooser
        promptOpened()
        chooser.show()
    })
}

// MARK: - Snapshot
//
// The focused window, frontmost application and current screen at the moment the command
// was invoked. Taken before any prompt appears: a chooser or dialog takes keyboard focus,
// after which hs.window.focusedWindow() returns Hammerspoon's own window.

/**
 * Capture the current window, application and screen.
 *
 * @returns {object} `{window, application, screen}`, any of which may be null.
 */
function snapshot() {
    const window = hs.window.focusedWindow()
    return {
        window: window,
        application: hs.application.frontmost(),
        screen: window ? window.screen : hs.screen.main()
    }
}

// MARK: - Readers
//
// A reader provides up to three ways to obtain a value, and the command selects one:
// `implicit` reads it from the snapshot, `prompted` always prompts, and `auto` prompts
// only when the snapshot value is null. Pass the variant itself: `readers.window.auto`.
//
// Every variant is called as (context, parameter, snapshot).

const readers = {
    window: {
        implicit: (context, parameter, snap) => snap.window,
        auto: (context, parameter, snap) => snap.window || readers.window.prompted(context, parameter, snap),

        /**
         * Choose a window. The parameter may narrow what is offered:
         *
         *   includeCurrent  false leaves out the window the command started on, for a
         *                   command that acts on this window and a second one.
         */
        prompted: (context, parameter, snap) => {
            const current = snap ? snap.window : null
            const wantCurrent = parameter.includeCurrent !== false

            const windows = hs.window.orderedWindows().filter(
                (w) => wantCurrent || !current || w.id !== current.id)

            if (!windows.length) {
                hs.ui.alert("No other window to choose").duration(2).show()
                return CANCEL
            }

            return pick({
                placeholder: "Window",
                context: context,
                optional: parameter.optional,
                // The application name is in `text` as well as `subText`: a window is often
                // easier to name by its application than by its title, and typing matches
                // `text` whatever the chooser's searchSubText setting happens to be.
                choices: windows.map((w) => {
                    const app = w.application ? w.application.title : "?"
                    return {
                        text: `${app} — ${w.title || "(untitled)"}`,
                        subText: `${app}${w.screen ? " · " + w.screen.name : ""}`,
                        value: w
                    }
                })
            })
        }
    },

    application: {
        implicit: (context, parameter, snap) => snap.application,
        auto: (context, parameter, snap) => snap.application || readers.application.prompted(context, parameter, snap),
        prompted: (context, parameter) => pick({
            placeholder: "Application",
            context: context,
            optional: parameter.optional,
            choices: hs.application.runningApplications().map((a) => ({
                text: a.title,
                subText: a.bundleID || "",
                value: a
            }))
        })
    },

    screen: {
        implicit: (context, parameter, snap) => snap.screen,
        auto: (context, parameter, snap) => snap.screen || readers.screen.prompted(context, parameter, snap),

        /**
         * Choose a screen. The parameter may narrow what is offered:
         *
         *   includeCurrent     false leaves out the screen the command started on, for a
         *                      command whose whole purpose is to move somewhere else.
         *   includeFullscreen  false leaves out screens showing a fullscreen window.
         */
        prompted: (context, parameter, snap) => {
            const current = snap ? snap.screen : null
            const wantCurrent = parameter.includeCurrent !== false
            const wantFullscreen = parameter.includeFullscreen !== false

            // Hammerspoon 1 asked hs.spaces for the space type. Hammerspoon 2 has no
            // spaces module, so a screen counts as fullscreen when a window on it is.
            const fullscreen = new Set()
            if (!wantFullscreen) {
                for (const window of hs.window.allWindows()) {
                    if (window.isFullscreen && window.screen) fullscreen.add(window.screen.id)
                }
            }

            const screens = hs.screen.all().filter((s) => {
                if (!wantCurrent && current && s.id === current.id) return false
                if (!wantFullscreen && fullscreen.has(s.id)) return false
                return true
            })

            if (!screens.length) {
                hs.ui.alert("No other screen to move to").duration(2).show()
                return CANCEL
            }

            return pick({
                placeholder: "Screen",
                context: context,
                optional: parameter.optional,
                choices: screens.map((s) => ({
                    text: s.name,
                    subText: `${s.frame.w}×${s.frame.h}`,
                    value: s
                }))
            })
        }
    },

    number: {
        prompted: (context, parameter) => {
            const answer = ask({
                message: parameter.name,
                context: context,
                defaultText: parameter.default,
                optional: parameter.optional
            })
            if (answer.action === "cancel") return CANCEL
            if (answer.action === "skip") return SKIP

            const value = Number(answer.text)
            if (!Number.isFinite(value)) {
                hs.ui.alert(`${parameter.name}: "${answer.text}" is not a number`).duration(2).show()
                return CANCEL
            }
            return value
        }
    },

    string: {
        prompted: (context, parameter) => {
            const answer = ask({
                message: parameter.name,
                context: context,
                defaultText: parameter.default,
                optional: parameter.optional
            })
            if (answer.action === "cancel") return CANCEL
            if (answer.action === "skip") return SKIP
            return answer.text
        }
    }
}

// MARK: - The registry

/**
 * Declare a command.
 *
 * @param {object} spec `name`, `fn`, and optionally `doc` and `interactive`.
 *        Each `interactive` entry is `{name, reader, default, optional}`, where `reader`
 *        is one reader variant — `readers.window.auto`, `readers.number.prompted` — or
 *        any function `(context, parameter, snapshot)`. A bare function is also accepted
 *        in place of the whole entry.
 * @returns {object} The stored command.
 */
function define(spec) {
    if (!spec || typeof spec.name !== "string" || !spec.name) {
        throw new Error("hs_interactive-gt: define() needs a name")
    }
    if (typeof spec.fn !== "function") {
        throw new Error(`hs_interactive-gt: define(${spec.name}) needs an fn`)
    }

    const command = {
        name: spec.name,
        doc: spec.doc || "",
        fn: spec.fn,
        parameters: (spec.interactive || []).map((entry, index) => {
            if (typeof entry === "function") return { name: `arg${index + 1}`, reader: { prompted: entry } }
            return {
                name: entry.name || `arg${index + 1}`,
                reader: entry.reader || {},
                default: entry.default,
                optional: entry.optional === true
            }
        })
    }

    // A repeated definition replaces the previous one, so a config can be reloaded.
    registry.set(command.name, command)
    return command
}

/**
 * Set how commands are ordered in the chooser and in `commands()`.
 *
 * @param {string} newOrder `"mru"` — most recently used first, commands never used
 *        sorted by name after them — or `"alphabetic"`.
 */
function setOrder(newOrder) {
    if (newOrder !== "mru" && newOrder !== "alphabetic") {
        throw new Error(`hs_interactive-gt: order must be "mru" or "alphabetic", not "${newOrder}"`)
    }
    order = newOrder
    return module.exports
}

/** The current ordering, `"mru"` or `"alphabetic"`. */
function getOrder() {
    return order
}

// Records that a command was run by name, so "mru" has something to sort by. Commands
// run from a key are not recorded: they are already one keypress away.
function noteUse(name) {
    useCount += 1
    lastUsed.set(name, useCount)
}

/**
 * All commands, in the configured order.
 *
 * @param {string} [how] `"mru"` or `"alphabetic"`, overriding the configured order.
 * @returns {object[]} The commands.
 */
function commands(how) {
    const byName = (a, b) => a.name.localeCompare(b.name)
    const list = [...registry.values()]

    if ((how || order) === "alphabetic") return list.sort(byName)

    return list.sort((a, b) => {
        const usedA = lastUsed.get(a.name)
        const usedB = lastUsed.get(b.name)
        if (usedA && usedB) return usedB - usedA      // higher use number is more recent
        if (usedA) return -1
        if (usedB) return 1
        return byName(a, b)                           // never used: by name
    })
}

/** Look up one command, or undefined. */
function get(name) {
    return registry.get(name)
}

/**
 * Call a command directly with explicit arguments. No prompting.
 *
 * @param {string} name The command name.
 * @param {...*} args Arguments passed straight to the command's `fn`.
 */
function call(name, ...args) {
    const command = registry.get(name)
    if (!command) throw new Error(`hs_interactive-gt: no such command: ${name}`)
    noteUse(name)
    return command.fn(...args)
}

// A parameter's reader is one variant, such as readers.window.auto, so which of them
// runs is the command's decision and never this layer's.
function readerFor(parameter) {
    const reader = parameter.reader
    if (typeof reader === "function") return reader
    if (!reader) return null
    throw new Error(
        `hs_interactive-gt: parameter "${parameter.name}" was given a reader object; ` +
        `choose a variant, e.g. readers.window.auto, .implicit or .prompted`
    )
}

// The parameter table shown in each prompt: what has been collected so far, where each
// value came from, and which parameter is being asked for now.
function contextFor(command, values, sources, current) {
    const lines = [`${command.name} · argument ${current + 1} of ${command.parameters.length}`]
    if (command.doc) lines.push(command.doc)
    lines.push("")

    command.parameters.forEach((parameter, index) => {
        const marker = index === current ? "▸" : " "
        const value = index === current ? "?"
            : (index in values ? describe(values[index]) : describe(parameter.default))
        const source = sources[index] ? `  (${sources[index]})` : ""
        lines.push(`${marker} ${parameter.name} = ${value}${source}`)
    })

    return lines.join("\n")
}

/**
 * Invoke a command, obtaining any missing arguments through its readers.
 *
 * Readers run in declaration order against a snapshot of what was current when the
 * command was invoked, so a reader that runs after a prompt still sees the window you
 * started from. A cancelled prompt abandons the whole command.
 *
 * @param {string} name The command name.
 * @param {object} [options] `args` already supplied, `snapshot` if one was taken before
 *        this call — as `execute()` does before opening its chooser — and `via`, which
 *        is `"key"` when a hotkey triggered this. Only invocations by name count towards
 *        the recently-used order.
 * @returns {Promise<*>} Whatever the command returned, or undefined if cancelled.
 */
async function callInteractively(name, options) {
    const command = registry.get(name)
    if (!command) {
        console.error(`[hs_interactive-gt] no such command: ${name}`)
        return
    }

    const given = (options && options.args) || []
    const snap = (options && options.snapshot) || snapshot()
    const values = []
    const sources = []

    for (let index = 0; index < command.parameters.length; index++) {
        const parameter = command.parameters[index]

        if (index < given.length && given[index] !== undefined) {
            values[index] = given[index]
            sources[index] = "given"
            continue
        }

        let read
        try {
            read = readerFor(parameter)
        } catch (e) {
            console.error(`[hs_interactive-gt] ${command.name}: ${e.message}`)
            return
        }
        if (!read) {
            values[index] = parameter.default
            sources[index] = "default"
            continue
        }

        const context = contextFor(command, values, sources, index)
        const value = await read(context, parameter, snap)

        if (value === CANCEL) {
            console.log(`[hs_interactive-gt] ${command.name}: cancelled`)
            return
        }
        if (value === SKIP) {
            values[index] = parameter.default
            sources[index] = "skipped"
            continue
        }
        if (value === null || value === undefined) {
            values[index] = parameter.default
            sources[index] = "default"
            continue
        }
        values[index] = value
        sources[index] = "entered"
    }

    // Trailing holes are dropped so the function's own defaults apply.
    const args = []
    for (let i = 0; i < command.parameters.length; i++) args[i] = values[i]
    while (args.length > 0 && args[args.length - 1] === undefined) args.pop()

    // Noted only once every argument is in hand — a command abandoned at a prompt has not
    // been used — and only when invoked by name. A key press does not promote a command,
    // the way Emacs records extended-command-history for M-x but not for a binding.
    if (!options || options.via !== "key") noteUse(command.name)

    try {
        return command.fn(...args)
    } catch (e) {
        console.error(`[hs_interactive-gt] ${command.name} threw: ${e.message}`)
    }
}

/** Show the command chooser — the M-x equivalent. */
function execute() {
    // Taken before the chooser appears and handed to the command that gets chosen, so
    // "the focused window" still means the window you were in, not this chooser.
    const snap = snapshot()

    const chooser = hs.chooser.create()
    chooser.placeholder = "M-x"
    chooser.searchSubText = true
    chooser.setChoices(commands().map((command) => ({
        text: command.name,
        subText: command.doc || whereIs(command.name).join(", ")
    })))
    chooser.onSelect = (item) => {
        activeChooser = null
        try {
            // Before this chooser is counted out, so that a command which prompts in turn
            // keeps the count above zero and observers see one prompt throughout.
            if (item) callInteractively(item.text, { snapshot: snap })
        } finally {
            promptClosed()
        }
    }
    activeChooser = chooser
    promptOpened()
    chooser.show()
}

// MARK: - Keys

/**
 * Parse a chord such as "cmd-ctrl-alt t" or "cmd-alt-x" into modifiers and a key.
 *
 * @param {string} chord The chord description.
 * @returns {{mods: string[], key: string}} Parsed chord.
 */
function parseChord(chord) {
    const text = String(chord).trim()
    if (!text) throw new Error("hs_interactive-gt: empty chord")

    let parts
    if (/\s/.test(text)) {
        // "cmd-ctrl-alt t" — modifiers joined by dashes, key last.
        const tokens = text.split(/\s+/)
        const key = tokens.pop()
        parts = tokens.join("-").split("-").filter(Boolean).concat([key])
    } else {
        parts = text.split("-").filter(Boolean)
        if (parts.length === 0) parts = ["-"]           // the "-" key itself
    }

    const key = parts.pop()
    const mods = parts.map((m) => m.toLowerCase())

    const knownMods = hs.hotkey.getModifierMap()
    const knownKeys = hs.hotkey.getKeyCodeMap()
    for (const mod of mods) {
        if (!(mod in knownMods)) throw new Error(`hs_interactive-gt: unknown modifier "${mod}" in "${chord}"`)
    }
    if (!(key.toLowerCase() in knownKeys) && key.length !== 1) {
        throw new Error(`hs_interactive-gt: unknown key "${key}" in "${chord}"`)
    }

    return { mods, key }
}

/**
 * Bind one chord to a command name, replacing any binding already on that chord.
 *
 * @param {string} chord e.g. "cmd-ctrl-alt t".
 * @param {string} name The command to run. It need not be defined yet.
 * @returns {object|null} The binding record, or null if the chord could not be bound.
 */
function setKey(chord, name) {
    const { mods, key } = parseChord(chord)

    const existing = keymap.get(chord)
    if (existing) {
        existing.hotkey.destroy()
        keymap.delete(chord)
    }

    const hotkey = hs.hotkey.bind(mods, key, () => { callInteractively(name, { via: "key" }) }, null)
    if (!hotkey) {
        console.error(`[hs_interactive-gt] could not bind ${chord} — already taken by another application?`)
        return null
    }

    // The map owns the hotkey: nothing else holds it, and an unheld hotkey is collected.
    const binding = { chord, mods, key, command: name, hotkey }
    keymap.set(chord, binding)
    return binding
}

/**
 * Bind several chords at once.
 *
 * @param {object} table Chord to command name.
 */
function setKeys(table) {
    for (const [chord, name] of Object.entries(table)) setKey(chord, name)
    return module.exports
}

/** Remove the binding on a chord. */
function unsetKey(chord) {
    const binding = keymap.get(chord)
    if (!binding) return false
    binding.hotkey.destroy()
    keymap.delete(chord)
    return true
}

/** Every chord bound to a command name. */
function whereIs(name) {
    return [...keymap.values()].filter((b) => b.command === name).map((b) => b.chord)
}

/** What a chord runs, as `{chord, command, doc}`, or null. */
function describeKey(chord) {
    const binding = keymap.get(chord)
    if (!binding) return null
    const command = registry.get(binding.command)
    return { chord: binding.chord, command: binding.command, doc: command ? command.doc : "(not defined)" }
}

/** All bindings, sorted by chord. */
function bindings() {
    return [...keymap.values()]
        .map((b) => ({ chord: b.chord, command: b.command }))
        .sort((a, b) => a.chord.localeCompare(b.chord))
}

// MARK: - Loading Spoons
//
// One `use()` call per Spoon, in the order they should load, following the form of Emacs's
// use-package. Each call loads one Spoon and applies its settings, commands and keys;
// there is no separate table for a loader to read. A call that fails logs the error and
// the calls after it still run.

const useRecords = []       // {name, state, ms, error}

function record(name, state, ms, error) {
    useRecords.push({ name, state, ms, error: error || null })
    return state
}

// MARK: - Where Spoons are found
//
// hs.loadSpoon() reads from one directory, Spoons/, and registers what it loads in
// hs.spoons under the exact string it was given. searchPath names directories relative to
// the configuration directory, so that Spoons can be kept in more than one — those meant
// for anyone apart from those written for one machine, say. Directories other than Spoons/
// are addressed by a path relative to it, and the Spoon is then re-registered under its
// bare name, so that a Spoon reading hs.spoons["hs_menu-gt"] resolves it from any of them.

/**
 * Directories holding Spoons, relative to the configuration directory, in search order.
 *
 * Only `Spoons/` by default, which is where Hammerspoon 2 itself looks. Which further
 * directories exist, and what they are called, is the configuration's to decide, so
 * `init.js` adds them:
 *
 *     interactive.searchPath.push("dmgSpoons")
 */
const searchPath = ["Spoons"]

/**
 * Load a Spoon by name, from the first directory in `searchPath` that holds it.
 *
 * A name containing a "/" is taken as a path relative to `Spoons/` and used as given, for
 * a Spoon somewhere the search path does not name.
 *
 * @param {string} name The Spoon's directory name.
 * @returns {object} The Spoon, also registered as `hs.spoons[name]`.
 * @throws If no directory in `searchPath` holds a Spoon of that name.
 */
function loadSpoon(name) {
    if (name.includes("/")) return hs.loadSpoon(name)

    // Read through the export, so that init.js can either add to searchPath or replace it
    // outright. Reading the local const would honour only the first.
    const directories = module.exports.searchPath || searchPath

    for (const directory of directories) {
        if (!hs.fs.isDirectory(`${hs.appinfo.configDir}/${directory}/${name}`)) continue

        // hs.loadSpoon() resolves its argument against Spoons/, so every other directory
        // is named by a path relative to Spoons/.
        const path = directory === "Spoons" ? name : `../${directory}/${name}`

        // Not wrapped in try: a Spoon that is present but throws while loading is an error
        // to report, not a reason to continue searching and then report it as missing.
        const spoon = hs.loadSpoon(path)

        if (path !== name) {
            hs.spoons[name] = spoon
            delete hs.spoons[path]
        }
        return spoon
    }

    throw new Error(`no Spoon named ${name} in ${directories.join(", ")}`)
}

/**
 * Load and configure a Spoon.
 *
 * @param {string} name The Spoon's directory name, looked for in each `searchPath` entry.
 * @param {object} [spec] Any of:
 *        `disabled` — skip it, keeping the form;
 *        `when` — a predicate; the Spoon loads only if it returns true;
 *        `before` — run before loading;
 *        `config` — merged onto the Spoon's own `config` object;
 *        `after` — `(spoon)`, for wiring one Spoon to another;
 *        `commands` — `(commands, spoon)`, to define named commands;
 *        `keys` — a chord-to-command-name table, bound through `setKeys`;
 *        `start` — pass false to skip the Spoon's `start()`.
 * @returns {object|null} The Spoon, or null if it was skipped or failed.
 */
function use(name, spec) {
    const options = spec || {}
    const started = Date.now()

    if (options.disabled) {
        record(name, "disabled", 0)
        return null
    }
    if (options.when && !options.when()) {
        record(name, "skipped", Date.now() - started)
        return null
    }

    try {
        if (options.before) options.before()

        const spoon = loadSpoon(name)

        if (options.config && spoon.config) Object.assign(spoon.config, options.config)
        if (options.after) options.after(spoon)
        if (options.commands) options.commands(module.exports, spoon)
        if (options.keys) setKeys(options.keys)
        if (options.start !== false && typeof spoon.start === "function") spoon.start()

        record(name, "loaded", Date.now() - started)
        return spoon
    } catch (e) {
        record(name, "failed", Date.now() - started, e.message)
        console.error(`[hs_interactive-gt] use(${name}) failed: ${e.message}`)
        return null
    }
}

/**
 * Load a plain JavaScript file the same way, for configuration that is not a Spoon.
 *
 * @param {string} path Passed to `require()`, so relative paths resolve from the caller.
 * @param {object} [spec] `disabled`, `when` and `after` behave as in `use()`.
 * @returns {*} Whatever the file exported, or null if it was skipped or failed.
 */
use.file = function (path, spec) {
    const options = spec || {}
    const started = Date.now()

    if (options.disabled) {
        record(path, "disabled", 0)
        return null
    }
    if (options.when && !options.when()) {
        record(path, "skipped", Date.now() - started)
        return null
    }

    try {
        const contents = require(path)
        if (options.after) options.after(contents)
        record(path, "loaded", Date.now() - started)
        return contents
    } catch (e) {
        record(path, "failed", Date.now() - started, e.message)
        console.error(`[hs_interactive-gt] use.file(${path}) failed: ${e.message}`)
        return null
    }
}

/** What every `use()` form did, as `{name, state, ms, error}` records. */
use.status = function () {
    return useRecords.map((r) => ({ ...r }))
}

/** Log what each `use()` form did, and a one-line summary. Call at the end of init.js. */
use.report = function () {
    const counts = { loaded: 0, disabled: 0, skipped: 0, failed: 0 }
    let total = 0

    for (const r of useRecords) {
        counts[r.state] += 1
        total += r.ms
        const timing = r.state === "loaded" ? `${r.ms} ms` : ""
        console.log(`[use] ${r.name.padEnd(20)} ${r.state.padEnd(9)} ${timing}${r.error ? r.error : ""}`)
    }

    console.log(`[use] ${counts.loaded} loaded, ${counts.disabled} disabled, ` +
                `${counts.skipped} skipped, ${counts.failed} failed, in ${total} ms`)
    return counts
}

// MARK: - Spoon lifecycle

function init() {
    // init() runs on every hs.loadSpoon(), so these are re-registered after a reload.
    // The file's top level runs only once, because require() caches it.
    define({
        name: "commands-execute",
        doc: "Choose a command by name and run it (M-x).",
        fn: () => execute()
    })

    define({
        name: "commands-describe-key",
        doc: "Report which command a chord runs.",
        interactive: [{ name: "chord", reader: readers.string.prompted }],
        fn: (chord) => {
            const found = describeKey(chord)
            hs.ui.alert(found ? `${found.chord} runs ${found.command}` : `${chord} is not bound`)
                .duration(3).show()
        }
    })

    define({
        name: "commands-set-order",
        doc: "Choose how the command chooser orders commands.",
        interactive: [{
            name: "order",
            reader: (context) => pick({
                placeholder: "Order",
                context: context,
                choices: [
                    { text: "mru", subText: "most recently used first", value: "mru" },
                    { text: "alphabetic", subText: "by name", value: "alphabetic" }
                ]
            })
        }],
        fn: (newOrder) => {
            setOrder(newOrder)
            hs.ui.alert(`Commands ordered ${newOrder === "mru" ? "by recent use" : "by name"}`)
                .duration(2).show()
            return newOrder
        }
    })

    define({
        name: "spoons-list",
        doc: "Log what each use() form loaded, skipped or failed to load.",
        fn: () => use.report()
    })

    define({
        name: "commands-list-bindings",
        doc: "Log every key binding and the command it runs.",
        fn: () => {
            for (const b of bindings()) console.log(`[hs_interactive-gt] ${b.chord}  ${b.command}`)
            return bindings().length
        }
    })
}

/** Destroy every binding this layer owns. Commands stay defined. */
function stop() {
    for (const binding of keymap.values()) binding.hotkey.destroy()
    keymap.clear()
    activeChooser = null

    // Whoever was listening is going away with this layer, and a prompt cannot survive it.
    if (promptDepth > 0) {
        promptDepth = 0
        notifyPrompt(false)
    }
    promptObservers.clear()
    return module.exports
}

module.exports = {
    CANCEL,
    SKIP,
    use,
    loadSpoon,
    searchPath,
    readers,
    describe,
    define,
    commands,
    setOrder,
    getOrder,
    get,
    call,
    callInteractively,
    execute,
    onPromptChange,
    promptIsOpen,
    parseChord,
    setKey,
    setKeys,
    unsetKey,
    whereIs,
    describeKey,
    bindings,
    init,
    stop
}
