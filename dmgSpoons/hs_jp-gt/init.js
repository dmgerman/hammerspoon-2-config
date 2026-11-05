// hs_jp-gt — Japanese tools: look up a word in the dictionary, and translate text.
//
//     const jp = hs.spoons["hs_jp-gt"]
//     await jp.define("頷く")                              // HTML from jisho.py
//     await jp.translate("キノは頷いた")                    // "Kino nodded", with translateBackend()
//     await jp.translate("Kino nodded")                    // English to Japanese
//     await jp.translate("キノは頷いた", { backend: "deepl" })
//     await jp.translate("Hola", { from: "es", to: "en" })
//     jp.selectionDefine()                                 // the selection, shown in the panel
//     jp.selectionTranslate("google")
//     jp.translateBackendSet("deepl")                      // the backend used from now on
//     jp.translateBackendSelect()                          // the same, from a chooser
//
// A port of the hs_jp Spoon in ~/.hammerspoon. define() is version 1's translate(), renamed
// because translate() here is the actual translation. The panel replaces version 1's
// dictView, an hs.webview that Hammerspoon 2 does not have; see "The panel" below.
//
// ## Dictionary
//
// define() runs config.dictionaryCommand, which is jisho.py on this machine. That script
// splits the text into words with MeCab, looks up the first word with myougiden, and prints
// the definition as HTML. It lives outside this Spoon, which is why the Spoon is in
// dmgSpoons/. It looks up a word as it is written: 頷いて is looked up as 頷い, which is not
// found, while 頷く is.
//
// ## Translation backends
//
// translate() uses one of four backends, named per call or else the current one, which
// starts as config.translateBackend and is changed by translateBackendSet() or
// translateBackendSelect() until the next reload:
//
//   macos         The macOS Translation framework, through hs.translation. Offline, and
//                 needs no key, but only for the language pairs downloaded in System
//                 Settings → General → Language & Region → Translation Languages. The first
//                 translation after a while takes several seconds while macOS loads the
//                 model.
//   deepl         The DeepL API. A free key, which ends in ":fx", is sent to
//                 api-free.deepl.com and any other key to api.deepl.com.
//   google        Google Translate's public interface, the one its browser extensions use.
//                 It needs no key. It is undocumented, so Google may change it, and it
//                 refuses requests it takes for automated ones, answering with a page that
//                 begins "Sorry...".
//   google-cloud  The Google Cloud Translation API, version 2, with an API key.
//
// The DeepL and Google Cloud keys are read from ~/.authinfo.gpg through
// ../../Spoons/lib/authinfo.js, from the entries named in config.deepl and
// config.googleCloud, for example
//
//     machine api.deepl.com login hs_jp-gt password 0123-abcd:fx
//     machine translation.googleapis.com login hs_jp-gt password AIza...
//
// A key is read the first time its backend is used and kept until the next reload, so gpg
// is asked once per backend.
//
// ## The panel
//
// Results are shown in a floating window holding an hs.ui.webview. Escape in it, or its
// close button, hides it and gives focus back to the window that had it before. The window
// is created again for every result, because an hs.ui window takes its frame when it is
// created and the panel goes on the screen being worked on.

const shell = require(hs.appinfo.configDir + "/Spoons/lib/shell.js")
const authinfo = require(hs.appinfo.configDir + "/Spoons/lib/authinfo.js")

// MARK: - User-configurable settings

const config = {
    // Prints a definition of its argument. "-t" asks for HTML rather than terminal text.
    dictionaryCommand: "/Users/dmg/bin/osx/jisho.py",
    dictionaryArgs: ["-t"],

    // The backend translate() uses after a reload when a call names none: "macos", "deepl",
    // "google" or "google-cloud".
    translateBackend: "macos",

    // translate() goes from Japanese to config.languageOther when the text contains any
    // Japanese, and from config.languageOther to Japanese when it does not.
    languageJapanese: "ja",
    languageOther: "en",

    // The ~/.authinfo.gpg entries holding the keys. `login` may be null when the file has
    // only one entry for the machine.
    deepl: {
        machine: "api.deepl.com",
        login: "hs_jp-gt",
        // DeepL needs a regional variant for English and Portuguese as a target language.
        targetVariants: { en: "EN-US", pt: "PT-PT" }
    },
    googleCloud: {
        machine: "translation.googleapis.com",
        login: "hs_jp-gt"
    },

    // Google Translate's public interface. "gtx" is the client name it accepts without a key.
    googlePublic: {
        url: "https://translate.googleapis.com/translate_a/single",
        client: "gtx"
    },

    // How long to wait for the application to answer ⌘C when the selection cannot be read
    // through accessibility.
    copyWaitSeconds: 0.2,

    panel: {
        // Where the panel goes, as fractions of the screen holding the focused window. The
        // values are version 1's: an eighth in from the left, half as wide as the screen.
        left: 1 / 8,
        top: 1 / 6,
        width: 1 / 2,
        height: 500,
        level: "floating",
        fontSize: 16,
        // Seconds between showing the panel and focusing it; see panelFocus().
        focusDelay: 0.1
    }
}

// MARK: - Constants

// Any kanji, hiragana or katakana. Used to decide which way to translate.
const JAPANESE_PATTERN = /[\p{Script=Han}\p{Script=Hiragana}\p{Script=Katakana}]/u

const LOG_PREFIX = "[hs_jp-gt]"

// The name the panel's page posts its messages under.
const PANEL_MESSAGE_HANDLER = "jp"

const BACKEND_LABELS = {
    macos: "macOS",
    deepl: "DeepL",
    google: "Google",
    "google-cloud": "Google Cloud"
}

// MARK: - State

// Keys read from ~/.authinfo.gpg, by config entry, so that gpg is asked once per reload.
const keys = {}

// The backend chosen with translateBackendSet(), or null for config.translateBackend. Not
// copied from config here, because use() merges the configuration's settings in after this
// file has run.
let backendChosen = null

let panelWindow = null
let panelView = null

// The window that had focus before the panel was shown, given focus again when it hides.
let panelPreviousWindow = null

// MARK: - Dictionary

/**
 * Look up a word in the dictionary.
 *
 * The text may be a phrase: jisho.py splits it into words and defines the first one, then
 * lists the words it found.
 *
 * @param {string} text The word or phrase.
 * @returns {Promise<string>} The definition, as HTML. Rejects when the text is empty or the
 *   dictionary command fails.
 */
async function define(text) {
    if (!text || !text.trim()) throw new Error("Nothing to define")
    const command = config.dictionaryCommand
    if (!hs.fs.attributes(command)) throw new Error(`${command} does not exist`)

    const result = await shell.commandRun(command, [...config.dictionaryArgs, text.trim()])
    if (result.code !== 0) {
        const detail = (result.err || result.out || "").trim()
        throw new Error(`${command} failed (exit ${result.code})` + (detail ? `: ${detail}` : ""))
    }
    return result.out.trim()
}

// MARK: - Translation backends

/**
 * A key, from ~/.authinfo.gpg the first time and from memory afterwards.
 *
 * @param {string} entryName "deepl" or "googleCloud": the config entry naming the
 *   authinfo machine and login.
 * @returns {Promise<string>}
 */
async function keyRead(entryName) {
    if (!keys[entryName]) {
        const entry = config[entryName]
        keys[entryName] = await authinfo.password(entry.machine, entry.login)
    }
    return keys[entryName]
}

/**
 * The body of an HTTP response as JSON, or an error naming the backend and the status.
 *
 * @param {string} backend For the error.
 * @param {{status: number, body: string}} response
 * @returns {object}
 */
function responseParse(backend, response) {
    let body = null
    try {
        body = JSON.parse(response.body)
    } catch (e) {
        // Reported below with the status, which says more than the parse error.
    }
    if (response.status === 200 && body) return body

    const detail = body && (body.message || (body.error && body.error.message))
    throw new Error(`${backendLabel(backend)} answered ${response.status}` +
        (detail ? `: ${detail}` : ""))
}

async function translateMacos(text, from, to) {
    const status = await hs.translation.status(from, to)
    if (status !== "installed") {
        throw new Error(`macOS cannot translate ${from}→${to}: the pair is ${status}. ` +
            "Install it in System Settings → General → Language & Region → Translation Languages.")
    }
    const session = hs.translation.session(from, to)
    if (!session) throw new Error("hs.translation needs macOS 26 or later")
    return session.translate(text)
}

async function translateDeepl(text, from, to) {
    const key = await keyRead("deepl")
    const host = key.endsWith(":fx") ? "api-free.deepl.com" : "api.deepl.com"
    const target = config.deepl.targetVariants[to] || to.toUpperCase()

    const response = await hs.http.post(`https://${host}/v2/translate`,
        JSON.stringify({ text: [text], source_lang: from.toUpperCase(), target_lang: target }),
        { "Authorization": `DeepL-Auth-Key ${key}`, "Content-Type": "application/json" })
    return responseParse("deepl", response).translations.map((t) => t.text).join("\n")
}

/**
 * Google Translate's public interface.
 *
 * The answer is a JSON array whose first element lists the translated segments, one per
 * sentence, each as [translation, original, ...].
 */
async function translateGooglePublic(text, from, to) {
    const settings = config.googlePublic
    const query = [
        ["client", settings.client], ["sl", from], ["tl", to], ["dt", "t"], ["q", text]
    ].map(([name, value]) => `${name}=${hs.http.encodeForQuery(value)}`).join("&")

    const response = await hs.http.get(`${settings.url}?${query}`, null)
    if (response.status === 200 && /^\s*</.test(response.body)) {
        throw new Error("Google refused the request, taking it for an automated one")
    }
    const segments = responseParse("google", response)[0] || []
    return segments.map((segment) => segment[0]).join("")
}

async function translateGoogleCloud(text, from, to) {
    const key = await keyRead("googleCloud")
    const url = "https://translation.googleapis.com/language/translate/v2?key=" +
        hs.http.encodeForQuery(key)

    const response = await hs.http.post(url,
        JSON.stringify({ q: text, source: from, target: to, format: "text" }),
        { "Content-Type": "application/json" })
    return responseParse("google-cloud", response).data.translations
        .map((t) => t.translatedText).join("\n")
}

const BACKENDS = {
    macos: translateMacos,
    deepl: translateDeepl,
    google: translateGooglePublic,
    "google-cloud": translateGoogleCloud
}

/**
 * Whether the text contains any Japanese.
 *
 * @param {string} text
 * @returns {boolean}
 */
function isJapanese(text) {
    return JAPANESE_PATTERN.test(text)
}

/**
 * Translate text.
 *
 * Without languages, the direction comes from the text: Japanese text goes to
 * config.languageOther, and anything else goes to Japanese.
 *
 * @param {string} text
 * @param {object} [options]
 * @param {string} [options.from] The language of the text, as "ja" or "en".
 * @param {string} [options.to] The language to translate into.
 * @param {string} [options.backend] One of backends(). Defaults to translateBackend().
 * @returns {Promise<string>} The translation. Rejects when the text is empty, the backend is
 *   unknown, or the backend fails.
 */
async function translate(text, options) {
    if (!text || !text.trim()) throw new Error("Nothing to translate")
    const settings = options || {}
    const backend = settings.backend || translateBackend()
    backendCheck(backend)

    const japanese = isJapanese(text)
    const from = settings.from || (japanese ? config.languageJapanese : config.languageOther)
    const to = settings.to || (japanese ? config.languageOther : config.languageJapanese)
    return BACKENDS[backend](text.trim(), from, to)
}

/** The names of the translation backends. */
function backends() {
    return Object.keys(BACKENDS)
}

/**
 * A backend's name for people, as "Google Cloud".
 *
 * @param {string} backend One of backends().
 * @returns {string}
 */
function backendLabel(backend) {
    return BACKEND_LABELS[backend] || backend
}

/** Throw unless `backend` is one of backends(). */
function backendCheck(backend) {
    if (BACKENDS[backend]) return
    throw new Error(`No translation backend "${backend}"; there are ${backends().join(", ")}`)
}

/** The backend translate() uses when a call names none. */
function translateBackend() {
    return backendChosen || config.translateBackend
}

/**
 * Make `backend` the one translate() uses when a call names none, until the next reload.
 *
 * @param {string} backend One of backends().
 */
function translateBackendSet(backend) {
    backendCheck(backend)
    backendChosen = backend
    hs.ui.alert(`Translating with ${backendLabel(backend)}`).show()
    return module.exports
}

/** Choose the backend translate() uses, from a chooser. */
function translateBackendSelect() {
    const current = translateBackend()
    const chooser = hs.chooser.create()
    chooser.placeholder = "Translation backend"
    // setChoices(), not a `choices` property: assigning one of those is accepted in silence
    // and leaves the chooser empty.
    chooser.setChoices(backends().map((backend) => ({
        text: backendLabel(backend),
        subText: backend === current ? "✓ Selected" : "",
        backend: backend
    })))
    chooser.onSelect = (choice) => {
        if (choice) translateBackendSet(choice.backend)
    }
    chooser.show()
    return module.exports
}

// MARK: - The selection

/**
 * The selected text in the focused element, through accessibility.
 *
 * @returns {?string} The text, or null when the element does not expose a selection.
 */
function selectionReadAccessibility() {
    let text
    try {
        const element = hs.ax.focusedElement()
        if (!element) return null
        text = element.attributeValue("AXSelectedText")
    } catch (e) {
        return null
    }
    if (typeof text !== "string" || text === "") return null
    return text
}

/**
 * The selected text, copied with ⌘C.
 *
 * This replaces what is on the pasteboard, as version 1 did.
 *
 * @returns {Promise<?string>} The text, or null when the application did not copy anything.
 */
function selectionReadCopy() {
    const before = hs.pasteboard.changeCount
    hs.eventtap.keyStroke(["cmd"], "c")
    return new Promise((resolve) => {
        hs.timer.doAfter(config.copyWaitSeconds, () => {
            if (hs.pasteboard.changeCount === before) {
                resolve(null)
                return
            }
            resolve(hs.pasteboard.readString() || null)
        })
    })
}

/**
 * The selected text in the focused application.
 *
 * Read through accessibility when the application exposes it. Otherwise ⌘C is sent and the
 * pasteboard is read, which is how terminals and some browsers have to be read.
 *
 * @returns {Promise<?string>} The text, or null when nothing is selected.
 */
async function selection() {
    const text = selectionReadAccessibility()
    if (text !== null) return text
    return selectionReadCopy()
}

// MARK: - The panel

/** Escape text for inclusion in HTML. */
function htmlEscape(text) {
    return String(text)
        .replace(/&/g, "&amp;")
        .replace(/</g, "&lt;")
        .replace(/>/g, "&gt;")
        .replace(/"/g, "&quot;")
}

/**
 * A complete page around a fragment of HTML.
 *
 * The page posts "close" to PANEL_MESSAGE_HANDLER when Escape is pressed, which is how a key
 * pressed in a webview reaches the Spoon.
 *
 * @param {string} body HTML for the body.
 * @returns {string}
 */
function panelPage(body) {
    return `<!doctype html>
<html><head><meta charset="utf-8">
<style>
  :root { color-scheme: light dark; }
  body { font: ${config.panel.fontSize}px -apple-system, "Hiragino Sans", sans-serif;
         margin: 0; padding: 14px 18px; line-height: 1.5; }
  h2, h3 { margin: 0.2em 0; }
  table { border-collapse: collapse; }
  td { padding: 2px 12px 2px 0; }
  .label { font-size: 0.8em; opacity: 0.6; text-transform: uppercase; letter-spacing: 0.05em; }
  .source { opacity: 0.75; white-space: pre-wrap; margin-bottom: 1em; }
  .result { font-size: 1.15em; white-space: pre-wrap; }
  .error { color: #d33; white-space: pre-wrap; }
</style></head>
<body>${body}
<script>
  document.addEventListener("keydown", (event) => {
    if (event.key === "Escape") window.webkit.messageHandlers.${PANEL_MESSAGE_HANDLER}.postMessage("close")
  })
  // Without this the webview never receives a key, even when its window has focus.
  window.focus()
  document.body.tabIndex = -1
  document.body.focus()
</script>
</body></html>`
}

/**
 * The frame for the panel, in hs.ui window coordinates.
 *
 * A screen's frame has its origin at the top left of the primary screen, with y increasing
 * downwards; an hs.ui window's has it at the bottom left, with y increasing upwards.
 */
function panelFrame() {
    const focused = hs.window.focusedWindow()
    const screen = (focused && focused.screen) || hs.screen.main() || hs.screen.primary()
    const area = screen.fullFrame
    const primary = hs.screen.primary().fullFrame

    const settings = config.panel
    const width = area.w * settings.width
    const left = area.x + area.w * settings.left
    const top = area.y + area.h * settings.top
    return {
        x: left,
        y: (primary.y + primary.h) - (top + settings.height),
        w: width,
        h: settings.height
    }
}

/** Hide the panel and give focus back to the window that had it. */
function panelHide() {
    if (panelWindow) {
        const window = panelWindow
        panelWindow = null
        panelView = null
        window.destroy()
    }
    const previous = panelPreviousWindow
    panelPreviousWindow = null
    if (previous) {
        try { previous.focus() } catch (e) { /* the window has gone */ }
    }
    return module.exports
}

/**
 * Show HTML in the panel, creating it if it is not displayed.
 *
 * @param {string} title For the window's title bar.
 * @param {string} body HTML for the page's body.
 */
function panelShow(title, body) {
    if (panelView) {
        panelView.loadHTML(panelPage(body))
        panelWindow.windowTitle(title)
        return module.exports
    }

    panelPreviousWindow = hs.window.focusedWindow()
    panelView = hs.ui.webview()
        .onMessage(PANEL_MESSAGE_HANDLER, (message) => {
            if (message === "close") panelHide()
        })
        .loadHTML(panelPage(body))

    panelWindow = hs.ui.window(panelFrame())
        .titled(true)
        .closable(true)
        .allowResize(true)
        .windowTitle(title)
        .level(config.panel.level)
        // The close button only hides an hs.ui window. Hiding it this way also destroys it
        // and gives focus back, exactly as Escape does.
        .onHide(() => { if (panelWindow) panelHide() })
        .webview(panelView)
        .show()
    panelFocus(title)
    return module.exports
}

/**
 * Give the panel keyboard focus, so that Escape reaches it.
 *
 * show() puts an hs.ui window in front without making it the key window, and an HSUIWindow
 * cannot be focused itself. So the panel is found among Hammerspoon 2's own windows, by its
 * title, once the window server has it.
 *
 * @param {string} title The panel's title.
 */
function panelFocus(title) {
    hs.timer.doAfter(config.panel.focusDelay, () => {
        if (!panelWindow) return
        const window = hs.window.allWindows().find((candidate) =>
            candidate.title === title && candidate.application &&
            candidate.application.bundleID === hs.appinfo.bundleIdentifier)
        if (window) window.focus()
    })
}

/** Whether the panel is displayed. */
function panelIsShown() {
    return panelWindow !== null
}

// MARK: - Commands on the selection

/**
 * Read the selection, show `pending` in the panel, then the result of `operation`.
 *
 * @param {string} title For the panel's title bar.
 * @param {function(string): string} pending HTML shown while the operation runs.
 * @param {function(string): Promise<string>} operation Resolves to HTML for the panel.
 * @returns {Promise<?string>} That HTML, or null when nothing was selected or it failed.
 */
async function selectionShow(title, pending, operation) {
    const text = await selection()
    if (!text) {
        hs.ui.alert("Nothing is selected").show()
        return null
    }

    panelShow(title, pending(text))
    try {
        const html = await operation(text)
        if (panelIsShown()) panelShow(title, html)
        return html
    } catch (e) {
        console.error(`${LOG_PREFIX} ${title} ${text}: ${e.message}`)
        if (panelIsShown()) panelShow(title, `<div class="error">${htmlEscape(e.message)}</div>`)
        return null
    }
}

/** Look up the selection in the dictionary and show the definition in the panel. */
function selectionDefine() {
    return selectionShow("Dictionary",
        (text) => `<h3>${htmlEscape(text)}</h3><p class="label">Looking up…</p>`,
        define)
}

/**
 * Translate the selection and show it, with the translation, in the panel.
 *
 * @param {string} [backend] Defaults to translateBackend().
 */
function selectionTranslate(backend) {
    const name = backend || translateBackend()
    const label = backendLabel(name)
    const source = (text) => `<div class="label">Original</div>` +
        `<div class="source">${htmlEscape(text)}</div>`

    return selectionShow(`Translation (${label})`,
        (text) => source(text) + `<div class="label">Translating with ${label}…</div>`,
        async (text) => {
            const result = await translate(text, { backend: name })
            return source(text) + `<div class="label">${label}</div>` +
                `<div class="result">${htmlEscape(result)}</div>`
        })
}

// MARK: - Starting and stopping

function stop() {
    panelHide()
    return module.exports
}

module.exports = {
    config,

    define,
    translate,
    backends,
    backendLabel,
    translateBackend,
    translateBackendSet,
    translateBackendSelect,
    isJapanese,
    selection,
    selectionDefine,
    selectionTranslate,
    panelShow,
    panelHide,

    stop,

    author: "Daniel M German",
    description: "Japanese tools: dictionary lookup and translation",
    version: "0.3"
}
