// hs_hass-gt — Home Assistant control, ported from the Hammerspoon 1 hs_hass Spoon.
//
// Every call goes through a shell script that holds the server address and the access
// token and invokes hass-cli, so no credentials appear here or in the configuration.
//
//     const hass = hs.loadSpoon("hs_hass-gt")
//     hass.officeDimmerOn(128)
//     hass.teacToggle()
//
// The service calls are asynchronous and their results are not read: hass-cli reports a
// failure to the console, and the light either comes on or it does not.

// MARK: - User-configurable settings

const config = {
    // Wraps hass-cli with HASS_SERVER and HASS_TOKEN. Arguments are appended to it.
    cli: "/Users/dmg/bin/my-hass-cli.sh",

    // Prepended to PATH for that script. It calls hass-cli by name, and Hammerspoon's
    // shell does not read the profile that puts hass-cli on PATH, so without this every
    // call fails with "command not found" and exit code 127.
    pathPrepend: ["/Users/dmg/.config/dmg/python/bin"],

    // The office dimmer, which the office* functions act on.
    officeDimmer: "light.dmgDimmer",

    // The Marantz has no Home Assistant state to read, so its power is inferred from
    // whether macOS can see it as an audio output device.
    marantzDevice: "HD-DAC1",

    // Scripts defined in Home Assistant.
    scripts: {
        marantzPower: "script.marantzPower",
        teac: "script.teac",
        teacVolumeUp: "script.teacVolumeUp",
        teacVolumeDown: "script.teacVolumeDown"
    },

    // Seconds to wait for the Marantz to appear as an audio device after switching it on.
    marantzWakeSeconds: 5,
    // Announce what was done on screen, as the Hammerspoon 1 Spoon did.
    alerts: true,
    alertDuration: 1.5
}

// MARK: - State

// Timers are held: one with no reference left is garbage collected before it fires.
const pendingTimers = new Set()

function announce(message) {
    console.log(`[hs_hass-gt] ${message}`)
    if (config.alerts) hs.ui.alert(message).duration(config.alertDuration).show()
}

function shellQuote(value) {
    return "'" + String(value).replace(/'/g, "'\\''") + "'"
}

function later(seconds, fn) {
    const timer = hs.timer.doAfter(seconds, () => {
        pendingTimers.delete(timer)
        fn()
    })
    pendingTimers.add(timer)
    return timer
}

// MARK: - Talking to Home Assistant

/**
 * Call a Home Assistant service.
 *
 * @param {string} service The service, as `domain.service` — "light.turn_on".
 * @param {object} [args] Passed as the service's arguments, as `--arguments k=v,k=v`.
 * @returns {Promise} Resolves to true when hass-cli exits successfully.
 */
function service(serviceName, args) {
    const prefix = config.pathPrepend && config.pathPrepend.length > 0
        ? "PATH=" + shellQuote(config.pathPrepend.join(":")) + ':"$PATH" '
        : ""

    let command = prefix + config.cli + " service call " + shellQuote(serviceName)

    const pairs = Object.entries(args || {})
        .filter(([, value]) => value !== undefined && value !== null)
        .map(([key, value]) => `${key}=${value}`)

    if (pairs.length > 0) command += " --arguments " + shellQuote(pairs.join(","))

    return hs.task.shell(command).then((result) => {
        if (result && result.exitCode === 0) return true
        console.error(
            `[hs_hass-gt] ${serviceName} failed` +
            (result ? ` (exit ${result.exitCode}): ${result.stderr}` : "")
        )
        return false
    }).catch((e) => {
        console.error(`[hs_hass-gt] ${serviceName} failed: ${e && e.message ? e.message : e}`)
        return false
    })
}

/** Switch a light on, optionally at a given brightness, 1 to 255. */
function lightOn(entity, brightness) {
    return service("light.turn_on", { entity_id: entity, brightness: brightness })
}

/** Switch a light off. */
function lightOff(entity) {
    return service("light.turn_off", { entity_id: entity })
}

/** Toggle an entity. `domain` is "light", "switch" and so on. */
function toggle(domain, entity) {
    return service(domain + ".toggle", { entity_id: entity })
}

/** Run a Home Assistant script, named as `script.something`. */
function runScript(name) {
    return service("script.turn_on", { entity_id: name })
}

// MARK: - The office dimmer

/** Switch the office dimmer on at a brightness of 1 to 255. */
function officeDimmerOn(brightness) {
    return lightOn(config.officeDimmer, brightness)
}

/** Switch the office dimmer on at its last brightness. */
function officeLightOn() {
    return lightOn(config.officeDimmer)
}

/** Switch the office dimmer off. */
function officeLightOff() {
    return lightOff(config.officeDimmer)
}

/** Toggle the office dimmer. */
function officeLightToggle() {
    return toggle("light", config.officeDimmer)
}

// MARK: - The Marantz
//
// Its power state is not reported to Home Assistant, so it is inferred: the DAC only
// appears as a macOS audio output device while it is powered.

/** The Marantz as an audio device, or null when it is off. */
function marantzDevice() {
    return hs.audiodevice.findDeviceByName(config.marantzDevice)
}

/** Whether the Marantz is on. */
function isMarantzOn() {
    return Boolean(marantzDevice())
}

/** Make the Marantz the default output, if it is on. Returns whether it was. */
function selectMarantz() {
    const device = marantzDevice()
    if (!device) return false
    device.setDefaultOutputDevice()
    return true
}

/** Press the Marantz power button, whatever state it is in. */
function marantzToggleRaw() {
    return runScript(config.scripts.marantzPower)
}

/** Switch the Marantz on and select it, unless it is already on. */
function marantzEnsureOn() {
    if (selectMarantz()) return

    marantzToggleRaw()
    // It takes a few seconds to appear as an audio device.
    later(config.marantzWakeSeconds, () => {
        if (!selectMarantz()) announce(`${config.marantzDevice} did not switch on`)
    })
}

/** Switch the Marantz off, unless it is already off. */
function marantzEnsureOff() {
    if (!isMarantzOn()) {
        announce("Marantz is already off")
        return
    }
    marantzToggleRaw()
}

/** Switch the Marantz on if it is off, and off if it is on. */
function marantzToggle() {
    if (isMarantzOn()) {
        announce("Marantz is on, switching off")
        marantzEnsureOff()
        return
    }
    announce("Marantz is off, switching on")
    marantzEnsureOn()
}

// MARK: - The Teac, and both amplifiers

/** Toggle the Teac amplifier. */
function teacToggle() {
    announce("Toggling Teac")
    return runScript(config.scripts.teac)
}

/** Raise the Teac's volume by one step. */
function teacVolumeUp() {
    return runScript(config.scripts.teacVolumeUp)
}

/** Lower the Teac's volume by one step. */
function teacVolumeDown() {
    return runScript(config.scripts.teacVolumeDown)
}

/** Toggle both desk amplifiers, the Marantz and the Teac. */
function deskAmpToggle() {
    announce("Toggling desk amplifiers")
    marantzToggle()
    teacToggle()
}

// MARK: - Lifecycle

function start() {
    return module.exports
}

function stop() {
    for (const timer of pendingTimers) timer.stop()
    pendingTimers.clear()
    return module.exports
}

module.exports = {
    config,
    // Home Assistant, generally.
    service,
    lightOn,
    lightOff,
    toggle,
    runScript,
    // The office dimmer.
    officeDimmerOn,
    officeLightOn,
    officeLightOff,
    officeLightToggle,
    // The Marantz.
    isMarantzOn,
    selectMarantz,
    marantzToggleRaw,
    marantzEnsureOn,
    marantzEnsureOff,
    marantzToggle,
    // The Teac, and both.
    teacToggle,
    teacVolumeUp,
    teacVolumeDown,
    deskAmpToggle,
    start,
    stop
}
