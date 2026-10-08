// hs_keyboard-gt — switch keyboard layouts and input methods from the keyboard.
//
// macOS switches input sources with ⌃Space, which cycles: reaching a particular one means
// pressing it as many times as it takes, and which one you land on depends on where you
// started. This Spoon names them instead, so one key goes to one input source.
//
//     const keyboard = hs.loadSpoon("hs_keyboard-gt")
//     keyboard.methodToggle()        // between the default layout and the input method
//     keyboard.kanaToggle()          // between Hiragana and Katakana
//     keyboard.layoutDefault()       // back to the default layout
//     keyboard.layoutSet("British")
//     keyboard.methodSet("Hiragana")
//     keyboard.current()             // what is active now
//
// A port of the input method functions in the Hammerspoon 1 hs_annoyances Spoon —
// setInputMethod() and toggle_jp(), here methodToggle() and kanaToggle(). select() is the
// one addition: version 1 had no chooser.
//
// ## Layouts and input methods are different things
//
// A *layout* maps keys to characters: U.S., Canadian, British. An *input method* composes
// characters as you type, which is how Japanese, Chinese and Korean are entered. macOS
// keeps them in one list and ⌃Space cycles through both, but they are selected by
// different calls — hs.keycodes.setLayout() and hs.keycodes.setMethod() — and a name
// given to the wrong one is simply not found.
//
// They are also active at the same time. With Hiragana selected, hs.keycodes.currentLayout()
// still reports "Canadian": that is the layout underneath the input method, and it is what
// decides which key produces which romaji. So the question "am I typing Japanese?" is
// answered by currentMethod(), which is null when no input method is active, and never by
// currentLayout().
//
// Version 1 asked currentLayout() and compared it against the default layout, which worked
// there and does not work here: currentLayout() returns the default layout whether or not
// an input method is on top of it, so the test is always true and the toggle only ever
// goes one way. methodToggle() below asks currentMethod().
//
// ## Only enabled sources can be selected
//
// hs.keycodes lists and selects the input sources enabled in System Settings → Keyboard →
// Input Sources. A layout macOS knows about but which is not in that list cannot be
// switched to, and setLayout() returns false. Every setter here reports that case by
// naming what is enabled, because the alternative — nothing happening — reads as the key
// not being bound.

// MARK: - User-configurable settings

const config = {
    // The layout to come back to. Its localized name, as layouts() reports it.
    defaultLayout: "Canadian",

    // The input method methodToggle() turns on, and the ones kanaToggle() cycles through
    // in order. Two entries in kanaMethods make it a toggle; more make it a cycle.
    //
    // Either a localized name, as methods() reports it, or an input source identifier.
    // Identifiers here, because two of the input modes enabled on this machine are both
    // called "Hiragana" — Kotoeri's romaji typing and its kana typing — and a name cannot
    // say which is meant. See sourceSelect().
    inputMethod: "com.apple.inputmethod.Kotoeri.RomajiTyping.Japanese",
    kanaMethods: [
        "com.apple.inputmethod.Kotoeri.RomajiTyping.Japanese",
        "com.apple.inputmethod.Kotoeri.RomajiTyping.Japanese.Katakana"
    ],

    // Name the new input source in an alert after every switch. The menu bar already shows
    // it, but not on a MacBook with a notch, where the flag is often among the icons that
    // do not fit.
    alert: true,
    alertSeconds: 1,

    // Also alert when the input source is changed by something else — ⌃Space, the menu bar,
    // an application switching it on your behalf. Off by default: with alert above already
    // on, every switch made here would be announced twice.
    alertOnChange: false,

    // Rows visible in select()'s chooser.
    rowsToDisplay: 10
}

// MARK: - State

let chooser = null

// The listener given to hs.keycodes, held so that stop() can remove the same function.
let changeListener = null

// MARK: - Reading

/**
 * The active input source.
 *
 * @returns {{layout: string|null, method: string|null, sourceID: string|null}} `method` is
 *          null when no input method is active, which is the test for "am I typing in a
 *          plain layout?". `layout` is the layout underneath, and is set either way.
 */
function current() {
    return {
        layout: hs.keycodes.currentLayout(),
        method: hs.keycodes.currentMethod(),
        sourceID: hs.keycodes.currentSourceID()
    }
}

/** The enabled layouts, by localized name. */
function layouts() {
    return hs.keycodes.layouts()
}

/** The enabled input methods, by localized name. */
function methods() {
    return hs.keycodes.methods()
}

/**
 * How the active input source is named in an alert: "Hiragana", or "Canadian".
 *
 * The input method alone when one is active, and the layout only when none is. The layout
 * underneath a method is deliberately not shown: currentLayout() lags one switch behind,
 * so read immediately after switching — which is when an alert is drawn — it reports the
 * layout that was in use before. Kotoeri's romaji mode sits on a U.S. layout here, and an
 * alert naming it said "(Canadian)" for a second afterwards.
 *
 * current() reports the layout either way, for a caller that wants it and can wait.
 */
function label() {
    const now = current()
    return now.method || now.layout || "unknown layout"
}

/** Name the active input source in an alert, whether or not config.alert is set. */
function currentShow() {
    hs.ui.alert(label()).duration(config.alertSeconds).show()
    return label()
}

/** The active input source and what is enabled, as lines, for the console. */
function list() {
    const lines = [`now: ${label()}`]
    lines.push(`layouts: ${layouts().join(", ") || "(none)"}`)
    lines.push(`methods: ${methods().join(", ") || "(none)"}`)
    return lines
}

// MARK: - Switching

function announce() {
    if (config.alert) hs.ui.alert(label()).duration(config.alertSeconds).show()
}

/**
 * Report a name that could not be selected, and what could have been.
 *
 * A failed switch is otherwise silent, and silence is indistinguishable from the key not
 * being bound at all.
 */
function reportMissing(name, kind, available) {
    const enabled = available.join(", ") || "(none)"
    hs.ui.alert(`No ${kind} called "${name}". Enabled: ${enabled}`).duration(3).show()
    console.error(`[hs_keyboard-gt] no ${kind} "${name}"; enabled: ${enabled}`)
}

/**
 * Switch to a keyboard layout.
 *
 * @param {string} name Its localized name, as layouts() reports it.
 * @returns {boolean} Whether it was selected.
 */
function layoutSet(name) {
    if (!name) return false
    if (!hs.keycodes.setLayout(name)) {
        reportMissing(name, "layout", layouts())
        return false
    }
    announce()
    return true
}

/**
 * Switch to an input method.
 *
 * @param {string} name Its localized name, as methods() reports it.
 * @returns {boolean} Whether it was selected.
 */
function methodSet(name) {
    if (!name) return false
    if (!hs.keycodes.setMethod(name)) {
        reportMissing(name, "input method", methods())
        return false
    }
    announce()
    return true
}

/**
 * Switch to an input source by its identifier, e.g. "com.apple.keylayout.British".
 *
 * Takes layouts and input methods alike, which is what select() uses: a chooser row does
 * not have to remember which of the two it holds. A name is easier to write by hand;
 * an identifier is unambiguous and does not change with the system language.
 *
 * @param {string} sourceID
 * @returns {boolean} Whether it was selected.
 */
function sourceSet(sourceID) {
    if (!sourceID) return false
    if (!hs.keycodes.setSourceID(sourceID)) {
        hs.ui.alert(`No input source with ID ${sourceID}`).duration(3).show()
        return false
    }
    announce()
    return true
}

/**
 * Whether a setting names an input source by identifier rather than by localized name.
 *
 * An identifier is a reverse-DNS string and so contains a dot; no localized name does.
 * Both forms are accepted wherever a setting names an input source, because a name is
 * easier to write and an identifier is unambiguous — see below for when that matters.
 */
function isSourceID(nameOrID) {
    return String(nameOrID).includes(".")
}

/**
 * Switch to an input source given either way.
 *
 * Localized names are not unique. On this machine methods() reports "Hiragana" twice:
 * enabling Katakana in System Settings enabled a second Kotoeri typing mode that carries
 * the same name. setMethod() matches on the name and selects the first it finds, so which
 * of the two is selected depends on the order macOS returns them in, and nothing commits
 * macOS to an order.
 *
 * So anything that has to land on one particular source names it by identifier.
 */
function sourceSelect(nameOrID) {
    return isSourceID(nameOrID) ? sourceSet(nameOrID) : methodSet(nameOrID)
}

/** Switch to config.defaultLayout, turning off any input method that is on top of it. */
function layoutDefault() {
    return layoutSet(config.defaultLayout)
}

/**
 * Toggle between the default layout and config.inputMethod.
 *
 * Version 1's setInputMethod(''). An input method is active, so turn it off by selecting
 * the layout; none is, so turn config.inputMethod on.
 *
 * Selecting the layout is what turns the input method off: there is no call that removes
 * an input method and leaves the layout alone, because the layout was never gone.
 *
 * @returns {boolean} Whether the switch was made.
 */
function methodToggle() {
    if (hs.keycodes.currentMethod()) return layoutDefault()
    return sourceSelect(config.inputMethod)
}

/**
 * Move to the next of config.kanaMethods.
 *
 * Version 1's toggle_jp(), which went between Hiragana and Katakana. Any number of methods
 * may be listed; two of them make it the toggle it was. When no input method is active —
 * you are in a plain layout — the first entry is selected, so this also reaches Japanese
 * from the layout rather than doing nothing.
 *
 * @returns {boolean} Whether the switch was made.
 */
function kanaToggle() {
    const kana = config.kanaMethods || []
    if (!kana.length) return false

    // Entries may be names or identifiers, so the active source is looked for as both.
    const method = hs.keycodes.currentMethod()
    const sourceID = hs.keycodes.currentSourceID()
    const at = kana.findIndex((entry) => entry === method || entry === sourceID)

    const next = at === -1 ? kana[0] : kana[(at + 1) % kana.length]
    return sourceSelect(next)
}

// MARK: - The chooser

/**
 * Pick an input source from a chooser.
 *
 * Layouts and input methods in one list, which is how macOS presents them in the menu bar,
 * each row saying which of the two it is. Not in version 1.
 */
function select() {
    const active = hs.keycodes.currentSourceID()

    // Deduplicated by name. Two enabled input modes can carry the same localized name —
    // romaji typing and kana typing both call theirs "Hiragana" — and two identical rows
    // offer a choice that is not one. Selecting either goes to the same place anyway:
    // setMethod() matches on the name and takes the first.
    const rows = []
    const seen = new Set()
    const add = (name, kind, subText) => {
        if (seen.has(name)) return
        seen.add(name)
        rows.push({ text: name, subText: subText, kind: kind, name: name })
    }
    for (const name of layouts()) add(name, "layout", "layout")
    for (const name of methods()) add(name, "method", "input method")

    if (!rows.length) {
        hs.ui.alert("No input sources are enabled").duration(3).show()
        return false
    }

    chooser = hs.chooser.create()
    chooser.placeholder = "Input source"
    chooser.searchSubText = true
    chooser.visibleRows = config.rowsToDisplay
    chooser.setChoices(rows)

    chooser.onSelect = (item) => {
        chooser = null
        if (!item) return
        if (item.kind === "method") methodSet(item.name)
        else layoutSet(item.name)
    }
    chooser.onHide = () => { chooser = null }

    chooser.show()

    // Said after showing rather than instead of a row's mark: the chooser's rows carry no
    // indication of which source is in use, and the active one is the row you least want.
    if (active) console.log(`[hs_keyboard-gt] active: ${active}`)
    return true
}

// MARK: - Starting and stopping

function start() {
    if (config.alertOnChange && !changeListener) {
        changeListener = () => {
            hs.ui.alert(label()).duration(config.alertSeconds).show()
        }
        hs.keycodes.on("change", changeListener)
    }
    return module.exports
}

function stop() {
    if (changeListener) {
        hs.keycodes.off("change", changeListener)
        changeListener = null
    }
    if (chooser) {
        try { chooser.hide() } catch (e) { /* going anyway */ }
        chooser = null
    }
    return module.exports
}

module.exports = {
    config,

    current,
    currentShow,
    label,
    list,
    layouts,
    methods,

    layoutSet,
    layoutDefault,
    methodSet,
    sourceSet,
    sourceSelect,
    methodToggle,
    kanaToggle,
    select,

    start,
    stop,

    author: "Daniel M German",
    description: "Switch keyboard layouts and input methods from the keyboard",
    version: "1.0"
}
