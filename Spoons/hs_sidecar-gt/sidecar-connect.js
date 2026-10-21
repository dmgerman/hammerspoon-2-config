// Connects Sidecar to an iPad, so that the iPad extends the desktop.
//
//     osascript -l JavaScript sidecar-connect.js "iPad mini"
//
// The argument is matched against the start of each Sidecar device's name; macOS names a
// second iPad of the same name "iPad mini (2)", so "iPad mini" matches either. With no
// argument, or an empty one, the first device is used.
//
// On success this prints one line and exits 0. On failure it prints the reason and exits
// non-zero; osascript then puts the message on stderr.
//
// Sidecar has no public API. This uses SidecarDisplayManager from the private framework
// SidecarCore, so a macOS update may break it.
//
// connectToDevice:completion: does connect, but the completion block is never called when
// it is given a JavaScript function: JXA has no signature for a private method, so it
// cannot build the block the method expects. The script therefore polls connectedDevices
// instead of waiting for the completion.

ObjC.import("Foundation")

const TIMEOUT_SECONDS = 20
const POLL_SECONDS = 0.25

function deviceName(device) {
    return ObjC.unwrap(device.name)
}

function deviceList(array) {
    const devices = []
    if (array.isNil()) return devices
    for (let i = 0; i < array.count; i++) devices.push(array.objectAtIndex(i))
    return devices
}

function run(argv) {
    const prefix = argv.length > 0 ? argv[0] : ""

    const bundle = $.NSBundle.bundleWithPath("/System/Library/PrivateFrameworks/SidecarCore.framework")
    if (bundle.isNil() || !bundle.load) throw new Error("could not load SidecarCore")
    const managerClass = $.NSClassFromString("SidecarDisplayManager")
    if (managerClass.isNil()) throw new Error("SidecarCore has no SidecarDisplayManager")
    const manager = managerClass.sharedManager

    const devices = deviceList(manager.devices)
    const target = devices.find(d => deviceName(d).startsWith(prefix))
    if (!target) {
        const names = devices.map(deviceName)
        throw new Error(`no Sidecar device named "${prefix}"; available: ${names.length ? names.join(", ") : "none"}`)
    }
    const name = deviceName(target)
    const isConnected = () => deviceList(manager.connectedDevices).some(d => deviceName(d) === name)

    if (isConnected()) return `${name} is already connected`

    manager.connectToDeviceCompletion(target, () => {})

    const deadline = $.NSDate.dateWithTimeIntervalSinceNow(TIMEOUT_SECONDS)
    while (!isConnected()) {
        if ($.NSDate.date.compare(deadline) >= 0) {
            throw new Error(`${name} did not connect within ${TIMEOUT_SECONDS} seconds`)
        }
        $.NSRunLoop.currentRunLoop.runUntilDate($.NSDate.dateWithTimeIntervalSinceNow(POLL_SECONDS))
    }
    return `${name} connected`
}
