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
 * Leave the menu where it is after this button acts, on either device.
 *
 * For a menu whose buttons are used several times in a row — placing a window, adjusting a
 * light — where going away each time would mean navigating back for every press. Map it
 * over a menu. A button that answers `navigate` or `keepOpen` itself keeps its own answer.
 */
function stays(button) {
    return { navigate: "stay", keepOpen: true, ...button }
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
        navigate: "stay",
        keepOpen: true,
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
    navigate: "stay",
    keepOpen: true,
    command: "time-show",
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
    navigate: "stay",
    keepOpen: true,
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
        navigate: "stay",
        keepOpen: true,
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

// Both menus merged: everything the Hammerspoon 2 menu had, plus everything the version 1
// menu had that it lacked. Where the two used the same letter for different things, the
// Hammerspoon 2 meaning keeps the lower case and the version 1 one takes the capital —
// i is Info and I is Isolation, s is To screen and S is Swap. The four that were shift
// variants in version 1 are capitals here too, which is the same gesture.
const windowMenu = [
    { label: "Undo", icon: "symbol:arrow.uturn.backward", key: "[", command: "window-undo" },
    { label: "Redo", icon: "symbol:arrow.uturn.forward", key: "]", command: "window-redo" },

    { label: "Maximize", icon: "symbol:arrow.up.left.and.arrow.down.right", key: "m", command: "window-maximize" },
    { label: "Left half", icon: "symbol:rectangle.lefthalf.filled", key: "h", command: "window-left-half" },
    { label: "Right half", icon: "symbol:rectangle.righthalf.filled", key: "l", command: "window-right-half" },
    { label: "Centre", icon: "symbol:rectangle.center.inset.filled", key: "c", command: "window-center" },
    { label: "Fullscreen", icon: "symbol:arrow.up.left.and.down.right.magnifyingglass", key: "f", command: "window-toggle-fullscreen" },
    { label: "Minimize", icon: "symbol:arrow.down.right.and.arrow.up.left", key: "n", command: "window-minimize" },

    { label: "Vert max", icon: "symbol:arrow.up.and.down", key: "V", command: "window-vertical-maximize" },
    { label: "Horiz max", icon: "symbol:arrow.left.and.right", key: "H", command: "window-horizontal-maximize" },
    { label: "Half height", icon: "symbol:rectangle.tophalf.filled", key: "-", command: "window-half-height" },
    { label: "Half width", icon: "symbol:rectangle.lefthalf.filled", key: "W", command: "window-half-width" },

    { label: "Move left", icon: "symbol:arrow.left", key: "left", command: "window-move-left" },
    { label: "Move right", icon: "symbol:arrow.right", key: "right", command: "window-move-right" },
    { label: "Move up", icon: "symbol:arrow.up", key: "up", command: "window-move-up" },
    { label: "Move down", icon: "symbol:arrow.down", key: "down", command: "window-move-down" },

    { label: "To screen", icon: "symbol:display.2", key: "s", command: "window-move-to-screen" },
    { label: "Next screen", icon: "symbol:rectangle.on.rectangle", key: "space", command: "window-next-screen" },
    { label: "Prev screen", icon: "symbol:rectangle.on.rectangle", key: "B", command: "window-previous-screen" },

    { label: "Swap behind", icon: "symbol:arrow.left.arrow.right", key: "S", command: "window-swap-behind" },
    // Both ask for the second window. The menu stays drawn, as everything here does, but
    // gives up the keyboard until the chooser is answered.
    { label: "Swap with", icon: "symbol:arrow.triangle.swap", key: "x", command: "window-swap-with" },
    { label: "Tile with", icon: "symbol:rectangle.split.2x1", key: "t", command: "window-tile-with" },
    { label: "To back", icon: "symbol:square.on.square", key: "0", command: "window-send-to-back" },
    { label: "Prev window", icon: "symbol:arrow.uturn.left", key: "p", command: "window-previous" },

    { label: "Isolate", icon: "symbol:moon.fill", key: "I", command: "window-toggle-isolation" },
    { label: "Info", icon: "symbol:info.circle", key: "i", command: "window-info" },
    { label: "Centre mouse", icon: "symbol:cursorarrow", key: "M", command: "window-center-mouse" },
    { label: "Mouse next", icon: "symbol:cursorarrow.motionlines", key: "N", command: "window-center-mouse-next" },

    { label: "Thirds", icon: "symbol:square.split.1x2", key: "3", children: () => thirdsMenu },
    { label: "Quadrants", icon: "symbol:square.split.2x2", key: "4", children: () => quadrantsMenu },
    { label: "Widths", icon: "symbol:ruler", key: "5", children: () => widthsMenu }
].map(stays)

// The version 1 menu had these as 2 through 8 in its own row. One command with an argument
// rather than seven commands, so the menu carries the number.
const widthsMenu = [2, 3, 4, 5, 6, 7, 8].map((n) => stays({
    label: `1/${n} width`,
    key: String(n),
    command: "window-fraction-width",
    args: [n]
}))

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

// MARK: - Clipboard
//
// The history itself is a chooser, so the button that opens it closes the on-screen menu
// first, as Choose album does. The rest change the history in place and leave the menu up.

const clipboardMenu = [
    {
        label: "History", icon: "symbol:list.bullet", key: "v",
        command: "clipboard-show", navigate: "stay", keepOpen: false
    },
    stays({ label: "Paste-on-select", icon: "symbol:arrow.down.doc", key: "s", command: "clipboard-paste-on-select-toggle" }),
    stays({ label: "Drop last", icon: "symbol:delete.left", key: "d", command: "clipboard-delete-last" }),
    stays({ label: "Clear all", icon: "symbol:trash", key: "c", command: "clipboard-clear" })
]

// MARK: - Root
//
// The order follows largeMenu in dmg-streamdeck.lua.

// Apple Music. The letters are the ones the Hammerspoon 1 menu used, and the four that
// were shift-variants there are capitals here: b/B for track and album back, n/N forward,
// u/U for a coarse and a fine volume rise, d/D for the fall.
const musicMenu = [
    { label: "Play/Pause", icon: "symbol:playpause.fill", key: "p", command: "appleMusic-play-pause" },
    { label: "Prev track", icon: "symbol:backward.fill", key: "b", command: "appleMusic-previous-track" },
    { label: "Next track", icon: "symbol:forward.fill", key: "n", command: "appleMusic-next-track" },
    { label: "Prev album", icon: "symbol:backward.end.fill", key: "B", command: "appleMusic-previous-album" },
    { label: "Next album", icon: "symbol:forward.end.fill", key: "N", command: "appleMusic-next-album" },
    { label: "Now playing", icon: "symbol:info.circle", key: "i", command: "appleMusic-now-playing" },

    { label: "Volume", icon: "symbol:speaker.wave.2", key: "v", command: "appleMusic-volume" },
    { label: "Vol +20", icon: "symbol:speaker.plus.fill", key: "u", command: "appleMusic-adjust-volume", args: [20] },
    { label: "Vol −20", icon: "symbol:speaker.minus.fill", key: "d", command: "appleMusic-adjust-volume", args: [-20] },
    { label: "Vol +5", icon: "symbol:speaker.plus", key: "U", command: "appleMusic-adjust-volume", args: [5] },
    { label: "Vol −5", icon: "symbol:speaker.minus", key: "D", command: "appleMusic-adjust-volume", args: [-5] },

    { label: "Random album", icon: "symbol:shuffle", key: "r", command: "appleMusic-random-album" },
    { label: "Add current", icon: "symbol:plus.circle", key: "a", command: "appleMusic-add-current-album" },
    { label: "Auto-play", icon: "symbol:infinity", key: "t", command: "appleMusic-toggle-auto-play" },

    // The exception to `stays`, and the case that separated the two questions: the chooser
    // takes the keyboard, so the on-screen menu has to close — but closing is all it should
    // do. Staying put means a Stream Deck, which cannot close anything, is left where it
    // was, and the on-screen menu reopens here rather than at the root.
    {
        label: "Choose album", icon: "symbol:list.bullet", key: "c",
        command: "appleMusic-choose-album", navigate: "stay", keepOpen: false
    },
    { label: "Music app", key: "m", app: "com.apple.Music", navigate: "stay", keepOpen: true },

    // The same menu the root holds, reached from here as well: the amplifiers and the Teac
    // are part of playing music, so switching them on should not mean going back first.
    // One array, referenced twice, so the two stay identical.
    { label: "HASS", icon: "hass.png", key: "h", children: hassMenu }
].map(stays)

const rootMenu = [
    // Capital L: lower case l is the URL handler, and a deliberate action is no worse for
    // needing shift.
    { label: "Lock", icon: "symbol:lock.fill", key: "L", command: "screen-lock" },

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

    // Chooses how opened links are routed, or hands http and https back to another
    // application. The chooser it shows needs the on-screen menu out of the way first,
    // which is what `screen` defaults to.
    { label: "url H", icon: "symbol:link", key: "l", command: "url-route-switch" },

    todo("Play/pause", "playpause.png", "a media key; HS2 has no system key event"),
    todo("Video", "video.png", "the annoy window helpers"),

    // Music's own icon, as when this button launched the application: a submenu button
    // cannot use `app`, which would open it instead of the submenu.
    { label: "Music", icon: "bundle:com.apple.Music", key: "u", children: musicMenu },
    { label: "kitty", app: "net.kovidgoyal.kitty", key: "k" },
    { label: "Emacs", app: "org.gnu.Emacs", key: "e" },

    { label: "Emacs cmds", icon: "emacs-capture.jpg", key: "x", children: emacsMenu },

    { label: "Countdown", icon: "tomato.jpeg", key: "t", command: "countdown-start" },
    todo("Whisper", "whisper.png", "the whisper dictation Spoon"),
    { label: "Paste", icon: "symbol:doc.on.clipboard", key: "v", command: "paste" },

    // Capital V, since v sends cmd-v: the same letter for the same subject.
    { label: "Clipboard", icon: "symbol:list.clipboard", key: "V", children: clipboardMenu },

    clockButton
]

module.exports = {
    rootMenu,
    busMenu,
    hassMenu,
    windowMenu,
    thirdsMenu,
    quadrantsMenu,
    widthsMenu,
    teachingMenu,
    emacsMenu,
    chromeMenu,
    clipboardMenu,
    musicMenu,
    applicationsMenu
}
