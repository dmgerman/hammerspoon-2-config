// hs_kitty-gt — switch between kitty's tabs, and create them, from the keyboard.
//
// kitty holds several terminals in one application, and macOS window switching cannot see
// inside it: every tab is the same window. This Spoon asks kitty what it has and switches
// tabs by name, so a tab is reachable in the same way as a window.
//
//     const kitty = hs.loadSpoon("hs_kitty-gt")
//     kitty.chooseTab()                      // pick a tab from a chooser
//     kitty.tabs()                           // what is open, most recently used first
//     kitty.focusTab("neon")                 // by title
//     kitty.newTab("neon", "autossh neon")   // create one, optionally running something
//     kitty.goToTab("neon", "autossh neon")  // focus it, creating it if it is not there
//
// A port of the Hammerspoon 1 hs_kitty Spoon, which was itself a port of kitty.el. Only
// the parts concerned with tabs are here. Creating particular tabs — a tab holding an ssh
// tunnel, say — belongs in a configuration rather than in this Spoon: newTab() takes a
// title and a command, and a configuration names the ones it wants.
//
// ## Talking to kitty
//
// Through kitty's remote control interface: `kitty @ --to <socket> <command>`. The socket
// is named by $KITTY_LISTEN_ON, or found in /tmp when that is unset.
//
// Every call is asynchronous, which is the substantial difference from version 1. That one
// used hs.execute(), which returns the output of a command; Hammerspoon 2 has no
// hs.execute, so commands run under hs.task and every method that talks to kitty returns a
// promise. A chooser cannot therefore be built and shown in one call: the tabs have to
// arrive first.
//
// The task object is held in a set until it terminates. An hs.task with nothing referring
// to it can be collected while its child is still running, and the callback then never
// fires: the promise neither resolves nor rejects, and nothing is logged. This is the same
// reason hs.timer handles are kept in variables throughout this configuration.

// MARK: - User-configurable settings

const config = {
    // kitty's own binary, which carries the remote control interface.
    kittyBin: "/opt/homebrew/bin/kitty",

    // Where to look for the control socket when $KITTY_LISTEN_ON is unset. The first match
    // is used, so a second kitty started with its own socket is not found this way.
    socketGlob: "/tmp/kitty-*",

    // Rows visible in the chooser, and its width as a fraction of the screen.
    rowsToDisplay: 14,
    chooserWidth: 0.4,
    wideWidth: 0.22,
    wideScreenPoints: 3000,

    // Whether the chooser starts on a row other than the first when kitty is already
    // frontmost. The first row is the tab you are in, so the one below it is the one you
    // are probably after.
    skipCurrentTabWhenFrontmost: true,
    // Which row to start on in that case. Counts from zero, so 1 is the second row.
    startRow: 1,

    // Seconds allowed for one kitty command before it is given up on.
    commandTimeout: 5,

    // Log every command and how long it took.
    logCommands: false
}

const KITTY_BUNDLE_ID = "net.kovidgoyal.kitty"

// MARK: - State

// hs.task objects are held until they terminate: one with nothing referring to it can be
// collected while its child is still running, and its callback then never fires.
const runningTasks = new Set()

// The socket, once found. Cleared when a command fails, so that a kitty which has been
// restarted is found again rather than being reported unreachable for ever.
let socketPath = null

let chooser = null

function log(message) {
    console.error(`[hs_kitty-gt] ${message}`)
}

// MARK: - Running commands

/**
 * Run a command, resolving to its output and exit code.
 *
 * Never rejects. A command that cannot be started resolves with an empty string and a
 * non-zero code, so a caller can treat a failure as an absence rather than catching.
 */
function run(binary, args) {
    return new Promise((resolve) => {
        const started = Date.now()
        let out = ""
        let err = ""

        const task = hs.task.create(binary, args,
            (code) => {
                runningTasks.delete(task)
                if (config.logCommands) {
                    log(`${args.join(" ")} -> ${code} in ${Date.now() - started}ms`)
                }
                resolve({ out: out, err: err, code: code })
            },
            null,
            (kind, chunk) => {
                if (kind === "stdout") out += chunk
                else if (kind === "stderr") err += chunk
            })

        if (!task) {
            resolve({ out: "", err: "could not start " + binary, code: -1 })
            return
        }

        runningTasks.add(task)
        task.start()
    })
}

/** Whether a path exists. The module is hs.fs; hs.filesystem is not defined. */
function pathExists(path) {
    try {
        return hs.fs.exists(path) === true
    } catch (e) {
        return false
    }
}

/**
 * kitty's control socket, as `unix:/path`.
 *
 * The first match of config.socketGlob is taken, and remembered until a command fails.
 *
 * $KITTY_LISTEN_ON is consulted first but is usually absent: it is set in the shells kitty
 * starts, and Hammerspoon does not inherit it — hs.appinfo.environment holds the
 * environment Hammerspoon itself was launched with, which is the one from Finder or Xcode
 * rather than from a terminal. It is still read in case Hammerspoon was started from a
 * kitty shell.
 */
async function socket() {
    if (socketPath && pathExists(socketPath.replace(/^unix:/, ""))) return socketPath

    const named = hs.appinfo && hs.appinfo.environment
        ? hs.appinfo.environment.KITTY_LISTEN_ON
        : null
    if (named) {
        const bare = String(named).replace(/^unix:/, "")
        if (pathExists(bare)) {
            socketPath = `unix:${bare}`
            return socketPath
        }
    }

    // No environment variable, or it named a socket that has gone.
    //
    // Each candidate is tested with `test -S`, which asks whether it is a socket. Matching
    // the name alone is not enough: anything called /tmp/kitty-something matches the
    // pattern, and connecting to a regular file fails with "socket operation on
    // non-socket". A stray /tmp/kitty-test.js of mine is what found this.
    //
    // Newest first, so the most recently started kitty wins when there are several.
    const found = await run("/bin/sh", ["-c", `ls -1t ${config.socketGlob} 2>/dev/null | ` +
        `while read -r f; do [ -S "$f" ] && echo "$f" && break; done`])

    const first = String(found.out).trim().split("\n")[0]
    if (!first) {
        socketPath = null
        return null
    }

    socketPath = `unix:${first}`
    return socketPath
}

/**
 * Run one `kitty @` command.
 *
 * @param {string[]} args The command and its arguments, as separate strings.
 * @returns {Promise<{out: string, code: number, error: string|null}>} `error` is a sentence
 *          naming what went wrong, or null.
 */
async function kitty(args) {
    const where = await socket()
    if (!where) {
        return { out: "", code: -1, error: "kitty is not running, or its control socket was not found" }
    }

    const result = await run(config.kittyBin, ["@", "--to", where].concat(args))
    if (result.code !== 0) {
        // The socket may belong to a kitty that has gone. Forget it so the next call looks
        // again rather than reporting the same stale socket.
        socketPath = null
        const said = String(result.err || result.out).trim()
        return { out: "", code: result.code, error: said || `kitty ${args[0]} failed` }
    }

    return { out: result.out, code: 0, error: null }
}

// MARK: - Reading what kitty has

/**
 * Every tab, most recently used first.
 *
 * @returns {Promise<{tabs: object[], error: string|null}>} Each tab is
 *          `{id, title, active, osWindowId, osWindowIndex, processes, lastFocusedAt}`.
 */
async function tabs() {
    const listed = await kitty(["ls"])
    if (listed.error) return { tabs: [], error: listed.error }

    let data = null
    try {
        data = JSON.parse(listed.out)
    } catch (e) {
        return { tabs: [], error: "kitty's reply could not be read as JSON" }
    }
    if (!Array.isArray(data)) return { tabs: [], error: "kitty listed no windows" }

    const found = []
    data.forEach((osWindow, at) => {
        for (const tab of (osWindow.tabs || [])) {
            const windows = tab.windows || []

            // The most recent of the tab's windows stands for the tab. kitty timestamps
            // windows rather than tabs.
            let lastFocusedAt = 0
            const processes = []
            for (const window of windows) {
                const when = window.last_focused_at || 0
                if (when > lastFocusedAt) lastFocusedAt = when
                for (const process of (window.foreground_processes || [])) {
                    const cmdline = process.cmdline || []
                    const name = String(cmdline[0] || "").split("/").pop()
                    if (name && name !== "-zsh" && !processes.includes(name)) processes.push(name)
                }
            }

            found.push({
                id: tab.id,
                title: tab.title || "",
                active: tab.is_active === true,
                osWindowId: osWindow.id,
                // 1-based position, which is what `action nth_os_window` counts in.
                osWindowIndex: at + 1,
                osWindowCount: data.length,
                processes: processes,
                lastFocusedAt: lastFocusedAt
            })
        }
    })

    // Most recently used first, across every OS window. Not kitty's active_tab_history,
    // which does not put the tab in use at either end of the list.
    found.sort((a, b) => b.lastFocusedAt - a.lastFocusedAt)
    return { tabs: found, error: null }
}

/** How a tab is described in a chooser row. */
function describe(tab) {
    const parts = []
    if (tab.osWindowCount > 1) parts.push(`window ${tab.osWindowIndex}`)
    if (tab.processes.length) parts.push(tab.processes.join(" "))
    if (tab.active) parts.push("current")
    return parts.join("  ·  ")
}

// MARK: - Switching

/** Bring kitty forward. Not activate(): an application that is not frontmost cannot. */
function focusApp() {
    hs.application.launchOrFocus(KITTY_BUNDLE_ID)
    return true
}

/**
 * Focus one tab, by the id kitty gave it.
 *
 * The OS window is focused first when there is more than one, because focus-tab moves
 * within a window rather than between them.
 */
async function focusTabById(id, osWindowIndex, osWindowCount) {
    if (osWindowCount > 1 && osWindowIndex) {
        const moved = await kitty(["action", "nth_os_window", String(osWindowIndex)])
        if (moved.error) {
            hs.ui.alert(moved.error).duration(3).show()
            return false
        }
    }

    const focused = await kitty(["focus-tab", "--match", `id:${id}`])
    if (focused.error) {
        hs.ui.alert(focused.error).duration(3).show()
        return false
    }

    focusApp()
    return true
}

/**
 * Focus the tab with this title.
 *
 * @param {string} title Matched exactly.
 * @returns {Promise<boolean>} False when no tab has that title, or more than one does.
 */
async function focusTab(title) {
    const listed = await tabs()
    if (listed.error) {
        hs.ui.alert(listed.error).duration(3).show()
        return false
    }

    const matching = listed.tabs.filter((tab) => tab.title === title)
    if (!matching.length) return false
    if (matching.length > 1) {
        hs.ui.alert(`${matching.length} tabs are called ${title}`).duration(3).show()
        return false
    }

    return focusTabById(matching[0].id, matching[0].osWindowIndex, matching[0].osWindowCount)
}

// MARK: - Creating

/**
 * Create a tab, and optionally run something in it.
 *
 * Generic on purpose. A configuration that wants a particular tab — one holding an ssh
 * tunnel, a log being followed, a shell somewhere — names it here rather than this Spoon
 * knowing about it.
 *
 * @param {string} title The tab's title, which is also how it is found again.
 * @param {string} [command] A command line to run in the tab. Run through the shell, so a
 *        pipeline or a `&&` works. Omit for a plain shell.
 * @returns {Promise<boolean>} Whether the tab was created.
 */
async function newTab(title, command) {
    if (!title) {
        hs.ui.alert("A tab needs a title").duration(2).show()
        return false
    }

    const args = ["launch", "--type=tab", "--tab-title", title]
    if (command) {
        // Through a shell, so that the command may be a pipeline. --hold keeps the tab when
        // the command finishes, which is what makes a failure readable rather than a tab
        // that vanishes.
        args.push("--hold", "/bin/sh", "-c", command)
    }

    const made = await kitty(args)
    if (made.error) {
        hs.ui.alert(made.error).duration(3).show()
        return false
    }

    focusApp()
    return true
}

/**
 * Focus a tab, creating it if it is not there.
 *
 * What a configuration binds to a key for a tab it always wants: the first press makes it,
 * later presses go to it.
 *
 * @param {string} title The tab's title.
 * @param {string} [command] Run in the tab when it has to be created.
 */
async function goToTab(title, command) {
    const there = await focusTab(title)
    if (there) return true
    return newTab(title, command)
}

// MARK: - The chooser

function chooserWidth() {
    const screen = hs.screen.main() || hs.screen.primary()
    if (!screen) return config.chooserWidth
    return screen.fullFrame.w > config.wideScreenPoints ? config.wideWidth : config.chooserWidth
}

/**
 * Pick a tab from a chooser and switch to it.
 *
 * Asynchronous: the tabs have to be read from kitty before the chooser can be built, so
 * there is a short wait before it appears.
 */
async function chooseTab() {
    // Read before anything else. Showing the chooser makes Hammerspoon frontmost, and
    // reading the tabs takes long enough for the answer to change, so asking later says
    // "Hammerspoon" however the chooser was reached.
    const front = hs.application.frontmost()
    const fromKitty = Boolean(front && front.bundleID === KITTY_BUNDLE_ID)

    const listed = await tabs()
    if (listed.error) {
        hs.ui.alert(listed.error).duration(3).show()
        return false
    }
    if (!listed.tabs.length) {
        hs.ui.alert("kitty has no tabs").duration(2).show()
        return false
    }

    chooser = hs.chooser.create()
    chooser.placeholder = "kitty tab"
    chooser.searchSubText = true
    chooser.visibleRows = config.rowsToDisplay
    chooser.width = chooserWidth()

    chooser.setChoices(listed.tabs.map((tab, at) => ({
        text: tab.title || "(untitled)",
        subText: describe(tab),
        index: at
    })))

    chooser.onSelect = (item) => {
        chooser = null
        if (!item || item.index === undefined) return
        const tab = listed.tabs[item.index]
        if (tab) focusTabById(tab.id, tab.osWindowIndex, tab.osWindowCount)
    }
    chooser.onHide = () => { chooser = null }

    // The first row is the tab already in use, so when kitty is what you came from there is
    // no point starting there: the row below it is the one you are after.
    //
    // selectedRow counts from zero, so the second row is 1. Hammerspoon 1 counted from one
    // and passed 2, which here would be the third row.
    if (config.skipCurrentTabWhenFrontmost && fromKitty && listed.tabs.length > 1) {
        chooser.selectedRow = config.startRow
    }

    chooser.show()
    return true
}

// MARK: - Reading, for the console

/** Every tab and what is running in it, as lines. */
async function list() {
    const listed = await tabs()
    if (listed.error) return [listed.error]
    return listed.tabs.map((tab) =>
        `${(tab.title || "(untitled)").padEnd(40)} ${describe(tab)}`)
}

/** Whether kitty is running and answering. */
async function running() {
    const where = await socket()
    if (!where) return false
    const listed = await kitty(["ls"])
    return listed.error === null
}

// MARK: - Starting and stopping

function start() {
    return module.exports
}

function stop() {
    if (chooser) {
        try { chooser.hide() } catch (e) { /* going anyway */ }
        chooser = null
    }
    socketPath = null
    return module.exports
}

module.exports = {
    config,

    tabs,
    list,
    running,
    chooseTab,
    focusTab,
    newTab,
    goToTab,
    focusApp,

    start,
    stop,

    author: "Daniel M German",
    description: "Switch between kitty's tabs, and create them, from the keyboard",
    version: "1.0"
}
