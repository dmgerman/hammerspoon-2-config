// hs_kanata-gt — a port of the Hammerspoon 1 hs_kanata Spoon to Hammerspoon 2.
//
// Kanata is a keyboard remapper. Started with a port, it runs a TCP server and sends one
// JSON object per line to every client, such as {"LayerChange":{"new":"nav"}} when the
// active layer changes. This Spoon connects to that server, shows the name of the active
// layer on every screen while it is not the base layer, and passes each message to a
// callback chosen by its type.
//
//     const kanata = hs.loadSpoon("hs_kanata-gt")
//     kanata.config.callbacks = {
//         LayerChange: (msg) => console.log(`layer: ${msg.new}`)
//     }
//     kanata.start()
//
// Kanata has to be started with the port this Spoon connects to:
//
//     kanata --port 12340 --cfg ~/.config/kanata/kanata.kbd
//
// Unlike the version 1 Spoon, this one reconnects by itself. When Kanata is not running,
// or exits, the Spoon tries again every `reconnectInterval` seconds, so restarting Kanata
// needs nothing done here. After `reconnectTimeout` seconds without an answer it stops
// trying, and connectionOpen() starts it again.

// MARK: - User-configurable settings

const config = {
    host: "127.0.0.1",
    port: 12340,

    // Seconds between attempts to connect while Kanata is not answering. null stops the
    // Spoon from trying again after a connection ends or fails.
    reconnectInterval: 5,
    // Seconds after which, if Kanata has not answered in that time, the Spoon stops trying.
    // connectionOpen() starts trying again. null keeps trying for as long as it takes.
    reconnectTimeout: 300,

    // The layer during which nothing is shown. Kanata names its first layer after the
    // deflayer that defines it, which is usually "base".
    baseLayer: "base",

    // Whether the name of the active layer is drawn on screen.
    layerShow: true,
    canvasWidth: 400,
    canvasHeight: 200,
    textSize: 120,
    // A "#RRGGBB" string, or {red, green, blue, alpha} with components in 0..1.
    textColor: "#FF0000",
    // Where the centre of the layer name sits on each screen, as a fraction of its usable
    // area: 0 is the left or top edge, 1 the right or bottom edge.
    xPos: 0.5,
    yPos: 0.75,

    // Functions keyed by message type, such as LayerChange or MessagePush. Each receives
    // the message as {type, ...payload}: {"LayerChange":{"new":"nav"}} arrives as
    // {type: "LayerChange", new: "nav"}.
    callbacks: {}
}

// MARK: - State

let socket = null
// Whether the socket is connecting or connected. hs.socket's connected() is false while a
// connection is still being made, and connecting again then only logs a warning.
let socketActive = false
let reconnectTimer = null
// Whether start() has been called and stop() has not. A connection that ends while this is
// false is not retried.
let running = false
// When the current run of failed attempts began, in milliseconds since the epoch, or null
// while connected. A run is logged only once, and ended after config.reconnectTimeout.
let failingSince = null
let layerCurrent = null
// One canvas per screen, all showing the same layer name.
let canvases = []
let screenWatcher = null

// MARK: - Messages

// Each message is a JSON object with a single key, the message type, whose value is the
// payload. Returns null for a line that is not of that form.
function messageParse(line) {
    let decoded
    try {
        decoded = JSON.parse(line)
    } catch (e) {
        return null
    }
    if (!decoded || typeof decoded !== "object") return null

    const type = Object.keys(decoded)[0]
    if (type === undefined) return null

    const payload = decoded[type]
    return payload && typeof payload === "object" && !Array.isArray(payload)
        ? { type, ...payload }
        : { type, value: payload }
}

function messageHandle(msg) {
    if (msg.type === "LayerChange") layerDisplay(msg.new || "unknown")

    const callback = config.callbacks && config.callbacks[msg.type]
    if (typeof callback !== "function") return
    try {
        callback(msg)
    } catch (e) {
        console.error(`[hs_kanata-gt] ${msg.type} callback failed: ${e.message}`)
    }
}

// MARK: - The connection

// Called once per line while connected, and once with data set to null when the
// connection ends or cannot be made. Kanata ends every message with a newline, so a last
// read without one is a message cut short and is ignored.
function socketCallback(data, tag, error) {
    if (data === null) {
        connectionEnded(error)
        return
    }
    if (data.endsWith("\n")) {
        const msg = messageParse(data)
        if (msg) messageHandle(msg)
        else console.log(`[hs_kanata-gt] ignored a line that is not a Kanata message: ${data.trim()}`)
    }
    if (socket && socket.connected()) socket.read("\n")
}

function connectionEnded(error) {
    socketActive = false
    const endpoint = `${config.host}:${config.port}`
    if (failingSince === null) {
        console.log(`[hs_kanata-gt] no connection to Kanata at ${endpoint}: ${error || "closed by Kanata"}`)
        failingSince = Date.now()
    }
    // Nothing is known about the layer while disconnected, so its name is taken down.
    layerDisplay(null)
    reconnectSchedule()
}

function reconnectSchedule() {
    if (!running || reconnectTimer || config.reconnectInterval == null) return

    const timeout = config.reconnectTimeout
    if (timeout != null && Date.now() - failingSince >= timeout * 1000) {
        // Left running, the attempts would continue all day for a Kanata that is not coming
        // back. failingSince is kept, so that statusShow() can say the Spoon gave up.
        running = false
        const summary = `Kanata did not answer for ${Math.round(timeout / 60)} minutes; stopped trying to connect`
        console.log(`[hs_kanata-gt] ${summary}`)
        hs.ui.alert(summary).duration(4).show()
        return
    }

    reconnectTimer = hs.timer.doAfter(config.reconnectInterval, () => {
        reconnectTimer = null
        connectionAttempt()
    })
}

/**
 * Connect to Kanata, if not connected or connecting already. Retries every
 * `reconnectInterval` seconds until Kanata answers, for up to `reconnectTimeout` seconds
 * from now.
 */
function connectionOpen() {
    // A fresh start, so the time limit counts from now rather than from an earlier run.
    failingSince = null
    return connectionAttempt()
}

function connectionAttempt() {
    running = true
    if (reconnectTimer) {
        reconnectTimer.stop()
        reconnectTimer = null
    }
    if (!socket) socket = hs.socket.create(socketCallback)
    if (socketActive) return module.exports

    socketActive = true
    socket.connect(config.host, config.port, () => {
        console.log(`[hs_kanata-gt] connected to Kanata at ${config.host}:${config.port}`)
        failingSince = null
    })
    // Kanata sends a LayerChange for the current layer as soon as a client connects, so
    // the first read gives the layer without having to ask for it.
    socket.read("\n")
    return module.exports
}

/** Disconnect from Kanata and stop trying to reconnect. */
function connectionClose() {
    running = false
    if (reconnectTimer) {
        reconnectTimer.stop()
        reconnectTimer = null
    }
    // disconnect() does not call the read callback, so the layer name is taken down here.
    if (socket) socket.disconnect()
    socketActive = false
    failingSince = null
    layerDisplay(null)
    return module.exports
}

/** Disconnect from Kanata and connect again. */
function connectionRestart() {
    connectionClose()
    return connectionOpen()
}

/** Whether the Spoon is connected to Kanata. */
function connectionIsOpen() {
    return socket !== null && socket.connected()
}

/**
 * Send a request to Kanata, such as `{ChangeLayer: {new: "nav"}}`. Kanata's TCP server
 * documents which requests it accepts.
 *
 * @param {object} message The request, encoded as JSON and sent as one line.
 * @returns {boolean} Whether the request was sent: false when not connected.
 */
function messageSend(message) {
    if (!connectionIsOpen()) return false
    socket.write(JSON.stringify(message) + "\n")
    return true
}

/** The name of the active layer, or null when not connected. */
function layer() {
    return layerCurrent
}

/** Show the connection state and the active layer in an alert, and log them. */
function statusShow() {
    const state = connectionIsOpen() ? "connected"
        : running ? "not connected, retrying"
        : failingSince !== null ? "not connected, stopped retrying"
        : "not connected"
    const summary = `Kanata: ${state} (${config.host}:${config.port}), layer ${layerCurrent ?? "unknown"}`
    hs.ui.alert(summary).duration(3).show()
    console.log(`[hs_kanata-gt] ${summary}`)
    return summary
}

// MARK: - The layer name on screen

// Canvas colours are {red, green, blue, alpha} components in 0..1.
function canvasColor(value) {
    if (value && typeof value === "object") return { alpha: 1, ...value }
    const text = String(value || "#000000").replace("#", "")
    const hex = text.length === 3 ? text.split("").map((c) => c + c).join("") : text
    const component = (at) => parseInt(hex.slice(at, at + 2), 16) / 255
    return {
        red: component(0),
        green: component(2),
        blue: component(4),
        alpha: hex.length >= 8 ? component(6) : 1
    }
}

// The canvas frame centred on (xPos, yPos) of `screen`'s usable area.
//
// hs.screen measures y downwards from the top of the primary display and a canvas window
// upwards from its bottom, so the top of the canvas has to be converted.
function canvasFrame(screen, primary) {
    const area = screen.frame
    const reference = primary.fullFrame
    const left = area.x + area.w * config.xPos - config.canvasWidth / 2
    const top = area.y + area.h * config.yPos - config.canvasHeight / 2
    return {
        x: left,
        y: (reference.y + reference.h) - (top + config.canvasHeight),
        w: config.canvasWidth,
        h: config.canvasHeight
    }
}

function canvasBuild(screen, primary, text) {
    const frame = canvasFrame(screen, primary)
    const canvas = hs.canvas.create(frame)
        .level("status")
        // The name is displayed for as long as the layer is held, often while typing or
        // clicking, so it must not take the clicks behind it.
        .ignoreMouseEvents(true)
        .behaviorList(["canJoinAllSpaces", "stationary"])
    canvas.appendElements([{
        type: "text",
        text: text,
        textSize: config.textSize,
        textColor: canvasColor(config.textColor),
        textAlignment: "center",
        frame: { x: 0, y: 0, w: frame.w, h: frame.h }
    }])
    canvas.show()
    return canvas
}

function canvasesDestroy() {
    for (const canvas of canvases) canvas.destroy()
    canvases = []
}

// Builds a canvas on every screen showing `text`. Leaves none when there are no displays,
// as happens mid-disconnect.
function canvasesBuild(text) {
    canvasesDestroy()
    const screens = hs.screen.all()
    const primary = hs.screen.primary() || screens[0]
    if (!primary) return
    canvases = screens.map((screen) => canvasBuild(screen, primary, text))
}

// Records `layerName` as the active layer, and shows it on every screen unless it is the
// base layer. null means the layer is unknown, and shows nothing.
function layerDisplay(layerName) {
    layerCurrent = layerName
    if (!config.layerShow || layerName === null || layerName === config.baseLayer) {
        canvasesDestroy()
        return
    }
    if (canvases.length === 0) {
        canvasesBuild(layerName)
        return
    }
    for (const canvas of canvases) canvas.setElementAttribute(0, "text", layerName)
}

// A screen added, removed or rearranged leaves the canvases where the old layout put them.
function screensChanged() {
    if (canvases.length > 0) canvasesBuild(layerCurrent)
}

// MARK: - Lifecycle

/** Connect to Kanata and start watching for screen changes. */
function start() {
    if (!screenWatcher) {
        screenWatcher = () => screensChanged()
        hs.screen.on("change", screenWatcher)
    }
    return connectionOpen()
}

/** Disconnect from Kanata, take down the layer name and stop watching screens. */
function stop() {
    connectionClose()
    if (screenWatcher) {
        hs.screen.off("change", screenWatcher)
        screenWatcher = null
    }
    if (socket) {
        socket.destroy()
        socket = null
    }
    return module.exports
}

module.exports = {
    config,
    connectionOpen,
    connectionClose,
    connectionRestart,
    connectionIsOpen,
    messageSend,
    layer,
    statusShow,
    start,
    stop
}
