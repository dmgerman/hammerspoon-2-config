// Menu definitions, displayed by hs_menu-gt on screen and by hs_streamdeck-gt on the
// Stream Deck. Ported from dmg-streamdeck.lua.

// MARK: - Helpers

/** A button that opens a URL. */
function url(label, target, icon) {
    return { label: label, icon: icon, url: target }
}

// MARK: - Buses

const busMenu = [
    url("Route 7", "https://bctransit.com/victoria/schedules-and-maps/route-overview?route=7", "bus_7.png"),
    url("Route 15", "https://bctransit.com/victoria/schedules-and-maps/route-overview?route=15", "bus_15.png"),
    url("Route 14", "https://bctransit.com/victoria/schedules-and-maps/route-overview?route=14", "bus_14.png"),
    url("Hill down", "https://victoria.bctracker.ca/stops/100383", "bus_hd.png"),
    url("Hill up", "https://victoria.bctracker.ca/stops/100390", "bus_hu.png"),
    url("View St", "https://victoria.bctracker.ca/stops/100042"),
    url("Anyride down", "https://bct.tmix.se/anyride/#f=100383", "bus_hd.png"),
    url("Anyride up", "https://bct.tmix.se/anyride/#f=100390", "bus_hu.png")
]

// MARK: - Applications
//
// Computed when the menu is opened, so it lists what is running at that moment. A short
// press brings the application forward; a hold hides it when it is already frontmost.

function applicationsMenu() {
    return hs.application.runningApplications()
        .filter((app) => app.kind === "standard" && app.bundleID && app.allWindows.length > 0)
        .sort((a, b) => (a.title || "").localeCompare(b.title || ""))
        .map((app) => ({
            label: app.title,
            app: app.bundleID
        }))
}

// MARK: - Root

// Reports which kind of press it received. `dismiss: false` keeps the menu displayed, so
// presses can be tried one after another.
const pressTestButton = {
    label: "Press test",
    icon: "symbol:hand.tap",
    key: "p",
    dismiss: false,
    fn: () => hs.ui.alert("SHORT press").duration(1.5).show(),
    altFn: () => hs.ui.alert("LONG press").duration(1.5).show()
}

const rootMenu = [
    pressTestButton,
    { label: "Buses", icon: "bus2.png", key: "b", children: busMenu },
    { label: "Apps", icon: "apps.png", key: "a", children: applicationsMenu },
    { label: "Clock", icon: "symbol:clock", key: "c", command: "clock-show" },
    { label: "Countdown", icon: "tomato.jpeg", key: "t", command: "countdown-start" },
    { label: "Maximize", icon: "symbol:rectangle.expand.vertical", key: "m", command: "window-maximize" }
]

module.exports = { rootMenu, busMenu, applicationsMenu, pressTestButton }
