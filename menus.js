// Menu definitions, displayed by hs_menu-gt on screen and by hs_streamdeck-gt on the
// Stream Deck. Ported from dmg-streamdeck.lua.

// MARK: - Helpers

/** A button that opens a URL in the default browser. */
function url(label, target, icon) {
    return { label: label, icon: icon, url: target }
}

/**
 * A button that switches to the Chrome tab showing a URL.
 *
 * Unlike `url`, this reuses the tab if one is already open, and opens it only when none
 * is. Chrome is brought forward either way.
 */
function tab(label, target, icon, key) {
    return { label: label, icon: icon, key: key, command: "chrome-focus-url", args: [target] }
}

/**
 * Keep the menu displayed after this button acts.
 *
 * For a menu whose buttons are used several times in a row — placing a window, adjusting a
 * light — where returning to the root each time would mean navigating back for every
 * press. Map it over a menu. A button that sets `dismiss` itself keeps its own value.
 */
function stays(button) {
    return { dismiss: false, ...button }
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
    tab("Route 7", "https://bctransit.com/victoria/schedules-and-maps/route-overview?route=7", "bus_7.png"),
    tab("Route 15", "https://bctransit.com/victoria/schedules-and-maps/route-overview?route=15", "bus_15.png"),
    tab("Route 14", "https://bctransit.com/victoria/schedules-and-maps/route-overview?route=14", "bus_14.png"),
    tab("Hill down", "https://victoria.bctracker.ca/stops/100383", "bus_hd.png"),
    tab("Hill up", "https://victoria.bctracker.ca/stops/100390", "bus_hu.png"),
    tab("View St", "https://victoria.bctracker.ca/stops/100042"),
    tab("Anyride down", "https://bct.tmix.se/anyride/#f=100383", "bus_hd.png"),
    tab("Anyride up", "https://bct.tmix.se/anyride/#f=100390", "bus_hu.png")
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
].map(stays)

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

// MARK: - Buttons that draw themselves
//
// `stateProvider` decides whether anything has changed; the image is only redrawn when it
// has. `imageProvider` returns the fields to draw — the ordinary button fields, so icons,
// colours and labels all work.

function pad(n) {
    return String(n).padStart(2, "0")
}

// Redrawn once a minute, and only when the minute has actually changed.
const clockButton = {
    label: "Clock",
    key: "0",
    dismiss: false,
    command: "clock-show",
    updateInterval: 10,
    stateProvider: () => {
        const now = new Date()
        return pad(now.getHours()) + ":" + pad(now.getMinutes())
    },
    imageProvider: (context) => ({
        label: JSON.parse(context.state),
        background: "#F5C542",
        labelColor: "#101014"
    })
}

// The current audio output. Changing device changes the button.
const audioOutButton = {
    label: "Audio out",
    key: "9",
    dismiss: false,
    updateInterval: 15,
    stateProvider: () => {
        const device = hs.audiodevice.defaultOutputDevice()
        return device ? device.name : "none"
    },
    imageProvider: (context) => ({
        icon: "audioPower.png",
        label: JSON.parse(context.state)
    })
}

// The forecast images are written by something else, a couple of times a day. The button
// watches the file's modification time rather than a clock, so it is redrawn when the
// picture actually changes and not before. `iconKey` carries that time, because an icon is
// otherwise cached under its path and this file keeps the same path with new contents.

function weatherButton(label, file, target, key) {
    return {
        label: label,
        key: key,
        command: "chrome-focus-url",
        args: [target],
        dismiss: false,
        updateInterval: 900,
        stateProvider: () => {
            const attributes = hs.fs.attributes(file)
            return attributes ? attributes.modificationDate : 0
        },
        imageProvider: (context) => ({
            icon: file,
            iconKey: file + "@" + context.state,
            hideLabel: true
        })
    }
}

const weatherToday = weatherButton(
    "Today",
    "/Users/dmg/tmDropbox/org/today.png",
    "https://weather.gc.ca/en/forecast/hourly/index.html?coords=48.412,-123.294",
    "7"
)

const weatherTomorrow = weatherButton(
    "Tomorrow",
    "/Users/dmg/tmDropbox/org/tomorrow.png",
    "https://weather.gc.ca/en/location/index.html?coords=48.412,-123.294",
    "8"
)

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
    { label: "Thirds", icon: "symbol:square.split.1x2", key: "3", children: () => thirdsMenu },
    { label: "Quadrants", icon: "symbol:square.split.2x2", key: "4", children: () => quadrantsMenu },
    todo("Undo", "undo.jpg", "a window position history")
].map(stays)

// Reached through a function above, since they are declared after the menu holding them.
const thirdsMenu = [
    { label: "Left", icon: "symbol:rectangle.lefthalf.filled", key: "h", command: "window-left-third" },
    { label: "Centre", icon: "symbol:rectangle.center.inset.filled", key: "j", command: "window-center-third" },
    { label: "Right", icon: "symbol:rectangle.righthalf.filled", key: "l", command: "window-right-third" },
    { label: "Left ⅔", key: "u", command: "window-left-two-thirds" },
    { label: "Right ⅔", key: "i", command: "window-right-two-thirds" }
].map(stays)

const quadrantsMenu = [
    { label: "Top left", icon: "topLeft.png", key: "q", command: "window-top-left" },
    { label: "Top right", icon: "topRight.png", key: "w", command: "window-top-right" },
    { label: "Bottom left", icon: "bottomLeft.png", key: "a", command: "window-bottom-left" },
    { label: "Bottom right", icon: "bottomRight.png", key: "s", command: "window-bottom-right" },
    { label: "Top half", icon: "topHalf-w.png", key: "t", command: "window-top-half" },
    { label: "Bottom half", icon: "bottomHalf-w.png", key: "b", command: "window-bottom-half" }
].map(stays)

// MARK: - Teaching

const teachingMenu = [
    tab("Black", "https://bright.uvic.ca/d2l/home/335421", null, "b"),
    tab("White", "https://bright.uvic.ca/d2l/home/335420", null, "w")
]

// MARK: - Emacs
//
// Each runs elisp through emacsclient and brings Emacs forward. The commands are defined
// in init.js, since which elisp to run belongs to this configuration rather than to the
// Spoon that runs it.

const emacsMenu = [
    { label: "Bookmarks", icon: "bookmark.png", key: "b", command: "emacs-bookmarks" },
    { label: "Agenda", icon: "agenda.png", key: "a", command: "emacs-agenda" },
    { label: "Daily", icon: "daily.png", key: "d", command: "emacs-daily" },
    { label: "Habits", icon: "habits.png", key: "h", command: "emacs-habits" },
    { label: "Capture", icon: "emacs-capture.jpg", key: "c", command: "emacs-capture" },
    { label: "Progress", icon: "emacs-progress.png", key: "p", command: "emacs-progress" },
    { label: "Quick todo", icon: "symbol:checklist", key: "q", command: "emacs-quick-todo" }
]

// MARK: - Chrome
//
// Each switches to the tab whose URL contains the address, and opens it when no tab does.
// Netflix matches on the title instead, as it did in the Hammerspoon 1 configuration:
// its URL changes as you move around the site.

const chromeMenu = [
    tab("YouTube", "https://www.youtube.com/", "youtube.png", "y"),
    tab("ChatGPT", "https://chat.openai.com/", "openai.png", "c"),
    tab("Pocket", "https://getpocket.com/saves", "pocket.png", "p"),
    tab("Disney", "https://disneyplus.com", "disney.png", "d"),
    {
        label: "Netflix",
        icon: "netflix.jpeg",
        key: "n",
        command: "chrome-focus-title",
        args: ["Netflix", "https://netflix.com"]
    },
    tab("Teams", "http://teams.microsoft.com/", "teams.png", "t")
]

// MARK: - Root
//
// The order follows largeMenu in dmg-streamdeck.lua.

const rootMenu = [
    { label: "Windows", icon: "windows.jpg", key: "w", children: windowMenu },

    weatherToday,
    weatherTomorrow,

    { label: "Apps", icon: "apps.png", key: "a", children: applicationsMenu },
    todo("Window switcher", "windows.jpeg", "a window list; snapshots are gone from HS2"),

    { label: "HASS", icon: "hass.png", key: "h", children: hassMenu },

    audioOutButton,
    todo("Audio in", "symbol:mic", "an input-device command"),

    { label: "Buses", icon: "bus2.png", key: "b", children: busMenu },
    { label: "Teaching", icon: "teaching.png", key: "y", children: teachingMenu },

    // A hold on Gmail opens a compose window, as it did in the Hammerspoon 1 menu.
    {
        label: "Gmail",
        icon: "gmail.png",
        key: "g",
        command: "chrome-focus-url",
        args: ["https://mail.google.com/mail/u/0/#inbox"],
        altCommand: "chrome-focus-url",
        altArgs: ["https://mail.google.com/mail/u/0/#inbox?compose=new"]
    },
    tab("Calendar", "https://calendar.google.com", "calendar.png", "n"),
    tab("Teams", "http://teams.microsoft.com/", "teams.png", "s"),

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

    clockButton
]

module.exports = {
    rootMenu,
    busMenu,
    hassMenu,
    windowMenu,
    thirdsMenu,
    quadrantsMenu,
    teachingMenu,
    emacsMenu,
    chromeMenu,
    applicationsMenu
}
