// hs_windowfilter-gt — subscribe to window events, narrowed by rules.
//
// A port of the intent of Hammerspoon 1's hs.window.filter, rewritten for Hammerspoon 2
// rather than translated. The Lua original is
// ~/.hammerspoon/while-not-integrated/window_filter_new.lua, which serves as the
// specification; the design notes are in /tmp/ai/window_filter.org.
//
//     const wf = hs.loadSpoon("hs_windowfilter-gt")
//
//     const editors = wf.create({ allowApplications: ["Emacs"], visible: true })
//     editors.addWatcher("windowFocused", (event, window) => console.log(window.title))
//
//     wf.default.addWatcher(["windowCreated", "windowDestroyed"], (event, window) => { ... })
//
// Two design decisions shape the module:
//
//   * One tracker, many filters. A single set of accessibility watchers feeds every filter
//     instance. Watching per instance would mean N observers on the same window.
//
//   * Most events are derived, not received. Accessibility supplies a handful —
//     windowCreated, titleChanged, moved, resized, miniaturized, destroyed. The rest are
//     produced by recomputing a window's state after anything happens to it and comparing
//     against the state it had before. windowVisible, windowOnScreen, windowFocused and
//     their negatives all come from that comparison, not from a notification.
//
// Departures from the Hammerspoon 1 module, all deliberate:
//
//   * `currentSpace` is not implemented, and windowInCurrentSpace / windowNotInCurrentSpace
//     are not emitted. Hammerspoon 2 has no spaces module. The Lua version approximates the
//     rule as "visible", which is a different question wearing the same name; a rule that
//     evaluates a different question under the same name is less useful than an absent one.
//
//   * Subscription is addWatcher / removeWatcher, as hs.application, hs.screen and hs.ax
//     have it, rather than subscribe / unsubscribe.
//
//   * Titles and application names are matched with RegExp, exact strings, or a predicate,
//     rather than Lua patterns.
//
//   * No registration retry ladder. The Lua module retries because Hammerspoon 1 could
//     refuse a watcher registration; registering several windows of one application at once
//     works first time here, so the machinery is left out until something needs it.

// MARK: - User-configurable settings

const config = {
    // Window moves and title changes arrive in bursts — a drag posts a notification per
    // frame. An event is held for this long, and a further notification for the same
    // window restarts the wait, so one event is emitted when the burst ends.
    moveDebounce: 0.1,
    titleDebounce: 0.1,
    // Minimizing, unminimizing, hiding and focus changes: how long to let a window's
    // accessibility properties settle before reading them. They do not all change at once,
    // so reading immediately can catch a window half way through a transition.
    stateDebounce: 0.08,

    // Applications never tracked. The Lua module calls these noWindows and transient: they
    // have no windows worth reporting, and watching them costs an observer each.
    skipApplications: [
        "universalaccessd", "sharingd", "Safari Networking", "Spotlight",
        "iTerm2 Shell Integration", "Safari Web Content", "SafariLauncher",
        "com.apple.WebKit.Networking", "com.apple.WebKit.WebContent"
    ],

    // Applications whose windows are tracked but never reported by the default filter.
    // A filter can still ask for them by name.
    skipInDefault: ["Hammerspoon", "Hammerspoon 2"],

    // Logged to the console when a watcher cannot be registered or a rule is malformed.
    // "none", "error" or "debug".
    logLevel: "error"
}

// MARK: - Logging

function log(level, message) {
    if (config.logLevel === "none") return
    if (level === "debug" && config.logLevel !== "debug") return
    if (level === "error") console.error(`[hs_windowfilter-gt] ${message}`)
    else console.log(`[hs_windowfilter-gt] ${message}`)
}

// MARK: - The events
//
// Every event a filter can be watched for. The pairs are emitted by comparing a window's
// state before and after something happened to it; the singletons come from a notification.

const EVENTS = [
    "windowCreated",
    "windowDestroyed",
    "windowMoved",
    "windowResized",
    "windowTitleChanged",
    "windowVisible",
    "windowNotVisible",
    "windowOnScreen",
    "windowNotOnScreen",
    "windowFocused",
    "windowUnfocused",
    "windowMinimized",
    "windowUnminimized",
    "windowFullscreened",
    "windowUnfullscreened",
    "windowHidden",
    "windowUnhidden",
    // Emitted when a window starts or stops satisfying a filter's rules, which can happen
    // without the window changing at all: a rule may be set, or the window may move to a
    // screen the filter does not accept.
    "windowAllowed",
    "windowRejected"
]

const EVENT_SET = new Set(EVENTS)

// Which state field each pair of events reports, and which way round. The state machine
// walks this rather than carrying a branch per event.
const STATE_EVENTS = [
    { field: "visible", whenTrue: "windowVisible", whenFalse: "windowNotVisible" },
    { field: "onScreen", whenTrue: "windowOnScreen", whenFalse: "windowNotOnScreen" },
    { field: "focused", whenTrue: "windowFocused", whenFalse: "windowUnfocused" },
    { field: "minimized", whenTrue: "windowMinimized", whenFalse: "windowUnminimized" },
    { field: "fullscreen", whenTrue: "windowFullscreened", whenFalse: "windowUnfullscreened" },
    { field: "hidden", whenTrue: "windowHidden", whenFalse: "windowUnhidden" }
]

// MARK: - Matching values
//
// A rule value is a RegExp, an exact string, an array of either, or a predicate. Lua
// patterns do not survive the port; these are the JavaScript equivalents.

/**
 * Whether a value satisfies a rule.
 *
 * @param {*} rule A RegExp, string, array of those, or a function taking the value.
 * @param {string} value What to test.
 * @returns {boolean} Whether it matches. A rule of null or undefined matches everything.
 */
function matches(rule, value) {
    if (rule === undefined || rule === null) return true
    if (typeof rule === "function") {
        try {
            return Boolean(rule(value))
        } catch (e) {
            log("error", `a rule predicate threw: ${e && e.message ? e.message : e}`)
            return false
        }
    }
    if (Array.isArray(rule)) return rule.some((one) => matches(one, value))
    if (rule instanceof RegExp) return rule.test(String(value === null ? "" : value))
    return String(rule) === String(value === null ? "" : value)
}

/** Whether a point is inside a rectangle, both as {x, y, w, h}. */
function insideRegion(region, frame) {
    if (!region || !frame) return false
    const x = frame.x + frame.w / 2
    const y = frame.y + frame.h / 2
    return x >= region.x && x <= region.x + region.w &&
        y >= region.y && y <= region.y + region.h
}

// MARK: - What a window looks like right now
//
// Read once per event and kept on the record, because every read is an accessibility round
// trip and several rules may need the same values.

/**
 * A window's state, as the rules and the derived events understand it.
 *
 * `hidden` is the application being hidden, which is not the same as the window being
 * minimized, and Hammerspoon 1 reported them separately.
 *
 * @param {object} window An HSWindow.
 * @returns {object} The state, or null if the window can no longer be read.
 */
function windowState(window) {
    try {
        const application = window.application
        const screen = window.screen
        const frame = window.frame
        return {
            id: window.id,
            title: window.title || "",
            application: application ? (application.title || "") : "",
            bundleID: application ? application.bundleID : null,
            pid: application ? application.pid : null,
            role: window.isStandard ? "AXStandardWindow" : "AXWindow",
            standard: Boolean(window.isStandard),
            visible: Boolean(window.isVisible),
            minimized: Boolean(window.isMinimized),
            fullscreen: Boolean(window.isFullscreen),
            hidden: application ? Boolean(application.isHidden) : false,
            focused: false,
            screenName: screen ? screen.name : null,
            screenID: screen ? screen.id : null,
            frame: frame ? { x: frame.x, y: frame.y, w: frame.w, h: frame.h } : null,
            // A window is on screen when it is visible, not minimized and its application
            // is not hidden. Distinct from `visible`, which asks only about the window.
            onScreen: Boolean(window.isVisible) && !window.isMinimized &&
                (application ? !application.isHidden : true)
        }
    } catch (e) {
        // The window no longer exists: it was destroyed between the notification and this read.
        return null
    }
}

/** Whether two states differ in any field the events or rules care about. */
function sameState(a, b) {
    if (!a || !b) return false
    if (a.title !== b.title || a.focused !== b.focused) return false
    for (const { field } of STATE_EVENTS) {
        if (a[field] !== b[field]) return false
    }
    const one = a.frame, two = b.frame
    if (Boolean(one) !== Boolean(two)) return false
    if (one && two && (one.x !== two.x || one.y !== two.y || one.w !== two.w || one.h !== two.h)) return false
    return a.screenID === b.screenID
}

// MARK: - Rules
//
// A rule set is an object. Every key is optional, and an absent key does not constrain.
//
//   visible            true or false
//   fullscreen         true or false
//   focused            true or false
//   hasTitlebar        true or false, meaning a standard window with a title bar
//   activeApplication  true to accept only windows of the frontmost application
//   allowTitles        RegExp, string, array or predicate the title must match
//   rejectTitles       the same, and a match rejects
//   allowRoles         accessibility roles to accept, or "*" for any
//   allowScreens       screen names or ids to accept
//   allowRegions       rectangles; a window whose centre is inside one is accepted
//   allowApplications  application names to accept
//   rejectApplications the same, and a match rejects
//
// Three layers decide whether a window is allowed, in this order, as in Hammerspoon 1:
//
//   1. the override filter, which wins outright when it answers
//   2. the filter for that window's application, when one is set
//   3. the default filter
//
// An application entry may also be `false` to reject the application entirely, or `true`
// to accept it whatever the default says.

/**
 * Whether a window's state satisfies one rule set.
 *
 * @param {object} rules The rule set. Null or undefined allows everything.
 * @param {object} state A state from windowState().
 * @returns {boolean} Whether the window is allowed.
 */
function satisfies(rules, state) {
    if (rules === undefined || rules === null) return true
    if (rules === true) return true
    if (rules === false) return false

    if (rules.visible !== undefined && Boolean(rules.visible) !== state.visible) return false
    if (rules.fullscreen !== undefined && Boolean(rules.fullscreen) !== state.fullscreen) return false
    if (rules.focused !== undefined && Boolean(rules.focused) !== state.focused) return false
    if (rules.hasTitlebar !== undefined && Boolean(rules.hasTitlebar) !== state.standard) return false

    if (rules.activeApplication) {
        const frontmost = hs.application.frontmost()
        if (!frontmost || frontmost.pid !== state.pid) return false
    }

    if (rules.allowTitles !== undefined && !matches(rules.allowTitles, state.title)) return false
    if (rules.rejectTitles !== undefined && matches(rules.rejectTitles, state.title)) return false

    if (rules.allowApplications !== undefined && !matches(rules.allowApplications, state.application)) return false
    if (rules.rejectApplications !== undefined && matches(rules.rejectApplications, state.application)) return false

    if (rules.allowRoles !== undefined && rules.allowRoles !== "*" &&
        !matches(rules.allowRoles, state.role)) return false

    if (rules.allowScreens !== undefined) {
        const byName = matches(rules.allowScreens, state.screenName)
        const byID = state.screenID !== null && matches(rules.allowScreens, String(state.screenID))
        if (!byName && !byID) return false
    }

    if (rules.allowRegions !== undefined) {
        const regions = Array.isArray(rules.allowRegions) ? rules.allowRegions : [rules.allowRegions]
        if (!regions.some((region) => insideRegion(region, state.frame))) return false
    }

    return true
}

// MARK: - A filter
//
// An instance holds its rules and its watchers. It is registered with the tracker for as
// long as it has a watcher, so a filter with no watchers costs nothing.

class WindowFilter {
    /**
     * @param {object} [rules] The default rule set. See above.
     */
    constructor(rules) {
        this.defaultRules = rules === undefined ? {} : rules
        this.applicationRules = new Map()   // application name -> rules, true or false
        this.overrideRules = null
        // event -> Set of handlers
        this.watchers = new Map()
        // Window id -> whether this filter allowed it last time it was asked, so that
        // windowAllowed and windowRejected can be emitted when the answer changes.
        this.allowed = new Map()
    }

    /** Replace the default rule set. */
    setDefaultFilter(rules) {
        this.defaultRules = rules === undefined ? {} : rules
        return this
    }

    /**
     * Set the rules for one application, by name.
     *
     * @param {string} application The application's title.
     * @param {object|boolean} rules Rules, `true` to always allow, `false` to always reject.
     */
    setApplicationFilter(application, rules) {
        if (rules === undefined || rules === null) this.applicationRules.delete(application)
        else this.applicationRules.set(application, rules)
        return this
    }

    /** Rules consulted before everything else. Null removes them. */
    setOverrideFilter(rules) {
        this.overrideRules = rules === undefined ? null : rules
        return this
    }

    /**
     * Whether this filter accepts a window, by the three-layer order.
     *
     * @param {object} state A state from windowState().
     * @returns {boolean} Whether it is allowed.
     */
    allows(state) {
        if (!state) return false
        if (this.overrideRules !== null) return satisfies(this.overrideRules, state)

        if (this.applicationRules.has(state.application)) {
            return satisfies(this.applicationRules.get(state.application), state)
        }
        return satisfies(this.defaultRules, state)
    }

    /**
     * Watch for one or more events.
     *
     * @param {string|Array} events An event name, or an array of them. See EVENTS.
     * @param {function} handler Called as `(event, window, state)`.
     * @returns {object} This filter.
     */
    addWatcher(events, handler) {
        if (typeof handler !== "function") {
            log("error", "addWatcher needs a function")
            return this
        }
        for (const event of [].concat(events)) {
            if (!EVENT_SET.has(event)) {
                log("error", `no such event: ${event}`)
                continue
            }
            if (!this.watchers.has(event)) this.watchers.set(event, new Set())
            this.watchers.get(event).add(handler)
        }
        trackerStart()
        return this
    }

    /**
     * Stop watching. Omit the handler to remove every handler for those events, and omit
     * both to remove everything.
     */
    removeWatcher(events, handler) {
        if (events === undefined) {
            this.watchers.clear()
        } else {
            for (const event of [].concat(events)) {
                const set = this.watchers.get(event)
                if (!set) continue
                if (handler === undefined) set.clear()
                else set.delete(handler)
                if (!set.size) this.watchers.delete(event)
            }
        }
        trackerStopIfIdle()
        return this
    }

    /** Whether anything is listening to this filter. */
    isWatched() {
        for (const set of this.watchers.values()) {
            if (set.size) return true
        }
        return false
    }

    /**
     * The windows this filter accepts, as HSWindow objects.
     *
     * Ordered front to back, so the first is the most recently focused.
     */
    windows() {
        return hs.window.orderedWindows().filter((window) => {
            const state = windowState(window)
            return state ? this.allows(state) : false
        })
    }

    /** Whether a window is accepted right now. */
    isWindowAllowed(window) {
        const state = windowState(window)
        return state ? this.allows(state) : false
    }

    /** Called by the tracker. Not part of the public API. */
    _deliver(event, window, state) {
        const set = this.watchers.get(event)
        if (!set || !set.size) return
        for (const handler of [...set]) {
            try {
                handler(event, window, state)
            } catch (e) {
                log("error", `a ${event} handler threw: ${e && e.message ? e.message : e}`)
            }
        }
    }

    /**
     * Emit windowAllowed or windowRejected when this filter's answer for a window changes.
     *
     * Separate from the state events: a window can start or stop being allowed without
     * changing at all, because the filter's own rules changed.
     */
    _reconsider(window, state) {
        const id = state ? state.id : (window ? window.id : null)
        if (id === null) return

        const now = state ? this.allows(state) : false
        const was = this.allowed.get(id)
        if (was === now) return

        this.allowed.set(id, now)
        // Nothing is emitted the first time a window is seen and rejected: it was never
        // allowed, so it has not become rejected.
        if (was === undefined && !now) return
        this._deliver(now ? "windowAllowed" : "windowRejected", window, state)
    }

    /** Called by the tracker when a window goes away. */
    _forget(id) {
        this.allowed.delete(id)
    }
}

// MARK: - The tracker
//
// One set of accessibility watchers, feeding every filter. It runs only while at least one
// filter is being watched, so loading this Spoon and never subscribing costs nothing.
//
// Two levels of watcher:
//
//   Per application — windowCreated and focusedWindowChanged. These are posted by the
//   application element, so one registration covers all of its windows, including windows
//   that do not exist yet.
//
//   Per window — uIElementDestroyed, windowMoved, windowResized, windowMiniaturized,
//   windowDeminiaturized and titleChanged. These are posted by the window element and do
//   not reach the application element; AXUIElementDestroyed in particular is delivered only
//   to the element that is being destroyed. Watching windows individually became possible
//   in Hammerspoon 2 only recently, and it is what makes this module work at all.

const filters = new Set()               // every WindowFilter ever created
let tracking = false

const tracked = new Map()               // window id -> {window, element, state, handler}
const trackedApps = new Map()           // pid -> {application, element, handler}
let applicationWatcher = null

// Debounce timers, by window id, held so they are not collected before they fire.
const pending = new Map()

const WINDOW_NOTIFICATIONS = () => [
    hs.ax.notificationTypes.uIElementDestroyed,
    hs.ax.notificationTypes.windowMoved,
    hs.ax.notificationTypes.windowResized,
    hs.ax.notificationTypes.windowMiniaturized,
    hs.ax.notificationTypes.windowDeminiaturized,
    hs.ax.notificationTypes.titleChanged
]

const APPLICATION_NOTIFICATIONS = () => [
    hs.ax.notificationTypes.windowCreated,
    hs.ax.notificationTypes.focusedWindowChanged
]

/** Whether an application is worth watching at all. */
function worthTracking(application) {
    if (!application) return false
    if (application.kind !== "standard") return false
    const title = application.title || ""
    return !config.skipApplications.includes(title)
}

// MARK: Emitting

/**
 * Hand a batch of events, all describing one change, to every filter concerned.
 *
 * Concerned means the filter allowed the window before the change or allows it after, not
 * merely after. The difference is the whole value of the leaving events: a filter of
 * `visible: true` watching windowMinimized needs to receive the minimize event, and that is
 * the moment the window stops being visible. Testing only the new state would report windows
 * that start matching but never those that stop.
 *
 * The events have to arrive together, which is why this takes a batch. One change usually
 * flips several fields at once — minimizing a window makes it not visible, not on screen
 * and minimized — and the decision about whether the filter is concerned belongs to the
 * change, not to each event. Deciding per event meant the first event evaluated moved
 * the filter from allowed to rejected, and the remaining events were then evaluated against
 * that updated result and discarded.
 *
 * windowAllowed or windowRejected is emitted first, so a handler watching both receives it
 * before the events describing the change.
 */
function deliver(window, state, events) {
    if (!events.length) return
    const id = state ? state.id : (window ? window.id : null)

    for (const filter of filters) {
        if (!filter.isWatched()) continue

        const was = id === null ? false : filter.allowed.get(id) === true
        filter._reconsider(window, state)
        const now = state ? filter.allows(state) : false
        if (!was && !now) continue

        for (const event of events) filter._deliver(event, window, state)
    }
}

/** One event on its own. */
function emit(event, window, state) {
    deliver(window, state, [event])
}

/** windowDestroyed is emitted to filters that were allowing the window when it went. */
function emitDestroyed(record) {
    for (const filter of filters) {
        if (filter.isWatched() && filter.allowed.get(record.state.id)) {
            filter._deliver("windowDestroyed", record.window, record.state)
        }
        filter._forget(record.state.id)
    }
}

/**
 * Recompute a window's state and emit whatever changed.
 *
 * Most events originate here. An accessibility notification reports only that a window
 * changed; comparing its new state against the previous one determines what changed.
 */
function refresh(id, alsoEmit) {
    const record = tracked.get(id)
    if (!record) return

    const state = windowState(record.window)
    if (!state) {
        forgetWindow(id)
        return
    }
    state.focused = isFocused(id)

    const was = record.state
    record.state = state

    // Collected rather than emitted one by one: they all describe the same change, and the
    // filter has to judge them together. See deliver().
    const events = []
    if (alsoEmit) events.push(alsoEmit)

    if (was) {
        for (const { field, whenTrue, whenFalse } of STATE_EVENTS) {
            if (was[field] === state[field]) continue
            events.push(state[field] ? whenTrue : whenFalse)
        }
        if (was.title !== state.title && alsoEmit !== "windowTitleChanged") {
            events.push("windowTitleChanged")
        }
    }

    deliver(record.window, state, events)
}

function isFocused(id) {
    const focused = hs.window.focusedWindow()
    return Boolean(focused && focused.id === id)
}

/** Hold an event until the burst it belongs to has finished. */
function debounce(id, key, seconds, action) {
    const existing = pending.get(key)
    if (existing) existing.stop()
    pending.set(key, hs.timer.doAfter(seconds, () => {
        pending.delete(key)
        action()
    }))
}

// MARK: Windows

function trackWindow(window) {
    if (!window) return
    const id = window.id
    if (tracked.has(id)) return

    const state = windowState(window)
    if (!state) return
    state.focused = isFocused(id)

    const element = window.axElement()
    if (!element) {
        log("debug", `no accessibility element for window ${id}`)
        return
    }

    const handler = (notification) => {
        switch (notification) {
        case "uIElementDestroyed":
            forgetWindow(id, true)
            break
        case "windowMoved":
            debounce(id, `${id}:moved`, config.moveDebounce, () => refresh(id, "windowMoved"))
            break
        case "windowResized":
            debounce(id, `${id}:resized`, config.moveDebounce, () => refresh(id, "windowResized"))
            break
        case "titleChanged":
            debounce(id, `${id}:title`, config.titleDebounce, () => refresh(id, "windowTitleChanged"))
            break
        default:
            // Miniaturized and deminiaturized are reported by the state comparison rather
            // than passed through, so that they cannot be emitted twice.
            //
            // Held briefly first, because accessibility does not flip a window's
            // properties together. Minimizing reports isVisible false before isMinimized
            // becomes true, so reading immediately sees a half-changed window and emits
            // windowNotVisible on its own; the rest of the transition then arrives after
            // the window has left the filter, where it is rightly suppressed. Waiting for
            // the properties to settle produces one comparison and the whole transition.
            debounce(id, `${id}:state`, config.stateDebounce, () => refresh(id))
        }
    }

    try {
        hs.ax.addWatcher(element, WINDOW_NOTIFICATIONS(), handler)
    } catch (e) {
        log("error", `could not watch window ${id}: ${e && e.message ? e.message : e}`)
        return
    }

    tracked.set(id, { window: window, element: element, state: state, handler: handler })
    emit("windowCreated", window, state)
}

function forgetWindow(id, destroyed) {
    const record = tracked.get(id)
    if (!record) return

    try {
        hs.ax.removeWatcher(record.element, WINDOW_NOTIFICATIONS(), record.handler)
    } catch (e) {
        // Expected when the window has been destroyed: its element is already invalid.
        log("debug", `watcher for window ${id} was already gone`)
    }
    tracked.delete(id)

    for (const [key, timer] of [...pending]) {
        if (key.startsWith(`${id}:`)) {
            timer.stop()
            pending.delete(key)
        }
    }

    if (destroyed) emitDestroyed(record)
    else for (const filter of filters) filter._forget(id)
}

// MARK: Applications

function trackApplication(application) {
    if (!worthTracking(application)) return
    const pid = application.pid
    if (pid === null || pid === undefined || trackedApps.has(pid)) return

    const element = application.axElement()
    if (!element) return

    const handler = (notification) => {
        if (notification === "windowCreated") {
            // The new window is not always readable the instant the notification arrives.
            debounce(pid, `app${pid}:created`, 0.05, () => scanApplication(application))
        } else {
            // focusedWindowChanged: which window is focused has moved within this
            // application, so every window of it may have changed focus state.
            for (const [id, record] of tracked) {
                if (record.state && record.state.pid === pid) refresh(id)
            }
        }
    }

    try {
        hs.ax.addWatcher(element, APPLICATION_NOTIFICATIONS(), handler)
    } catch (e) {
        log("error", `could not watch ${application.title}: ${e && e.message ? e.message : e}`)
        return
    }

    trackedApps.set(pid, { application: application, element: element, handler: handler })
    scanApplication(application)
}

function forgetApplication(pid) {
    const record = trackedApps.get(pid)
    if (!record) return

    try {
        hs.ax.removeWatcher(record.element, APPLICATION_NOTIFICATIONS(), record.handler)
    } catch (e) {
        log("debug", `watcher for application ${pid} was already gone`)
    }
    trackedApps.delete(pid)

    for (const [id, window] of [...tracked]) {
        if (window.state && window.state.pid === pid) forgetWindow(id, true)
    }
}

function scanApplication(application) {
    let windows = []
    try {
        windows = application.allWindows || []
    } catch (e) {
        return
    }
    for (const window of windows) trackWindow(window)
}

// MARK: Starting and stopping

function trackerStart() {
    if (tracking) return
    tracking = true

    for (const application of hs.application.runningApplications()) trackApplication(application)

    applicationWatcher = (event, application) => {
        switch (event) {
        case "didLaunch":
            trackApplication(application)
            break
        case "didTerminate":
            if (application) forgetApplication(application.pid)
            break
        default:
            // didActivate, didDeactivate, didHide, didUnhide all change which windows are
            // focused or on screen, and the state comparison works out which.
            for (const id of [...tracked.keys()]) refresh(id)
        }
    }
    hs.application.addWatcher(applicationWatcher)
    log("debug", `tracking ${trackedApps.size} applications, ${tracked.size} windows`)
}

/** Stop when no filter is being watched, so an idle configuration holds no observers. */
function trackerStopIfIdle() {
    if (!tracking) return
    for (const filter of filters) {
        if (filter.isWatched()) return
    }
    trackerStop()
}

function trackerStop() {
    if (!tracking) return
    tracking = false

    if (applicationWatcher) {
        hs.application.removeWatcher(applicationWatcher)
        applicationWatcher = null
    }
    for (const id of [...tracked.keys()]) forgetWindow(id)
    for (const pid of [...trackedApps.keys()]) forgetApplication(pid)
    for (const [key, timer] of [...pending]) {
        timer.stop()
        pending.delete(key)
    }
}

// MARK: - Public API

/**
 * A new filter.
 *
 * @param {object} [rules] Its default rule set.
 * @returns {object} A WindowFilter.
 */
function create(rules) {
    const filter = new WindowFilter(rules)
    filters.add(filter)
    return filter
}

/** Discard a filter and stop the tracker if it was the last one being watched. */
function destroy(filter) {
    if (!filter) return false
    filter.removeWatcher()
    const had = filters.delete(filter)
    trackerStopIfIdle()
    return had
}

/** What the tracker is watching. Useful when an expected event is not arriving. */
function status() {
    return {
        tracking: tracking,
        applications: trackedApps.size,
        windows: tracked.size,
        filters: filters.size,
        watched: [...filters].filter((f) => f.isWatched()).length
    }
}

function start() {
    return module.exports
}

function stop() {
    trackerStop()
    for (const filter of filters) filter.removeWatcher()
    filters.clear()
    return module.exports
}

// Visible windows of ordinary applications, which is what most callers want. Hammerspoon's
// own windows are left out: a filter reporting Hammerspoon's menu windows is rarely useful.
const defaultFilter = create({
    visible: true,
    rejectApplications: config.skipInDefault
})

module.exports = {
    config,
    events: EVENTS,
    create,
    destroy,
    default: defaultFilter,
    status,
    // For callers that want the pieces without a filter.
    windowState,
    matches,
    start,
    stop
}
