// hs_sidecar-gt — extends the desktop to an iPad with Sidecar when the iPad is plugged in.
//
// When the iPad is connected by USB, the Spoon shows an alert saying it will start Sidecar,
// waits `delay` seconds, connects, and shows a second alert saying whether that worked.
// Unplugging the iPad during the wait cancels it.
//
//     const sidecar = hs.loadSpoon("hs_sidecar-gt")
//     sidecar.start()
//
// Hammerspoon 2 has no Sidecar API, and neither does macOS publicly. The connection is made
// by sidecar-connect.js, a JavaScript for Automation script in this directory, run under
// osascript. It uses the private SidecarCore framework, so a macOS update may break it.
//
// The wait is there because the iPad becomes a USB device before it becomes a Sidecar
// device. It needs a few seconds after the cable goes in before SidecarCore lists it.

// MARK: - User-configurable settings

const config = {
    // The start of the iPad's name as Sidecar lists it, which is the name set on the iPad in
    // Settings → General → About. It is also the name the alerts use. macOS adds a number to
    // the second of two iPads with the same name, as in "iPad mini (2)", so "iPad mini"
    // matches either. null uses the first iPad Sidecar lists.
    ipadName: null,

    // The serial number of the iPad as hs.usb reports it, to react to one iPad only. null
    // reacts to any iPad plugged in by USB. hs.usb.attachedDevices() lists the serial
    // numbers of the devices connected now.
    usbSerialNumber: null,

    // Seconds between the iPad being plugged in and Sidecar being started.
    delay: 10,

    scriptPath: `${hs.appinfo.configDir}/Spoons/hs_sidecar-gt/sidecar-connect.js`
}

// Every iPad, whatever the model, reports Apple's vendor ID and the product name "iPad" over
// USB. The product ID differs from model to model, so it is not used.
const APPLE_VENDOR_ID = 0x05AC
const IPAD_PRODUCT_NAME = "iPad"

// MARK: - State

let usbAddedListener = null
let usbRemovedListener = null
let delayTimer = null

function log(message) {
    console.log(`[hs_sidecar-gt] ${message}`)
}

function alert(message, seconds) {
    hs.ui.alert(message).duration(seconds).show()
}

// MARK: - Connecting

// osascript reports a thrown error as
// `sidecar-connect.js: execution error: Error: Error: <message> (-2700)`.
// This keeps only <message>.
function scriptErrorMessage(stderr) {
    const text = stderr.trim()
    const match = text.match(/execution error: (?:Error: )*(.*?)(?: \(-?\d+\))?$/s)
    return match ? match[1] : text
}

/**
 * Extend the desktop to the iPad now by connecting Sidecar, and show an alert saying
 * whether it worked.
 *
 * @returns {Promise<boolean>} Whether the iPad is connected.
 */
function displayExtend() {
    return new Promise((resolve) => {
        let out = ""
        let err = ""
        const task = hs.task.create("/usr/bin/osascript",
            ["-l", "JavaScript", config.scriptPath, config.ipadName ?? ""],
            (code) => {
                if (code === 0) {
                    const message = out.trim() || "Sidecar connected"
                    log(message)
                    alert(`Sidecar: ${message}`, 3)
                    resolve(true)
                } else {
                    const message = scriptErrorMessage(err) || `osascript exited with ${code}`
                    log(`could not connect: ${message}`)
                    alert(`Sidecar failed: ${message}`, 6)
                    resolve(false)
                }
            },
            null,
            (kind, chunk) => {
                if (kind === "stdout") out += chunk
                else if (kind === "stderr") err += chunk
            })

        if (!task) {
            log("could not start osascript")
            alert("Sidecar failed: could not start osascript", 6)
            resolve(false)
            return
        }
        task.start()
    })
}

// MARK: - Watching USB

function ipadLabel() {
    return config.ipadName ?? "iPad"
}

function deviceIsIpad(device) {
    if (device.vendorID !== APPLE_VENDOR_ID || device.productName !== IPAD_PRODUCT_NAME) return false
    return config.usbSerialNumber == null || device.serialNumber === config.usbSerialNumber
}

function delayCancel() {
    if (delayTimer) {
        delayTimer.stop()
        delayTimer = null
    }
}

function ipadAdded(device) {
    if (!deviceIsIpad(device)) return
    // A second "added" during the wait starts the wait again rather than connecting twice.
    delayCancel()
    log(`${device.productName} plugged in; connecting Sidecar in ${config.delay} seconds`)
    alert(`${ipadLabel()} connected: extending the display in ${config.delay} seconds`, 3)
    delayTimer = hs.timer.doAfter(config.delay, () => {
        delayTimer = null
        displayExtend()
    })
}

function ipadRemoved(device) {
    if (!deviceIsIpad(device) || !delayTimer) return
    delayCancel()
    log(`${device.productName} unplugged before Sidecar was started; not connecting`)
    alert(`${ipadLabel()} unplugged: not extending the display`, 3)
}

// MARK: - Lifecycle

/** Start watching USB for the iPad. An iPad already plugged in is left as it is. */
function start() {
    if (usbAddedListener) return module.exports
    usbAddedListener = ipadAdded
    usbRemovedListener = ipadRemoved
    hs.usb.on("added", usbAddedListener)
    hs.usb.on("removed", usbRemovedListener)
    return module.exports
}

/** Stop watching USB, and cancel a connection that is waiting to be made. */
function stop() {
    delayCancel()
    if (usbAddedListener) {
        hs.usb.off("added", usbAddedListener)
        hs.usb.off("removed", usbRemovedListener)
        usbAddedListener = null
        usbRemovedListener = null
    }
    return module.exports
}

module.exports = {
    config,
    displayExtend,
    start,
    stop
}
