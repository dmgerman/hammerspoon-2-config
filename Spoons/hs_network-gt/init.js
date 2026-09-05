// hs_network-gt — traffic accounting per network, and a banner naming the current one.
//
// A port of two pieces of a Hammerspoon 1 configuration: hs_network.spoon, which counts
// traffic per network and alerts on thresholds, and the network_* functions of
// hs_annoyances.spoon, which announce the current network on screen every few minutes.
//
//     const network = hs.loadSpoon("hs_network-gt")
//     network.start()
//     network.thresholdsSet("HomeWiFi", {absolute: [1024 ** 3], delta: 500 * 1024 ** 2})
//     network.networkMute("CoffeeShop")
//
// Traffic is counted from the moment of connection. The menubar carries the session
// total, cumulative per-network totals go to logs/network.json, and connect, disconnect
// and alert events are appended to logs/network.log as TSV. The names of the keys on
// disk are those of the v1 Spoon, so an existing ~/.hammerspoon/logs/network.json can be
// copied over to carry its history forward.
//
// Byte counts come from the kernel by way of netstat, so they are physical-layer figures
// for the interface: bytes inside a VPN tunnel are included.
//
// Three departures from the v1 Spoon, each forced by the v2 API:
//   * Network names come from a Shortcut. hs.wifi.currentNetwork() returns nothing on
//     recent macOS unless Location Services has authorized the caller.
//   * There is no hs.execute, so netstat, route and scutil run under hs.task, and every
//     reading is asynchronous. A poll cycle never overlaps its predecessor.
//   * There is no hs.canvas, so the banner is an hs.ui window, as in hs_time-gt.

// MARK: - User-configurable settings

const config = {
    // Networks whose name is not announced on screen. Traffic is still counted for them,
    // and a connected VPN is still announced while on one. Empty announces every network.
    ignoredNetworks: [],

    // Shortcut run to read the current network name, or null to rely on
    // hs.wifi.currentNetwork() alone. The Shortcut is expected to print the name.
    nameShortcut: "dmg-ssid",

    // VPN services whose name may be appended to the announcement. Empty accepts any
    // service that scutil reports as connected.
    vpnServices: [],

    // Seconds between traffic samples, and between announcements.
    pollSeconds: 15,
    bannerInterval: 120,

    // The announcement.
    bannerDuration: 2,
    bannerWidth: 500,
    bannerHeight: 230,
    bannerFont: "Impact",
    bannerTextSize: 60,
    bannerTextColor: "#FF3342",
    // Window stacking level: "floating", "status", "screenSaver", "popUpMenu".
    bannerLevel: "floating",

    // Seconds a threshold alert stays on screen.
    alertDuration: 5,

    // Applied to a network with no thresholds of its own. A value set through
    // thresholdsSet(), including none at all, persists and overrides this.
    defaultDelta: 10 * 1024 ** 2,

    // Cumulative totals, and the event log.
    stateFile: `${hs.appinfo.configDir}/logs/network.json`,
    eventFile: `${hs.appinfo.configDir}/logs/network.log`
}

// MARK: - State

// Loaded from config.stateFile: {ssids, alerts_paused, tracking_paused}. The key names
// are the v1 Spoon's; "ssids" is keyed by network name, which is an SSID when one can be
// read and "iface:en0" when it cannot.
let state = null

// The connection being counted, or null between connections:
// {name, iface, previous, bytes, absoluteFired, deltaMark, wifiKillFired}
let session = null

// Network name -> {absolute: [ascending byte counts], delta: bytes}. Mirrored into
// state.ssids[name].thresholds when it changes.
let thresholds = {}

let menubarItem = null
let pollTimer = null
let bannerTimer = null
let wifiWatcher = null
let bannerWindow = null
let bannerText = null
let bannerHideTimer = null

// A poll cycle makes several asynchronous readings, so one can still be in flight when
// the timer next fires. Overlapping cycles would double-count, since each consumes the
// bytes accumulated since the last snapshot.
let polling = false

// hs.task objects are held until they terminate, so a task cannot be collected while it
// is still running.
const runningTasks = new Set()

// MARK: - Formatting

function bytesFormat(n) {
    const bytes = n || 0
    if (bytes < 1024) return `${Math.round(bytes)}B`
    if (bytes < 1024 ** 2) return `${(bytes / 1024).toFixed(1)}KB`
    if (bytes < 1024 ** 3) return `${(bytes / 1024 ** 2).toFixed(1)}MB`
    return `${(bytes / 1024 ** 3).toFixed(2)}GB`
}

function timeNow() {
    return new Date().toISOString().replace(/\.\d{3}Z$/, "Z")
}

function bytesTotal(counts) {
    return (counts["in"] || 0) + (counts.out || 0)
}

// MARK: - Running commands
//
// Every reading below is taken from a command line tool, because hs.network and hs.wifi
// expose neither interface byte counters nor VPN service state.

/**
 * Run a shell command, resolving to its standard output and exit code.
 *
 * Never rejects: a command that cannot be started resolves with an empty string and a
 * non-zero code, so a caller can treat a failed reading as a missing one.
 */
function shellRun(command) {
    return new Promise((resolve) => {
        let out = ""
        const task = hs.task.create("/bin/sh", ["-c", command],
            (code) => {
                runningTasks.delete(task)
                resolve({out: out, code: code})
            },
            null,
            (kind, chunk) => {
                if (kind === "stdout") out += chunk
            })

        if (!task) {
            resolve({out: "", code: -1})
            return
        }
        runningTasks.add(task)
        task.start()
    })
}

// MARK: - Persistence

function stateDefault() {
    return {ssids: {}, alerts_paused: false, tracking_paused: false}
}

function stateLoad() {
    if (!hs.fs.exists(config.stateFile)) return stateDefault()

    const body = hs.fs.read(config.stateFile, 0, 0)
    if (!body || body === "") return stateDefault()

    let data = null
    try {
        data = JSON.parse(body)
    } catch (error) {
        console.error(`[hs_network-gt] ${config.stateFile} is unreadable, starting fresh: ${error}`)
        return stateDefault()
    }
    if (!data || typeof data !== "object" || typeof data.ssids !== "object" || !data.ssids) {
        console.error(`[hs_network-gt] ${config.stateFile} has no networks in it, starting fresh`)
        return stateDefault()
    }

    data.alerts_paused = data.alerts_paused === true
    data.tracking_paused = data.tracking_paused === true
    return data
}

function stateSave() {
    if (!state) return
    hs.fs.write(config.stateFile, JSON.stringify(state, null, 2), false)
}

function eventLog(network, event, total, delta) {
    hs.fs.append(config.eventFile,
        `${timeNow()}\t${network || "-"}\t${event}\t${Math.round(total || 0)}\t${Math.round(delta || 0)}\n`)
}

// Directory, state and thresholds are prepared on the first call that needs them, so the
// Spoon can be loaded without touching the disk.
function stateEnsure() {
    if (state) return
    hs.fs.mkdir(`${hs.appinfo.configDir}/logs`)
    state = stateLoad()
    for (const name of Object.keys(state.ssids)) {
        const entry = state.ssids[name]
        if (entry && typeof entry.thresholds === "object" && entry.thresholds) {
            thresholds[name] = entry.thresholds
        }
    }
}

function networkEntry(name) {
    if (!state.ssids[name]) state.ssids[name] = {"in": 0, out: 0}
    return state.ssids[name]
}

function networkAlertsDisabled(name) {
    const entry = state.ssids[name]
    return entry !== undefined && entry.alerts_disabled === true
}

// MARK: - Reading the network

// A Wi-Fi interface that is powered on and associated. hs.wifi.interfaceDetails() reports
// `active` for the interface the v1 Spoon detected through its IPv4 addresses.
function interfaceWifi() {
    for (const iface of hs.wifi.interfaces() || []) {
        const details = hs.wifi.interfaceDetails(iface)
        if (details && details.active === true) return iface
    }
    return null
}

// The interface carrying the default route, ignoring tunnels: their counters measure
// traffic that is also counted on the physical interface underneath.
async function interfaceDefaultRoute() {
    const {out} = await shellRun("route -n get default 2>/dev/null | awk '/interface:/{print $2}'")
    const iface = (out || "").replace(/\s+/g, "")
    if (iface === "") return null
    if (/^(utun|ppp|ipsec)/.test(iface)) return null
    return iface
}

async function interfaceActive() {
    return interfaceWifi() || await interfaceDefaultRoute()
}

/**
 * The name of the network on an interface: its SSID, or `iface:en0` when no name can be
 * read. Asynchronous because the Shortcut that reads the SSID is.
 */
async function networkNameFor(iface) {
    if (config.nameShortcut) {
        try {
            const name = await hs.shortcuts.run(config.nameShortcut)
            const trimmed = name === null || name === undefined ? "" : String(name).trim()
            if (trimmed !== "") return trimmed
        } catch (error) {
            console.error(`[hs_network-gt] shortcut ${config.nameShortcut} failed: ${error}`)
        }
    }

    const ssid = hs.wifi.currentNetwork(iface || null)
    if (ssid && ssid !== "") return ssid

    return iface ? `iface:${iface}` : null
}

// Kernel byte counters for an interface, from its Link row.
async function counterRead(iface) {
    if (!iface) return null
    const {out} = await shellRun(
        `netstat -ibn 2>/dev/null | awk '$1=="${iface}" && $3 ~ /Link/{print $7, $10; exit}'`)
    const figures = (out || "").match(/(\d+)\s+(\d+)/)
    if (!figures) return null
    return {"in": Number(figures[1]), out: Number(figures[2])}
}

/**
 * The name of a connected VPN service, or null when none is connected.
 *
 * `scutil --nc list` names every configured service and its state, so no service name has
 * to be known in advance:
 *
 *     * (Connected)  <uuid> VPN (com.example.vpn) "Work VPN"  [VPN:com.example.vpn]
 */
async function vpnNameRead() {
    const {out} = await shellRun("scutil --nc list 2>/dev/null")
    for (const line of (out || "").split("\n")) {
        if (!/\(Connected\)/.test(line)) continue
        const quoted = line.match(/"([^"]+)"/)
        if (!quoted) continue
        const name = quoted[1]
        if (config.vpnServices.length === 0 || config.vpnServices.includes(name)) return name
    }
    return null
}

// MARK: - Alerts

function alertFire(message) {
    hs.ui.alert(message).duration(config.alertDuration).show()
    console.log(`[hs_network-gt] ${message}`)
}

function interfaceIsWifi(iface) {
    if (!iface) return false
    return (hs.wifi.interfaces() || []).includes(iface)
}

// Switching Wi-Fi off is the one irreversible thing here, so it happens once per session
// and only for a network that asked for it.
function wifiKillMaybe(name, total) {
    const entry = state.ssids[name]
    if (!entry || !entry.disable_wifi_on_cap) return
    if (!session || session.wifiKillFired) return
    if (!interfaceIsWifi(session.iface)) return

    session.wifiKillFired = true
    alertFire(`⚠ ${name}: cap reached — disabling Wi-Fi`)
    eventLog(name, "wifi_disabled", total, 0)
    hs.wifi.setPower(false, session.iface)
}

function thresholdsAbsoluteCheck(name, total, cfg) {
    for (const threshold of cfg.absolute || []) {
        if (total < threshold || session.absoluteFired[threshold]) continue
        session.absoluteFired[threshold] = true
        alertFire(`⚠ ${name}: ${bytesFormat(threshold)} reached`)
        eventLog(name, "alert_absolute", total, threshold)
        wifiKillMaybe(name, total)
    }
}

function thresholdsDeltaCheck(name, total, cfg) {
    if (!cfg.delta || cfg.delta <= 0) return
    const since = total - session.deltaMark
    if (since < cfg.delta) return

    // One alert for a quiet period that crossed several multiples at once, with the mark
    // advanced past all of them.
    const steps = Math.floor(since / cfg.delta)
    session.deltaMark += steps * cfg.delta
    alertFire(`⚠ ${name}: +${bytesFormat(steps * cfg.delta)} consumed (total ${bytesFormat(total)})`)
    eventLog(name, "alert_delta", total, steps * cfg.delta)
}

function alertMaybe(name, total) {
    if (state.alerts_paused) return
    if (networkAlertsDisabled(name)) return
    const cfg = thresholds[name]
    if (!cfg) return
    thresholdsAbsoluteCheck(name, total, cfg)
    thresholdsDeltaCheck(name, total, cfg)
}

// MARK: - Session lifecycle

function sessionStart(iface, name, counter) {
    session = {
        iface: iface,
        name: name,
        previous: counter,
        bytes: {"in": 0, out: 0},
        absoluteFired: {},
        deltaMark: 0,
        wifiKillFired: false
    }

    const entry = networkEntry(name)
    if (entry.thresholds === undefined) {
        entry.thresholds = {delta: config.defaultDelta, absolute: []}
        thresholds[name] = entry.thresholds
    }
    entry.last_seen = timeNow()

    stateSave()
    eventLog(name, "connect", 0, 0)
}

function sessionEnd() {
    if (!session) return
    const total = bytesTotal(session.bytes)
    eventLog(session.name, "disconnect", total, total)
    session = null
}

function deltaApply(inBytes, outBytes) {
    session.bytes["in"] += inBytes
    session.bytes.out += outBytes

    const entry = networkEntry(session.name)
    entry["in"] += inBytes
    entry.out += outBytes
    entry.last_seen = timeNow()
}

// MARK: - Menubar

function titleIndicator() {
    if (!state) return ""
    if (state.tracking_paused) return "⏸ "
    if (state.alerts_paused) return "🔕 "
    return ""
}

function menubarTitleUpdate() {
    if (!menubarItem) return
    if (!session) {
        menubarItem.title = `${titleIndicator()}net: --`
        return
    }
    menubarItem.title =
        `${titleIndicator()}↓${bytesFormat(session.bytes["in"])} ↑${bytesFormat(session.bytes.out)}`
}

function thresholdsDescribe(name) {
    const cfg = thresholds[name]
    const parts = []
    if (cfg && cfg.delta && cfg.delta > 0) parts.push(`every ${bytesFormat(cfg.delta)}`)
    if (cfg && cfg.absolute && cfg.absolute.length > 0) {
        parts.push(`at ${cfg.absolute.map(bytesFormat).join(", ")}`)
    }

    const body = parts.length > 0 ? parts.join(" · ") : "none configured"
    let suffix = ""
    if (state.alerts_paused) suffix = " (paused)"
    else if (networkAlertsDisabled(name)) suffix = " (muted)"

    return `Alerts: ${body}${suffix}`
}

const DELTA_PRESETS = [
    {label: "None", value: null},
    {label: "10 MiB", value: 10 * 1024 ** 2},
    {label: "100 MiB", value: 100 * 1024 ** 2},
    {label: "500 MiB", value: 500 * 1024 ** 2},
    {label: "1 GiB", value: 1024 ** 3}
]

const CAP_PRESETS = [
    {label: "None", value: null},
    {label: "100 MiB", value: 100 * 1024 ** 2},
    {label: "500 MiB", value: 500 * 1024 ** 2},
    {label: "1 GiB", value: 1024 ** 3},
    {label: "5 GiB", value: 5 * 1024 ** 3}
]

function menuSessionItems(items) {
    const entry = networkEntry(session.name)
    items.push({title: `Network: ${session.name}`, disabled: true})
    items.push({
        title: `Session: ↓${bytesFormat(session.bytes["in"])} ↑${bytesFormat(session.bytes.out)}`,
        disabled: true
    })
    items.push({
        title: `Cumulative: ↓${bytesFormat(entry["in"])} ↑${bytesFormat(entry.out)}`,
        disabled: true
    })
    items.push({title: thresholdsDescribe(session.name), disabled: true})
}

function menuDeltaSubmenu(items) {
    const name = session.name
    const cfg = thresholds[name] || {}
    items.push({
        title: "Set delta",
        menu: DELTA_PRESETS.map((preset) => ({
            title: preset.label,
            checked: (cfg.delta === undefined ? null : cfg.delta) === preset.value,
            fn: () => thresholdsSet(name, {delta: preset.value, absolute: cfg.absolute})
        }))
    })
}

function menuCapSubmenu(items) {
    const name = session.name
    const cfg = thresholds[name] || {}
    const cap = cfg.absolute && cfg.absolute.length === 1 ? cfg.absolute[0] : null

    items.push({
        title: "Set session cap",
        menu: CAP_PRESETS.map((preset) => ({
            title: preset.label,
            checked: preset.value === null
                ? !cfg.absolute || cfg.absolute.length === 0
                : cap === preset.value,
            fn: () => thresholdsSet(name, {
                delta: cfg.delta,
                absolute: preset.value === null ? [] : [preset.value]
            })
        }))
    })
}

function menuWifiKillToggle(items) {
    const entry = networkEntry(session.name)
    items.push({
        title: "Disable Wi-Fi when cap reached",
        checked: entry.disable_wifi_on_cap === true,
        fn: () => {
            if (entry.disable_wifi_on_cap) delete entry.disable_wifi_on_cap
            else entry.disable_wifi_on_cap = true
            stateSave()
        }
    })
}

function menuNetworkToggle(items) {
    const name = session.name
    if (networkAlertsDisabled(name)) {
        items.push({title: `Enable alerts for ${name}`, fn: () => networkUnmute(name)})
    } else {
        items.push({title: `Disable alerts for ${name}`, fn: () => networkMute(name)})
    }
}

function menuGlobalToggles(items) {
    items.push(state.alerts_paused
        ? {title: "Resume all alerts", fn: () => alertsResume()}
        : {title: "Pause all alerts", fn: () => alertsPause()})
    items.push(state.tracking_paused
        ? {title: "Resume tracking", fn: () => trackingResume()}
        : {title: "Pause tracking", fn: () => trackingPause()})
}

function menuCumulativeList(items) {
    items.push({title: "-"})
    items.push({title: "All networks (cumulative)", disabled: true})
    for (const name of Object.keys(state.ssids).sort()) {
        const entry = state.ssids[name]
        const muted = entry.alerts_disabled ? "  🔕" : "    "
        items.push({
            title: `${muted} ${name}: ↓${bytesFormat(entry["in"])} ↑${bytesFormat(entry.out)}`,
            disabled: true
        })
    }
}

function menuBuild() {
    stateEnsure()
    const items = []

    if (session) {
        menuSessionItems(items)
        items.push({title: "-"})
        menuDeltaSubmenu(items)
        menuCapSubmenu(items)
        menuWifiKillToggle(items)
        menuNetworkToggle(items)
        items.push({title: "Reset session", fn: () => sessionReset()})
        items.push({title: "Show network name", fn: () => networkNameShow(true)})
    } else {
        items.push({title: "Not connected", disabled: true})
    }

    items.push({title: "-"})
    menuGlobalToggles(items)
    menuCumulativeList(items)
    return items
}

// MARK: - The banner
//
// hs.ui windows take their frame when they are created, so the window is rebuilt at every
// showing rather than moved.

// hs.screen frames have their origin at the top left of the primary display, while hs.ui
// window frames have theirs at its bottom left, with y growing upwards. The eighth and
// the fifth of the leftover space reproduce the placement of the v1 canvas.
function bannerFrame() {
    const primary = hs.screen.primary().fullFrame
    const area = hs.screen.main().fullFrame
    const left = area.x + (area.w - config.bannerWidth) / 8
    const top = area.y + (area.h - config.bannerHeight) / 5

    return {
        x: left,
        y: (primary.y + primary.h) - (top + config.bannerHeight),
        w: config.bannerWidth,
        h: config.bannerHeight
    }
}

function bannerBuild(text) {
    bannerText = hs.ui.string(text)
    bannerWindow = hs.ui.window(bannerFrame())
        .titled(false)
        .level(config.bannerLevel)
        .backgroundColor("#00000000")
        .text(bannerText)
            .font(HSFont.customSize(config.bannerFont, config.bannerTextSize))
            .foregroundColor(config.bannerTextColor)
}

// MARK: - Poll loop

// Bring the session counters up to the present without firing alerts. Used by the poll
// cycle, which alerts separately, and by thresholdsSet(), which arms new thresholds
// against an up-to-date total.
async function consumeSilently() {
    if (!session) return
    const counter = await counterRead(session.iface)
    if (!counter) return

    // Counters reset when an interface goes down, so a negative difference is a restart
    // rather than traffic.
    const inBytes = Math.max(0, counter["in"] - session.previous["in"])
    const outBytes = Math.max(0, counter.out - session.previous.out)
    session.previous = counter
    if (inBytes === 0 && outBytes === 0) return

    deltaApply(inBytes, outBytes)
    stateSave()
}

async function pollIdle() {
    const iface = await interfaceActive()
    if (!iface) return
    const name = await networkNameFor(iface)
    const counter = await counterRead(iface)
    if (!name || !counter) return
    sessionStart(iface, name, counter)
}

async function pollActive() {
    await consumeSilently()
    alertMaybe(session.name, bytesTotal(session.bytes))
}

async function poll() {
    stateEnsure()
    if (polling) return
    polling = true

    try {
        if (state.tracking_paused) return
        if (session) await pollActive()
        else await pollIdle()
    } catch (error) {
        console.error(`[hs_network-gt] poll failed: ${error}`)
    } finally {
        polling = false
        menubarTitleUpdate()
    }
}

async function onWifiChange() {
    stateEnsure()
    if (state.tracking_paused) return

    const iface = await interfaceActive()
    const name = iface ? await networkNameFor(iface) : null
    if (session && (session.iface !== iface || session.name !== name)) sessionEnd()
    await poll()
}

// MARK: - Public API: the current network

/**
 * The name of the current network, resolving to null when there is no active interface.
 *
 * Asynchronous: the name is read through a Shortcut, since hs.wifi.currentNetwork() is
 * unavailable without Location Services authorization.
 */
async function networkName() {
    const iface = await interfaceActive()
    if (!iface) return null
    return networkNameFor(iface)
}

/**
 * Announce the current network on screen, and resolve to the text shown, or to null when
 * nothing was shown.
 *
 * A network listed in config.ignoredNetworks is not named, but a VPN connected while on
 * it still is; when neither is to be shown, nothing appears. Pass true to name the
 * network whatever the ignore list says, which is what the menu item does.
 */
async function networkNameShow(always) {
    const name = await networkName()
    const vpn = await vpnNameRead()

    const named = (always === true || !config.ignoredNetworks.includes(name)) ? name : null
    const text = [named, vpn].filter((part) => part).join(" ")
    if (text === "") return null

    networkNameHide()
    bannerBuild(text)
    bannerWindow.show()
    bannerHideTimer = hs.timer.doAfter(config.bannerDuration, () => networkNameHide())
    return text
}

/** Remove the banner, if it is showing. */
function networkNameHide() {
    if (bannerHideTimer) {
        bannerHideTimer.stop()
        bannerHideTimer = null
    }
    if (!bannerWindow) return module.exports

    bannerWindow.destroy()
    bannerWindow = null
    bannerText = null
    return module.exports
}

// MARK: - Public API: alerts for one network

/** Suppress alerts for a network. Its traffic is still counted. Persists to disk. */
function networkMute(name) {
    stateEnsure()
    networkEntry(name).alerts_disabled = true
    stateSave()
    return module.exports
}

/** Allow alerts for a network again. Persists to disk. */
function networkUnmute(name) {
    stateEnsure()
    delete networkEntry(name).alerts_disabled
    stateSave()
    return module.exports
}

/**
 * Configure alert thresholds for a network, replacing any it already had.
 *
 * `options.absolute` is a list of byte counts, each alerting once per session;
 * `options.delta` alerts every N bytes consumed within a session. Persists to disk.
 */
function thresholdsSet(name, options) {
    stateEnsure()
    const settings = options || {}
    const absolute = (settings.absolute || []).slice().sort((a, b) => a - b)

    const armed = () => {
        thresholds[name] = {absolute: absolute, delta: settings.delta}

        // New thresholds measure from now: anything already consumed this session is
        // marked as fired, so raising a cap does not immediately alert about the past.
        if (session && session.name === name) {
            const total = bytesTotal(session.bytes)
            session.deltaMark = total
            session.absoluteFired = {}
            for (const threshold of absolute) {
                if (total >= threshold) session.absoluteFired[threshold] = true
            }
        }

        const entry = networkEntry(name)
        entry.thresholds = thresholds[name]
        stateSave()
    }

    // Counting up to the present first, so bytes that arrived under the old thresholds
    // are not measured against the new ones.
    if (session && session.name === name) consumeSilently().then(armed)
    else armed()

    return module.exports
}

// MARK: - Public API: global toggles

/** Silence every alert. Counting and the menubar continue. Persists to disk. */
function alertsPause() {
    stateEnsure()
    state.alerts_paused = true
    stateSave()
    menubarTitleUpdate()
    return module.exports
}

/** Allow alerts again. A network muted with networkMute() stays muted. */
function alertsResume() {
    stateEnsure()
    state.alerts_paused = false
    stateSave()
    menubarTitleUpdate()
    return module.exports
}

/** Flip the global alerts-paused flag. */
function alertsToggle() {
    stateEnsure()
    return state.alerts_paused ? alertsResume() : alertsPause()
}

/** Whether alerts are paused globally. */
function alertsPaused() {
    stateEnsure()
    return state.alerts_paused === true
}

/**
 * Freeze the counters. The menubar stays, showing the last figures behind a ⏸, and no
 * alerts fire. Persists to disk.
 */
function trackingPause() {
    stateEnsure()
    state.tracking_paused = true
    stateSave()
    menubarTitleUpdate()
    return module.exports
}

/**
 * Resume counting. The interface counter is read again first, so bytes that flowed during
 * the pause are not added retroactively.
 */
function trackingResume() {
    stateEnsure()
    state.tracking_paused = false
    stateSave()

    if (session) {
        counterRead(session.iface).then((counter) => {
            if (counter && session) session.previous = counter
            menubarTitleUpdate()
        })
    } else {
        menubarTitleUpdate()
    }
    return module.exports
}

/** Flip the tracking-paused flag. */
function trackingToggle() {
    stateEnsure()
    return state.tracking_paused ? trackingResume() : trackingPause()
}

/** Whether counting is paused. */
function trackingPaused() {
    stateEnsure()
    return state.tracking_paused === true
}

// MARK: - Public API: counters

/** Zero the session counters and alert state for the current network. */
function sessionReset() {
    if (!session) return module.exports
    session.bytes = {"in": 0, out: 0}
    session.absoluteFired = {}
    session.deltaMark = 0
    session.wifiKillFired = false
    menubarTitleUpdate()
    return module.exports
}

/** Zero the cumulative total for a network, or for every network when given none. */
function cumulativeReset(name) {
    stateEnsure()
    if (name) {
        const entry = state.ssids[name] || {}
        state.ssids[name] = {
            "in": 0,
            out: 0,
            last_seen: timeNow(),
            alerts_disabled: entry.alerts_disabled,
            thresholds: entry.thresholds
        }
    } else {
        state.ssids = {}
    }
    stateSave()
    return module.exports
}

// MARK: - Public API: lifecycle

/**
 * Start counting, watching for network changes, and announcing the current network.
 *
 * The alerts-paused and tracking-paused flags persist across restarts, so a Spoon started
 * while paused stays paused.
 */
function start() {
    stateEnsure()

    if (!menubarItem) {
        menubarItem = hs.menubar.create(false)
        menubarItem.setMenu(menuBuild)
    }
    menubarTitleUpdate()

    if (!pollTimer) pollTimer = hs.timer.doEvery(config.pollSeconds, () => poll())

    if (!bannerTimer && config.bannerInterval > 0) {
        bannerTimer = hs.timer.doEvery(config.bannerInterval, () => networkNameShow())
    }

    if (!wifiWatcher) {
        wifiWatcher = hs.wifi.addWatcher()
        wifiWatcher.events = ["ssidChange", "powerChange"]
        wifiWatcher.setCallback(() => onWifiChange())
        wifiWatcher.start()
    }

    poll()
    return module.exports
}

/** Stop the timers and the watcher, and remove the menubar item. State on disk is kept. */
function stop() {
    if (pollTimer) {
        pollTimer.stop()
        pollTimer = null
    }
    if (bannerTimer) {
        bannerTimer.stop()
        bannerTimer = null
    }
    if (wifiWatcher) {
        wifiWatcher.destroy()
        wifiWatcher = null
    }
    if (menubarItem) {
        menubarItem.destroy()
        menubarItem = null
    }
    networkNameHide()
    sessionEnd()
    return module.exports
}

module.exports = {
    config,
    start,
    stop,
    networkName,
    networkNameShow,
    networkNameHide,
    networkMute,
    networkUnmute,
    thresholdsSet,
    alertsPause,
    alertsResume,
    alertsToggle,
    alertsPaused,
    trackingPause,
    trackingResume,
    trackingToggle,
    trackingPaused,
    sessionReset,
    cumulativeReset
}
