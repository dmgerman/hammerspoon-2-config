// hs_url-gt — a port of dmg-url.lua, which used the Hammerspoon 1 URLDispatcher Spoon.
//
// When Hammerspoon 2 is the system handler for http and https, every link opened anywhere
// arrives here. There are two ways to route one, chosen by config.route:
//
//   "patterns"  the table in config.patterns decides, and config.defaultBrowser takes
//               whatever no pattern matched. This is what version 1 did.
//   "emacs"     the URL is handed to browse-url, and the routing rules are Emacs's.
//
// Emacs is the more capable router and is the default. "patterns" remains because Emacs is
// not always running: a route of "emacs" with Emacs not running falls back to the pattern
// table rather than losing the link.
//
// Decoders run before either route, since they repair the URL itself rather than decide
// where it goes.

// MARK: - User-configurable settings

const config = {
    // "patterns" or "emacs". See above. Emacs is the better router, so it is the default;
    // the pattern table takes over whenever Emacs is not running.
    route: "emacs",

    // Named by path rather than by bundle identifier, so that an application that is not
    // installed is reported at start() instead of failing silently at the first link.
    // start() resolves each to its bundle identifier.
    browsers: {
        default: "/Applications/Google Chrome.app",
        uvic: "/Applications/Firefox.app",
        banking: "/Applications/Safari.app"
    },

    // Which of those takes a URL that no pattern matched.
    defaultBrowser: "default",

    // First match decides. `browser` names an entry in browsers; `open` is called with the
    // URL and is responsible for everything, including not opening it at all.
    patterns: [
        { match: /https:\/\/bright\.uvic\.ca/, browser: "default" },
        { match: /https:\/\/gitlab\.csc\.uvic\.ca\//, browser: "default" },
        { match: /https?:\/\/.*\.acm\.org/, browser: "uvic" },
        { match: /https?:\/\/.*\.ieeexplore\.ieee\.org/, browser: "uvic" },
        { match: /https?:\/\/.*\.cibc\.com/, browser: "banking" },
        { match: /https?:\/\/.*\.youtube\.com/, open: (url) => youtube(url) },
        { match: /https?:\/\/.*\.uvic\.ca/, browser: "uvic" },
        { match: /https?:\/\/uvic\.ca/, browser: "uvic" }
    ],

    // Applied in order, and every one that matches is applied, not just the first.
    // `sourceApp` limits a decoder to URLs opened by that application. `skipUnescape`
    // leaves the result percent-encoded; without it the URL is decoded afterwards.
    decoders: [
        {
            name: "MS Teams URLs",
            match: /(https:\/\/teams\.microsoft\.com.*)/g,
            replace: "msteams:$1",
            skipUnescape: true
        },
        {
            // Preview encodes the anchor character in a URL as %23.
            name: "Fix broken Preview anchor URLs",
            match: /%23/g,
            replace: "#",
            sourceApp: "Preview"
        }
    ],

    // Opens a YouTube URL in a Chrome tab without bringing Chrome forward.
    chromeCli: "/opt/homebrew/bin/chrome-cli",

    // Who takes http and https when this Spoon is disabled and there is no record of what
    // it displaced, which is the case after every reload.
    handlerWhenDisabled: "org.hammerspoon.Hammerspoon"
}

// MARK: - State

/** Hammerspoon 2's own bundle identifier, for claiming http and https. */
const HAMMERSPOON_2 = "net.tenshu.Hammerspoon-2"

// browsers, resolved to bundle identifiers by start().
let bundleIDs = {}

// The http and https handlers displaced by setAsDefaultBrowser(), for restoring.
let displacedHandlers = null

// The chooser shown by switchRoute(), held so it is not collected while displayed.
let activeChooser = null

// MARK: - Helpers

/** The Emacs Spoon, or null when it has not been loaded. */
function emacsSpoon() {
    return hs.spoons["hs_emacs-gt"] || null
}

/** A string as an elisp string literal's contents. */
function forElisp(text) {
    if (text === undefined || text === null) return ""
    return String(text).replace(/\\/g, "\\\\").replace(/"/g, '\\"')
}

/** A string as a single-quoted shell word's contents. */
function forShell(text) {
    return String(text).replace(/'/g, "'\\''")
}

/**
 * Percent-decode a URL.
 *
 * Written out rather than using decodeURIComponent, which throws on a malformed sequence.
 * A link that cannot be decoded should still be opened.
 */
function unescape(url) {
    return url.replace(/%([0-9A-Fa-f]{2})/g, (match, hex) => String.fromCharCode(parseInt(hex, 16)))
}

/** The name of the application that opened the URL, or "" when it is not known. */
function sendingApplication(senderPID) {
    if (senderPID === undefined || senderPID === null || senderPID < 0) return ""
    const app = hs.application.fromPID(senderPID)
    return app ? app.title : ""
}

// MARK: - Decoding

/**
 * Apply every decoder whose pattern matches and whose sourceApp allows it.
 *
 * @param {string} url The URL as it arrived.
 * @param {string} sourceApp Name of the application that opened it.
 * @returns {string} The URL to route.
 */
function decode(url, sourceApp) {
    let decoded = url

    for (const decoder of config.decoders) {
        if (decoder.sourceApp && decoder.sourceApp !== sourceApp) continue
        if (!decoder.match.test(decoded)) continue

        // test() advances lastIndex on a /g regex, so reset before replacing.
        decoder.match.lastIndex = 0
        const before = decoded
        decoded = decoded.replace(decoder.match, decoder.replace)
        decoder.match.lastIndex = 0

        if (!decoder.skipUnescape) decoded = unescape(decoded)
        console.log(`[hs_url-gt] decoder '${decoder.name}': ${before} -> ${decoded}`)
    }

    return decoded
}

// MARK: - Routing

/** Open a YouTube URL in a Chrome tab, without raising Chrome. */
function youtube(url) {
    return hs.task.shell(`${config.chromeCli} open '${forShell(url)}' -i`)
        .catch((e) => {
            console.error(`[hs_url-gt] chrome-cli failed for ${url}: ${e && e.stderr ? e.stderr : e}`)
        })
}

/** Open a URL in one of the configured browsers, by role name. */
function openInBrowser(url, role) {
    const bundleID = bundleIDs[role]
    if (!bundleID) {
        console.error(`[hs_url-gt] no browser resolved for '${role}', cannot open ${url}`)
        return
    }
    hs.application.launchOrFocus(bundleID)
    hs.urlevent.openURLWithBundle(url, bundleID)
}

/**
 * Route a URL by the first pattern that matches it, or by defaultBrowser.
 *
 * @param {string} url The URL, already decoded.
 * @param {string} from Name of the application that opened it, for the log.
 */
function routeByPattern(url, from) {
    const origin = from ? ` from ${from}` : ""

    for (const rule of config.patterns) {
        if (!rule.match.test(url)) continue
        rule.match.lastIndex = 0

        if (typeof rule.open === "function") {
            console.log(`[hs_url-gt] ${url}${origin} -> handled here by ${rule.match}`)
            rule.open(url)
            return
        }
        console.log(`[hs_url-gt] ${url}${origin} -> handled here by ${rule.match}, ` +
            `opening in ${rule.browser} (${bundleIDs[rule.browser] || "unresolved"})`)
        openInBrowser(url, rule.browser)
        return
    }

    console.log(`[hs_url-gt] ${url}${origin} -> handled here, no pattern matched, ` +
        `opening in ${config.defaultBrowser} (${bundleIDs[config.defaultBrowser] || "unresolved"})`)
    openInBrowser(url, config.defaultBrowser)
}

/**
 * Hand a URL to Emacs.
 *
 * @param {string} url The URL, already decoded.
 * @param {string} from Name of the application that opened it, for the log.
 * @returns {boolean} False when Emacs is not there to take it.
 */
function routeToEmacs(url, from) {
    const emacs = emacsSpoon()
    if (!emacs) {
        console.error("[hs_url-gt] route is 'emacs' but hs_emacs-gt is not loaded")
        return false
    }
    if (!emacs.isRunning()) return false

    console.log(`[hs_url-gt] ${url}${from ? ` from ${from}` : ""} -> sent to Emacs browse-url`)
    emacs.execute(`(browse-url "${forElisp(url)}")`)
    return true
}

/**
 * Route one URL. This is what `hs.urlevent.httpCallback` calls.
 *
 * @param {string} scheme The URL's scheme.
 * @param {string} host The URL's host.
 * @param {object} params The query parameters.
 * @param {string} fullURL The whole URL.
 * @param {number} senderPID Process that opened it, or -1.
 */
function dispatch(scheme, host, params, fullURL, senderPID) {
    const from = sendingApplication(senderPID)
    const url = decode(fullURL, from)

    if (config.route === "emacs") {
        if (routeToEmacs(url, from)) return
        // Emacs is checked on every URL rather than once at start, so that starting or
        // quitting it takes effect without a reload.
        console.log("[hs_url-gt] Emacs is not running, falling back to the pattern table")
    }

    routeByPattern(url, from)
}

// MARK: - The route

/** Route every URL through Emacs, when it is running. */
function useEmacs() {
    config.route = "emacs"
    return module.exports
}

/** Route every URL by the pattern table. */
function usePatterns() {
    config.route = "patterns"
    return module.exports
}

/**
 * Choose a route, or stop handling URLs, from a chooser.
 *
 * Choosing a route while disabled also enables: a route is of no use while the links are
 * going somewhere else, so no separate enable is offered.
 */
function switchRoute() {
    const enabled = isEnabled()
    const rows = [
        {
            text: "Emacs browse-url",
            subText: routeSubText("emacs", enabled),
            action: () => { useEmacs() }
        },
        {
            text: "Pattern table",
            subText: routeSubText("patterns", enabled),
            action: () => { usePatterns() }
        }
    ]

    if (enabled) {
        rows.push({
            text: "Disable",
            subText: `Hand http and https back to ${disabledHandler()}`,
            action: () => disable()
        })
    }

    const chooser = hs.chooser.create()
    chooser.placeholder = enabled ? "Route URLs by" : "Disabled — routing URLs by"
    chooser.searchSubText = true
    chooser.setChoices(rows)
    chooser.onSelect = (item) => {
        activeChooser = null
        if (!item) return
        item.action()
        if (!isEnabled()) enable()
        hs.ui.alert(describeState()).duration(2).show()
    }
    activeChooser = chooser
    chooser.show()
    return module.exports
}

/** What a route row says about itself: whether it is current, and what it would do. */
function routeSubText(name, enabled) {
    const current = config.route === name
    const what = name === "emacs"
        ? "Emacs decides, falling back to the pattern table when it is not running"
        : "The rules in this Spoon decide"
    if (!enabled) return `${what} — and start handling URLs again`
    return current ? `${what} — in use now` : what
}

/** One line describing what is happening, for the alert after a choice. */
function describeState() {
    if (!isEnabled()) return `URLs handled by ${disabledHandler()}`
    const state = route()
    return state.configured === state.effective
        ? `URLs routed by ${state.effective}`
        : `URLs routed by ${state.effective}, ${state.configured} is configured`
}

/** Which route is in use, and whether it is the one configured. */
function route() {
    const emacs = emacsSpoon()
    const emacsAvailable = Boolean(emacs && emacs.isRunning())
    return {
        configured: config.route,
        effective: config.route === "emacs" && !emacsAvailable ? "patterns" : config.route
    }
}

// MARK: - The system's http and https handler

/**
 * Make Hammerspoon 2 the system handler for http and https, so that links arrive here.
 *
 * Called by start(), since a Spoon that routes URLs is of no use without them. macOS asks
 * for confirmation the first time; afterwards the setting persists and this is a no-op.
 *
 * Note that this registers whichever build of Hammerspoon 2 is running. Deleting that
 * build leaves every link on the system pointing at a bundle that is not there.
 *
 * @returns {object} The handlers displaced, keyed by scheme. Empty when they were already
 *          Hammerspoon 2's.
 */
function setAsDefaultBrowser() {
    for (const scheme of ["http", "https"]) {
        const previous = hs.urlevent.getDefaultHandler(scheme)

        // A scheme already ours is left alone and, more importantly, not recorded: doing so
        // on every reload would overwrite the record with Hammerspoon 2 itself, leaving
        // restoreDefaultBrowser() nothing to hand the scheme back to.
        if (previous === HAMMERSPOON_2) continue

        displacedHandlers = displacedHandlers || {}
        displacedHandlers[scheme] = previous
        hs.urlevent.setDefaultHandler(scheme, HAMMERSPOON_2)
        console.log(`[hs_url-gt] ${scheme} now handled here, displacing ${previous}`)
    }

    return displacedHandlers ? { ...displacedHandlers } : {}
}

/**
 * Give http and https back to whatever held them before setAsDefaultBrowser().
 *
 * @param {string} [bundleID] Hand them to this instead. Used when nothing was recorded,
 *        which is the case in any session that did not itself displace a handler.
 */
function restoreDefaultBrowser(bundleID) {
    const http = bundleID || (displacedHandlers && displacedHandlers.http) || config.handlerWhenDisabled
    const https = bundleID || (displacedHandlers && displacedHandlers.https) || config.handlerWhenDisabled
    if (!http || !https) {
        console.error("[hs_url-gt] nothing recorded to restore, and handlerWhenDisabled is not set")
        return module.exports
    }
    hs.urlevent.setDefaultHandler("http", http)
    hs.urlevent.setDefaultHandler("https", https)
    console.log(`[hs_url-gt] http and https handed back to ${https}`)
    displacedHandlers = null
    return module.exports
}

/** Whether links are arriving here, which is to say whether https is ours. */
function isEnabled() {
    return hs.urlevent.getDefaultHandler("https") === HAMMERSPOON_2
}

/** Who takes the two schemes when disabled: what was displaced, else the configured one. */
function disabledHandler() {
    return (displacedHandlers && displacedHandlers.https) || config.handlerWhenDisabled
}

/** Start handling URLs again. */
function enable() {
    setAsDefaultBrowser()
    return module.exports
}

/** Stop handling URLs, handing the two schemes back. */
function disable() {
    restoreDefaultBrowser()
    return module.exports
}

// MARK: - The add-video event
//
// hammerspoon2://add-video?url=...&title=...&selection=... , sent by the browser, hands
// what is on the page to Emacs.

function addVideo(eventName, params, senderPID, fullURL) {
    const emacs = emacsSpoon()
    if (!emacs) {
        console.error("[hs_url-gt] add-video needs hs_emacs-gt, which is not loaded")
        return
    }

    const elisp = `(dmg-chrome-callback "${forElisp(eventName)}" "${forElisp(params.url)}" ` +
        `"${forElisp(params.title)}" "${forElisp(params.selection)}")`
    emacs.execute(elisp)
}

// MARK: - Lifecycle

/**
 * Resolve what the rules depend on, take the URL events, and claim http and https.
 *
 * Anything missing is reported here rather than at the moment a link needs it, when the
 * link would fail instead of opening and the cause would not be apparent.
 */
function start() {
    bundleIDs = {}
    for (const [role, path] of Object.entries(config.browsers)) {
        const info = hs.application.infoForBundlePath(path)
        if (info && info.CFBundleIdentifier) {
            bundleIDs[role] = info.CFBundleIdentifier
        } else {
            console.error(`[hs_url-gt] application not found for '${role}': ${path}`)
            hs.ui.alert(`Application not found: ${path}`).duration(3).show()
        }
    }

    // Only the YouTube rule needs this, so a missing chrome-cli is reported but does not
    // stop the rest. exists(), not isFile(): a Homebrew binary is a symlink into Cellar,
    // for which isFile() is false. hs.fs has no test for an executable bit either, so a
    // file that is present but not executable passes here and fails at the first link.
    if (!hs.fs.exists(config.chromeCli)) {
        console.error(`[hs_url-gt] chrome-cli not found at ${config.chromeCli}, YouTube links will fail`)
        hs.ui.alert(`chrome-cli not found: ${config.chromeCli}`).duration(3).show()
    }

    hs.urlevent.httpCallback = dispatch
    hs.urlevent.bind("add-video", addVideo)
    setAsDefaultBrowser()
    return module.exports
}

/** Give up the http callback and the add-video event. Does not change system handlers. */
function stop() {
    hs.urlevent.httpCallback = null
    hs.urlevent.bind("add-video", null)
    return module.exports
}

module.exports = {
    config,
    // Routing.
    dispatch,
    useEmacs,
    usePatterns,
    switchRoute,
    route,
    // The system's http and https handler.
    isEnabled,
    enable,
    disable,
    setAsDefaultBrowser,
    restoreDefaultBrowser,
    // Destinations, exported so a pattern in init.js can name them.
    youtube,
    openInBrowser,
    // Resolved bundle identifiers, for inspection.
    browsers: () => ({ ...bundleIDs }),
    start,
    stop
}
