// hs_selectWindow-gt — switch windows by typing part of a title, with a preview.
//
// A port of the Hammerspoon 1 hs_select_window Spoon. The chooser lists windows in
// most-recently-used order, searches title and application name together, and shows a
// picture of the selected window while you move through the list.
//
//     const sw = hs.loadSpoon("hs_selectWindow-gt")
//     sw.selectWindow()                    // every window
//     sw.selectApplicationWindow()         // the focused application's windows
//     sw.selectApp()                       // one window per application
//     sw.selectPreviousWindow()            // straight to the last used, no chooser
//
// No keys are bound. bindHotkeys() is available for a caller that wants them, and the
// commands are meant to be reached from hs_interactive-gt in this configuration.
//
// Both the list of windows and their order come from hs_windowfilter-gt. That Spoon already
// tracks every window and holds its title, application, screen and flags, kept current by
// the notifications it subscribes to, so this Spoon never enumerates windows itself and
// never reads a property off one. It subscribes to windowFocused and keeps the ids in the
// order they were last focused.
//
// Asking hs.window instead is what made this slow. allWindows(), orderedWindows() and
// visibleWindows() each walk every running process rather than every application: 1556 ms
// for 23 windows on one machine, against 18 ms per application, against nothing at all for
// asking the tracker. Their front-to-back order also leaves out minimized windows and
// windows of a hidden application, which a switcher is precisely for.
//
// Five of the Hammerspoon 1 Spoon's bindings are not ported: all_windows_ws,
// app_windows_ws, previous_window_ws, previous_app_window_ws and
// all_windows_move_to_current_workspace. Every one of them narrows by workspace or moves a
// window between workspaces, and Hammerspoon 2 has no spaces module. The workspace column
// in the chooser subtext is absent for the same reason.

// MARK: - User-configurable settings

const config = {
    // Rows visible in the chooser at once.
    rowsToDisplay: 14,

    // Width of the chooser, as a fraction of the screen's width, which is what
    // hs.chooser.width takes. Its own default is 0.5.
    //
    // Wide displays get a narrower fraction: on an ultrawide monitor half the screen puts
    // the title and the line under it so far apart that neither is easy to read.
    width: 0.4,
    wideWidth: 0.22,
    wideScreenPoints: 3000,

    // A picture of the selected window, drawn above the chooser. Off for now: taking one
    // costs around 150ms per window and the drawing has not been looked at on screen yet.
    // Tab turns it on while the chooser is open, so it can be tried without changing this.
    showThumbnail: false,
    // Height of the picture as a fraction of the screen's height.
    thumbnailHeightRatio: 0.4,
    // How often the selected row is read while the chooser is open. There is no callback
    // for the selection changing, so it is polled.
    selectionPollSeconds: 0.15,
    // Snapshots are kept while the chooser is open. Keeping them afterwards makes the next
    // invocation faster and the pictures older; Shift+Tab redraws the selected one.
    persistentThumbnailCache: false,

    // Keys bound only while the chooser is open.
    thumbnailToggleKey: "tab",
    thumbnailRefreshKey: "tab",       // with shift

    // Windows never offered.
    skipApplications: ["Hammerspoon", "Hammerspoon 2"],

    // Log how long each step of opening the chooser took, and which application was in
    // front at the time. Opening it should be under about 100ms; set this when it is not,
    // and the next slow one says which step was slow rather than leaving it to guesswork.
    logTimings: false,
    // Only report when the total reaches this many milliseconds. 0 reports every time.
    logTimingsOver: 250
}

// MARK: - State

let filter = null                  // the hs_windowfilter-gt instance used for focus order
let focusOrder = []                // window ids, most recently focused first
let chooser = null
let pollTimer = null
let overlay = null                 // the canvas showing the thumbnail
let thumbnails = new Map()         // window id -> HSImage
let showingThumbnail = config.showThumbnail
let sessionKeys = []               // hotkeys bound only while the chooser is open
let lastDrawnId = null
// Window id -> window, for the chooser that is open. Enumerating windows is the most
// expensive thing this Spoon does, so it is done once and the result kept until the
// chooser closes.
let sessionWindows = new Map()

// The last few openings, kept so a slow one can be looked at afterwards. The console has no
// history that can be read back, and a message that has scrolled away is no use when the
// thing being investigated happens once in five times.
const recentTimings = []

function log(message) {
    console.error(`[hs_selectWindow-gt] ${message}`)
}

// MARK: - Most-recently-used order

/**
 * Record that a window was focused, moving it to the front of the order.
 *
 * Called from the window filter rather than polled, so the order is right even for windows
 * that were focused and then minimized.
 */
function noteFocused(id) {
    if (id === null || id === undefined) return
    const at = focusOrder.indexOf(id)
    if (at !== -1) focusOrder.splice(at, 1)
    focusOrder.unshift(id)
}

function startTrackingFocus() {
    if (filter) return

    const windowfilter = hs.loadSpoon("hs_windowfilter-gt")
    if (!windowfilter) {
        log("hs_windowfilter-gt is not available, so windows are listed front to back rather than by use")
        return
    }

    // Every window, including minimized ones: a minimized window is exactly what a switcher
    // is for, and its place in the order has to be remembered while it is out of sight.
    filter = windowfilter.create({ rejectApplications: config.skipApplications })
    filter.addWatcher("windowFocused", (event, window, state) => noteFocused(state.id))
    filter.addWatcher("windowDestroyed", (event, window, state) => {
        const at = focusOrder.indexOf(state.id)
        if (at !== -1) focusOrder.splice(at, 1)
        thumbnails.delete(state.id)
    })

    // Seed with what is open now, so the order is useful before anything has been focused.
    // Beyond the focused window below, the seeding order is arbitrary: the tracker holds
    // its windows by id rather than front to back. One focus change corrects it, and
    // reading a front-to-back order costs a second and a half. See switchableRecords().
    for (const record of filter.records()) noteFocused(record.state.id)

    // The focused window belongs at the front. Taken from the tracker, which knows which
    // window that is; asking hs.window.focusedWindow() would query the frontmost
    // application through accessibility and wait for however long it takes to answer.
    const current = filter.records().find((record) => record.state.focused)
    if (current) noteFocused(current.state.id)
}

/** Records in most-recently-used order. Those never focused come last. */
function recordsByUse(records) {
    const rank = new Map()
    focusOrder.forEach((id, index) => rank.set(id, index))

    return records.slice().sort((a, b) => {
        const one = rank.has(a.state.id) ? rank.get(a.state.id) : Number.MAX_SAFE_INTEGER
        const two = rank.has(b.state.id) ? rank.get(b.state.id) : Number.MAX_SAFE_INTEGER
        return one - two
    })
}

// MARK: - Which windows to offer

/**
 * The windows to offer, with the state the tracker holds for each.
 *
 * Taken from hs_windowfilter-gt rather than enumerated. The tracker already holds every
 * window it watches, along with its title, application, screen and flags, kept current by
 * the notifications it subscribes to. Asking it costs nothing.
 *
 * Enumerating instead is what made this Spoon slow: hs.window.allWindows(),
 * orderedWindows() and visibleWindows() all walk every running process rather than every
 * application — 1556 ms for 23 windows on one machine, against 18 ms for the same windows
 * gathered per application, and none at all for asking the tracker.
 *
 * @returns {Array} `{window, state}` objects, in no particular order.
 */
function switchableRecords() {
    startTrackingFocus()
    if (!filter) return []
    return filter.records().filter((record) => record.state.standard)
}

function switchable() {
    return switchableRecords().map((record) => record.window)
}

/** Every switchable window, most recently used first. */
function allRecords() {
    return recordsByUse(switchableRecords())
}

/**
 * Records for one application, most recently used first. Defaults to the focused one.
 *
 * Which application that is comes from the tracker's own record of which window has focus,
 * not from hs.window.focusedWindow(), which waits on the frontmost application. The first
 * record in use order is a fallback for the moment after a reload, before any focus change
 * has been seen.
 */
function applicationRecords(application) {
    const ordered = allRecords()
    let wanted = application
    if (!wanted) {
        const current = ordered.find((record) => record.state.focused) || ordered[0]
        wanted = current ? current.state.application : null
    }
    if (!wanted) return []
    return ordered.filter((record) => record.state.application === wanted)
}

/**
 * The most recently used window of each application.
 *
 * The list is already in use order, so the first record seen for an application is the one
 * to offer for it.
 */
function firstRecordPerApplication() {
    const seen = new Set()
    return allRecords().filter((record) => {
        if (seen.has(record.state.application)) return false
        seen.add(record.state.application)
        return true
    })
}

// MARK: - The thumbnail
//
// Drawn on a canvas beside the chooser. The chooser reports no callback when the selection
// moves, so the selected row is read on a timer while the chooser is open.

function thumbnailFrame(image) {
    const screen = hs.screen.main() || hs.screen.primary()
    const reference = hs.screen.primary() || screen
    if (!screen || !reference) return null

    const area = screen.fullFrame
    const primary = reference.fullFrame

    const size = image.size
    const height = area.h * config.thumbnailHeightRatio
    const width = size && size.h ? height * (size.w / size.h) : height

    // Centred horizontally, above the middle of the screen, so it does not sit under the
    // chooser itself.
    const left = area.x + (area.w - width) / 2
    const top = area.y + area.h * 0.12

    // hs.screen measures y downwards from the top of the primary display and a canvas
    // upwards from its bottom.
    return {
        x: left,
        y: (primary.y + primary.h) - (top + height),
        w: width,
        h: height
    }
}

function hideThumbnail() {
    if (!overlay) return
    overlay.destroy()
    overlay = null
    lastDrawnId = null
}

function drawThumbnail(image) {
    hideThumbnail()
    if (!image) return

    const frame = thumbnailFrame(image)
    if (!frame) return

    overlay = hs.canvas.create(frame)
        .level("popUpMenu")
        .ignoreMouseEvents(true)
        .behaviorList(["canJoinAllSpaces", "stationary"])

    overlay.appendElements([
        {
            type: "rectangle",
            action: "fill",
            fillColor: { red: 0, green: 0, blue: 0, alpha: 0.55 },
            frame: { x: 0, y: 0, w: frame.w, h: frame.h },
            roundedRectRadii: { xRadius: 10, yRadius: 10 }
        },
        {
            type: "image",
            image: image,
            frame: { x: 4, y: 4, w: frame.w - 8, h: frame.h - 8 },
            imageScaling: "scaleProportionally",
            imageAlignment: "center"
        }
    ])
    overlay.show()
}

/**
 * Show the picture for a window, taking it if it has not been taken already.
 *
 * A snapshot costs on the order of 150ms, so one is taken per window and kept for as long
 * as the chooser is open. Passing `force` retakes it.
 */
function showThumbnailFor(id, force) {
    if (!showingThumbnail) return
    if (id === null || id === undefined) {
        hideThumbnail()
        return
    }

    if (!force && thumbnails.has(id)) {
        if (id !== lastDrawnId) {
            drawThumbnail(thumbnails.get(id))
            lastDrawnId = id
        }
        return
    }

    const window = sessionWindows.get(id)
    if (!window) {
        hideThumbnail()
        return
    }

    window.snapshot().then((image) => {
        if (!image) return
        thumbnails.set(id, image)
        // The selection may have moved on while the snapshot was being taken.
        if (showingThumbnail && selectedWindowId() === id) {
            drawThumbnail(image)
            lastDrawnId = id
        }
    }, () => {
        // A window that cannot be captured simply has no picture.
    })
}

function selectedWindowId() {
    if (!chooser || !chooser.isVisible) return null
    const row = chooser.selectedRow
    const contents = chooser.selectedRowContents(row)
    return contents && contents.id !== undefined ? contents.id : null
}

function startPolling() {
    stopPolling()
    pollTimer = hs.timer.doEvery(config.selectionPollSeconds, () => {
        if (!chooser || !chooser.isVisible) return
        const id = selectedWindowId()
        if (id !== lastDrawnId) showThumbnailFor(id)
    })
}

function stopPolling() {
    if (!pollTimer) return
    pollTimer.stop()
    pollTimer = null
}

// MARK: - Keys bound while the chooser is open

function takeSessionKeys() {
    releaseSessionKeys()

    const toggle = hs.hotkey.bind([], config.thumbnailToggleKey, () => {
        showingThumbnail = !showingThumbnail
        if (showingThumbnail) showThumbnailFor(selectedWindowId())
        else hideThumbnail()
    }, null)

    const refresh = hs.hotkey.bind(["shift"], config.thumbnailRefreshKey, () => {
        lastDrawnId = null
        showThumbnailFor(selectedWindowId(), true)
    }, null)

    sessionKeys = [toggle, refresh].filter(Boolean)
}

function releaseSessionKeys() {
    for (const key of sessionKeys) {
        if (key) key.destroy()
    }
    sessionKeys = []
}

// MARK: - The chooser

// Built from the tracker's state rather than by reading the window again.
function subTextFor(state) {
    const parts = [state.application || "?"]
    if (state.screenName) parts.push(state.screenName)
    if (state.minimized) parts.push("minimized")
    if (state.hidden) parts.push("hidden")
    return parts.join("  ·  ")
}

function choicesFor(records) {
    // One icon per application rather than one per row.
    const icons = new Map()
    const iconFor = (bundleID) => {
        if (!bundleID) return null
        if (!icons.has(bundleID)) icons.set(bundleID, HSImage.fromAppBundle(bundleID))
        return icons.get(bundleID)
    }

    return records.map(({ state }) => ({
        text: state.title || state.application || "window",
        subText: subTextFor(state),
        image: iconFor(state.bundleID),
        id: state.id
    }))
}

function chooserWidth() {
    const screen = hs.screen.main() || hs.screen.primary()
    if (!screen) return config.width
    return screen.fullFrame.w > config.wideScreenPoints ? config.wideWidth : config.width
}

/**
 * Show a chooser over a list of windows, and focus whichever is chosen.
 *
 * @param {Array} windows The windows to offer, in the order to offer them.
 * @param {string} placeholder Prompt text.
 */
function chooseFrom(records, placeholder) {
    if (!records.length) {
        hs.ui.alert("No windows to choose from").duration(2).show()
        return null
    }

    // Timings are taken whether or not they are reported: reading a clock costs nothing
    // next to the work between the readings, and a step that is only measured when
    // measurement is switched on is the step nobody ever measures.
    const marks = []
    const mark = (what) => marks.push([what, Date.now()])
    mark("start")

    startTrackingFocus()
    mark("tracking")

    sessionWindows = new Map(records.map((r) => [r.state.id, r.window]))
    if (!config.persistentThumbnailCache) thumbnails = new Map()
    showingThumbnail = config.showThumbnail
    lastDrawnId = null
    mark("session")

    chooser = hs.chooser.create()
    chooser.placeholder = placeholder || "Window"
    chooser.searchSubText = true
    chooser.visibleRows = config.rowsToDisplay
    chooser.width = chooserWidth()
    mark("chooser created")

    chooser.setChoices(choicesFor(records))
    mark("choices built")

    chooser.onSelect = (item) => {
        finishChoosing()
        if (!item || item.id === undefined) return
        focusWindowById(item.id)
    }

    chooser.onShow = () => {
        takeSessionKeys()
        startPolling()
        // The first row is selected when the chooser opens.
        showThumbnailFor(records[0].state.id)
    }

    chooser.onHide = () => finishChoosing()

    chooser.show()
    mark("shown")
    reportTimings(marks, records.length)
    return chooser
}

/**
 * Say how long each step took, when the total is worth reporting.
 *
 * The application in front is included because the cost of reading windows depends on which
 * applications are running and how promptly they answer accessibility.
 */
function reportTimings(marks, rows) {
    const total = marks[marks.length - 1][1] - marks[0][1]

    const steps = []
    for (let i = 1; i < marks.length; i++) {
        steps.push(`${marks[i][0]} ${marks[i][1] - marks[i - 1][1]}ms`)
    }
    const front = hs.application.frontmost()
    const entry = {
        at: new Date().toTimeString().slice(0, 8),
        total: total,
        rows: rows,
        front: front ? front.title : "none",
        steps: steps.join(", ")
    }

    // Kept whether or not it is logged: the interesting case is the one nobody was
    // watching for.
    recentTimings.push(entry)
    if (recentTimings.length > 40) recentTimings.shift()

    if (config.logTimings && total >= config.logTimingsOver) {
        console.log(`[hs_selectWindow-gt] chooser took ${total}ms for ${rows} rows ` +
                    `(front: ${entry.front}) — ${entry.steps}`)
    }
}

/**
 * The last few times the chooser was opened, most recent last.
 *
 * Each entry says when, how long in total, how many rows, what was in front, and how long
 * each step took. A slow opening whose total is small means the time went before this
 * Spoon was reached, which points at the key or the main thread rather than at the chooser.
 */
function timings() {
    return recentTimings.map((t) =>
        `${t.at}  ${String(t.total).padStart(5)}ms  ${String(t.rows).padStart(3)} rows  ` +
        `front: ${t.front.padEnd(16)} ${t.steps}`)
}

function finishChoosing() {
    stopPolling()
    releaseSessionKeys()
    hideThumbnail()
    if (!config.persistentThumbnailCache) thumbnails = new Map()
    sessionWindows = new Map()
    chooser = null
}

/**
 * Focus a window by id, bringing its application forward.
 *
 * Through hs_window-gt when it is loaded, because window.focus() alone does not raise the
 * application when Hammerspoon is not frontmost, which it is not here.
 */
function focusWindowById(id) {
    // From the chooser's own list when one is open, so that choosing a window does not pay
    // to enumerate them all over again.
    const window = sessionWindows.get(id) || switchable().find((w) => w.id === id)
    if (!window) return false

    const helper = hs.spoons ? hs.spoons["hs_window-gt"] : null
    if (helper && typeof helper.focusWindow === "function") return helper.focusWindow(window)

    window.focus()
    const bundleID = window.application ? window.application.bundleID : null
    if (bundleID) hs.application.launchOrFocus(bundleID)
    return true
}

// MARK: - Public API

/** Choose from every switchable window, most recently used first. */
function selectWindow() {
    return chooseFrom(allRecords(), "Window")
}

/** Choose from the focused application's windows. */
function selectApplicationWindow(application) {
    const records = applicationRecords(application)
    const name = records.length ? records[0].state.application : "Application"
    return chooseFrom(records, name)
}

/** Choose from the most recently used window of each application. */
function selectApp() {
    return chooseFrom(firstRecordPerApplication(), "Application")
}

/**
 * Go straight to the previously used window, with no chooser.
 *
 * The first entry in the order is the window in front now, so the second is the one before.
 */
function selectPreviousWindow() {
    const records = allRecords()
    if (records.length < 2) {
        hs.ui.alert("No previous window").duration(2).show()
        return false
    }
    return focusWindowById(records[1].state.id)
}

/** Go straight to the previously used window of the focused application. */
function selectPreviousApplicationWindow() {
    const records = applicationRecords()
    if (records.length < 2) {
        hs.ui.alert("No previous window in this application").duration(2).show()
        return false
    }
    return focusWindowById(records[1].state.id)
}

/** The order the switcher will offer windows in, as titles. For looking at the ordering. */
function order() {
    return allRecords().map(({ state }) => `${state.application}: ${state.title}`)
}

let hotkeys = []

/**
 * Bind hotkeys.
 *
 * @param {object} mapping Keyed by action name — `allWindows`, `applicationWindows`,
 *        `firstWindowPerApp`, `previousWindow`, `previousApplicationWindow` — each holding
 *        `[[modifiers], key]`.
 */
function bindHotkeys(mapping) {
    const actions = {
        allWindows: () => selectWindow(),
        applicationWindows: () => selectApplicationWindow(),
        firstWindowPerApp: () => selectApp(),
        previousWindow: () => selectPreviousWindow(),
        previousApplicationWindow: () => selectPreviousApplicationWindow()
    }

    for (const [name, spec] of Object.entries(mapping || {})) {
        if (!actions[name]) {
            log(`unknown hotkey action: ${name}`)
            continue
        }
        hotkeys.push(hs.hotkey.bind(spec[0], spec[1], actions[name], null))
    }
    return module.exports
}

function start() {
    startTrackingFocus()
    return module.exports
}

function stop() {
    finishChoosing()
    if (chooser) chooser.hide()
    chooser = null

    if (filter) {
        const windowfilter = hs.spoons ? hs.spoons["hs_windowfilter-gt"] : null
        if (windowfilter) windowfilter.destroy(filter)
        filter = null
    }
    focusOrder = []
    thumbnails = new Map()

    for (const key of hotkeys) {
        if (key) key.destroy()
    }
    hotkeys = []
    return module.exports
}

module.exports = {
    config,
    selectWindow,
    selectApplicationWindow,
    selectApp,
    selectPreviousWindow,
    selectPreviousApplicationWindow,
    order,
    timings,
    bindHotkeys,
    start,
    stop
}
