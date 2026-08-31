// Menu definitions, displayed by hs_menu-gt on screen and by hs_streamdeck-gt on the
// Stream Deck. Ported from dmg-streamdeck.lua.

// MARK: - Helpers

/** A button that opens a URL. */
function url(label, target, icon) {
    return { label: label, icon: icon, url: target }
}

/**
 * A button for something not ported from the Hammerspoon 1 configuration yet.
 *
 * It occupies its place in the menu and says what is missing when pressed, so the layout
 * is the one being worked towards rather than the one that happens to work today.
 *
 * @param {string} label Shown on the button.
 * @param {string} icon Its icon.
 * @param {string} needs What has to exist before it can work.
 */
function todo(label, icon, needs) {
    return {
        label: label,
        icon: icon,
        dismiss: false,
        fn: () => hs.ui.alert(`${label}\nnot ported yet — needs ${needs}`).duration(3).show()
    }
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

// MARK: - Home Assistant
//
// Ported from hassMenu() in dmg-streamdeck.lua. The buttons that set a brightness keep the
// values the Hammerspoon 1 menu used; Home Assistant's scale runs from 1 to 255.
//
// Two buttons behaved differently there, because of defects in hs_hass.spoon rather than
// by intent. "on" called of_light_on(), which was never defined, so it did nothing; and
// of_light_off() was defined twice, the second definition calling light_on, so "off"
// switched the dimmer on. Both do what their labels say here.

// The menu stays displayed after a press, since lights and volume are usually adjusted
// several times in a row. Leave with Back on the deck, or Delete or Escape on screen.
const hassMenu = [
    { label: "On 100%", key: "1", command: "hass-office-brightness", args: [250] },
    { label: "On 50%", key: "2", command: "hass-office-brightness", args: [128] },
    { label: "On 1%", key: "3", command: "hass-office-brightness", args: [1] },
    { label: "On", key: "o", command: "hass-office-on" },
    { label: "Off", key: "f", command: "hass-office-off" },
    { label: "Toggle", key: "g", command: "hass-office-toggle" },
    { label: "Teac", icon: "teac.png", key: "t", command: "hass-teac-toggle" },
    { label: "Teac +", key: "u", command: "hass-teac-volume-up" },
    { label: "Teac −", key: "d", command: "hass-teac-volume-down" },
    { label: "Marantz", icon: "marantz.png", key: "m", command: "hass-marantz-toggle" },
    { label: "Amps", icon: "audioPower.png", key: "a", command: "hass-desk-amps-toggle" }
].map((button) => ({ dismiss: false, ...button }))

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

// MARK: - Window management
//
// The commands are defined in init.js. The Hammerspoon 1 menu also had thirds, quadrants
// and top and bottom halves, which need commands that do not exist yet.

const windowMenu = [
    { label: "Maximize", icon: "symbol:arrow.up.left.and.arrow.down.right", key: "m", command: "window-maximize" },
    { label: "Left half", icon: "symbol:rectangle.lefthalf.filled", key: "h", command: "window-left-half" },
    { label: "Right half", icon: "symbol:rectangle.righthalf.filled", key: "l", command: "window-right-half" },
    { label: "Centre", icon: "symbol:rectangle.center.inset.filled", key: "c", command: "window-center" },
    { label: "Fullscreen", icon: "symbol:arrow.up.left.and.down.right.magnifyingglass", key: "f", command: "window-toggle-fullscreen" },
    { label: "Minimize", icon: "symbol:arrow.down.right.and.arrow.up.left", key: "n", command: "window-minimize" },
    { label: "To screen", icon: "symbol:display.2", key: "s", command: "window-move-to-screen" },
    { label: "Info", icon: "symbol:info.circle", key: "i", command: "window-info" },
    todo("Thirds", "symbol:square.split.1x2", "window-third commands"),
    todo("Quadrants", "symbol:square.split.2x2", "window-quadrant commands"),
    todo("Undo", "undo.jpg", "a window position history")
]

// MARK: - Teaching

const teachingMenu = [
    url("Black", "https://bright.uvic.ca/d2l/home/335421"),
    url("White", "https://bright.uvic.ca/d2l/home/335420")
]

// MARK: - Emacs
//
// Every one of these ran elisp through emacsclient in the Hammerspoon 1 configuration.
// Porting them needs an equivalent of hs_emacs_helper, which raises Emacs and reports a
// failed emacsclient.

const emacsMenu = [
    todo("Bookmarks", "bookmark.png", "an emacsclient helper"),
    todo("Agenda", "agenda.png", "an emacsclient helper"),
    todo("Daily", "daily.png", "an emacsclient helper"),
    todo("Habits", "habits.png", "an emacsclient helper"),
    todo("Capture", "emacs-capture.jpg", "an emacsclient helper"),
    todo("Progress", "emacs-progress.png", "an emacsclient helper")
]

// MARK: - Chrome
//
// These switched to a tab by URL through ~/bin/focusTabChrome.py. Porting them needs a
// command that runs it.

const chromeMenu = [
    todo("YouTube", "youtube.png", "focusTabChrome.py"),
    todo("ChatGPT", "openai.png", "focusTabChrome.py"),
    todo("Pocket", "pocket.png", "focusTabChrome.py"),
    todo("Disney", "disney.png", "focusTabChrome.py"),
    todo("Netflix", "netflix.jpeg", "focusTabChrome.py"),
    todo("Teams", "teams.png", "focusTabChrome.py")
]

// MARK: - Root
//
// The order follows largeMenu in dmg-streamdeck.lua.

const rootMenu = [
    { label: "Windows", icon: "windows.jpg", key: "w", children: windowMenu },

    url("Today", "https://weather.gc.ca/en/forecast/hourly/index.html?coords=48.412,-123.294", "symbol:cloud.sun"),
    url("Tomorrow", "https://weather.gc.ca/en/location/index.html?coords=48.412,-123.294", "symbol:cloud.sun.rain"),

    { label: "Apps", icon: "apps.png", key: "a", children: applicationsMenu },
    todo("Window switcher", "windows.jpeg", "a window list; snapshots are gone from HS2"),

    { label: "HASS", icon: "hass.png", key: "h", children: hassMenu },

    todo("Audio out", "audioPower.png", "dynamic buttons, to show the current device"),
    todo("Audio in", "symbol:mic", "dynamic buttons, to show the current device"),

    { label: "Buses", icon: "bus2.png", key: "b", children: busMenu },
    { label: "Teaching", icon: "teaching.png", key: "y", children: teachingMenu },

    todo("Gmail", "gmail.png", "focusTabChrome.py, or a Gmail command"),
    todo("Calendar", "calendar.png", "focusTabChrome.py, or a Calendar command"),
    todo("Teams", "teams.png", "focusTabChrome.py"),

    todo("Next fullscreen", "nextFullscreen.png", "the dmgWin window helpers"),
    todo("Isolate", "isolate.png", "the annoy window helpers"),
    { label: "Chrome", icon: "chrome.png", key: "r", children: chromeMenu },
    todo("Play/pause", "playpause.png", "a media key; HS2 has no system key event"),
    todo("Video", "video.png", "the annoy window helpers"),

    { label: "Music", app: "com.apple.Music", key: "u" },
    { label: "kitty", app: "net.kovidgoyal.kitty", key: "k" },
    { label: "Emacs", app: "org.gnu.Emacs", key: "e" },

    { label: "Emacs cmds", icon: "emacs-capture.jpg", key: "x", children: emacsMenu },

    { label: "Countdown", icon: "tomato.jpeg", key: "t", command: "countdown-start" },
    todo("Whisper", "whisper.png", "the whisper dictation Spoon"),
    { label: "Paste", icon: "symbol:doc.on.clipboard", key: "v", command: "paste" },

    { label: "Clock", icon: "symbol:clock", key: "c", command: "clock-show" }
]

module.exports = {
    rootMenu,
    busMenu,
    hassMenu,
    windowMenu,
    teachingMenu,
    emacsMenu,
    chromeMenu,
    applicationsMenu
}
