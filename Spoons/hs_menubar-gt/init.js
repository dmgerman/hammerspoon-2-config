// hs_menubar-gt — reach the macOS menu bar extras from the keyboard.
//
// The icons on the right of the menu bar belong to whichever applications put them there.
// This Spoon finds them and presses one for you, so a VPN or a clipboard manager can be
// opened without the mouse.
//
//     const mb = hs.loadSpoon("hs_menubar-gt")
//     mb.extras()                  // what is in the menu bar now
//     mb.choose()                  // pick one from a chooser
//     mb.menu()                    // the same list as menu buttons
//     mb.press("mb-nordvpn")       // press one by name
//
// A port of the Hammerspoon 1 hs_menubar Spoon, which showed a chooser of every item.
//
// ## Names, and why they are not commands
//
// Each extra is named `mb-<application>`, and `mb-<application>-<n>` when one application
// has several. Where an item's own title is usable, `mb-<application>-<title>` answers as
// well, so an item titled "VPN" is both `mb-systemuiserver-1` and `mb-systemuiserver-vpn`.
//
// Everything in the menu bar is listed, Hammerspoon's own items included. See
// config.skipApplications to leave an application out.
//
// These names are this Spoon's own. They are not defined as hs_interactive-gt commands and
// do not appear alongside them, for two reasons. Defining them would mean scanning at load
// to find out what to define, and scanning again whenever applications launch or quit, which
// is latency spent before anyone has asked for it. And a command defined from a scan is
// stale the moment its application quits: it would sit in the chooser naming something that
// is no longer there. Scanning when asked means the list is never wrong.
//
// Titles are not used on their own because most of them cannot be typed or do not last.
// Measured on one machine: four applications reported an empty title, one reported none at
// all, three were a single emoji, and one was `↓37.8MB ↑17.1MB`, which changes every time
// its application polls the network. The application's name is stable, unique and typeable,
// and it is what one thinks of when reaching for one of these icons.
//
// ## Scanning
//
// Nothing is cached and no watcher is installed. A scan walks every running process and
// costs about 100ms, which is affordable when a chooser or a menu asks for it.
//
// ## Reading the accessibility tree
//
// `element.children()` gives the child elements.
//
// One thing to watch: `children` and `attributeNames` are methods. Read as properties they
// return the function rather than failing, and a function's `length` is its argument count,
// so `element.children.length` is 0 for every element and looks like a real answer of "no
// children".
//
// `element.attributeValue("AXChildren")` works too, and returns proper elements since
// upstream improved the bridging for issue #221. It used to return plain JavaScript objects
// with no role, title or performAction, which is why this Spoon reads children through
// `children()`; either would do now.

// MARK: - User-configurable settings

const config = {
    // Applications whose extras are never listed. Everything is listed by default,
    // including Hammerspoon's own items and the system icons that Control Center and
    // SystemUIServer own.
    //
    // Add an application's name here to leave it out. Control Center alone accounts for
    // about twenty items, most of them reporting no title at all, so
    // `config.skipApplications.push("Control Center")` is the way to shorten the list if it
    // is longer than it is useful.
    //
    // Hammerspoon's own items are listed, and are opened by clicking where they are rather
    // than through accessibility. See clickElement(): pressing one through accessibility
    // deadlocks Hammerspoon and it has to be killed.
    skipApplications: [],

    // Prefix for the generated names.
    namePrefix: "mb-",

    // Width of the chooser, as a fraction of the screen's width.
    chooserWidth: 0.3,

    // Rows visible in the chooser at once.
    rowsToDisplay: 14,

    // How many levels of submenu to follow when reading an item's menu. 0 offers only the
    // items themselves. Submenus are followed rather than offered: pressing one only opens
    // it, so the entries inside are what can be invoked.
    menuDepth: 2,

    // How long to wait after the chooser closes before pressing, in seconds. A menu bar
    // menu is dismissed by anything else taking focus, and the chooser is still holding it
    // when a row is chosen. Raise this if a menu still opens and closes again.
    pressDelay: 0.2,

    // Whether the pointer is put back where it was after clicking one of Hammerspoon's own
    // items, and how long afterwards, in seconds. Set restoreMouse false to leave the
    // pointer on the item, which is what happens when the menu bar is clicked by hand.
    restoreMouse: true,
    restoreMouseDelay: 0.3,

    // Log where each click lands. For working out why a menu did not open.
    logClicks: false,

    // Report how long a scan took.
    logTimings: false
}

// Held so they cannot be collected before they fire; see choose() and clickElement().
let pressTimer = null
let restoreTimer = null

// This process, so that its own menu bar items can be told apart from everyone else's.
const OWN_BUNDLE_ID = "net.tenshu.Hammerspoon-2"

function log(message) {
    console.error(`[hs_menubar-gt] ${message}`)
}

// MARK: - The accessibility walk

/** An element's children, or an empty array if it has none or has gone. */
function childrenOf(element) {
    if (!element) return []
    try {
        return element.children() || []
    } catch (e) {
        return []
    }
}

/** An application's extras menu bar, or null. */
function extrasBarFor(application) {
    try {
        const element = application.axElement()
        return element ? element.attributeValue("AXExtrasMenuBar") : null
    } catch (e) {
        return null
    }
}

/**
 * Whether an item is in the menu bar and can be pressed.
 *
 * Advertising AXPress is not enough. Control Center keeps an element for every module it
 * could show — Focus, Screen Mirroring, Now Playing and the rest — whether or not that
 * module is in the menu bar. The ones that are not come back disabled, sized 0x0 and parked
 * off screen at the bottom left, and they still list AXPress. Seventeen of Control Center's
 * twenty-four items were these, and pressing one does nothing at all.
 *
 * So an item counts only if it is enabled and has a size. That leaves what is on screen,
 * which is also what anyone reading the menu bar means by an item.
 */
function isPressable(item) {
    try {
        const actions = item.actionNames() || []
        if (!actions.includes("AXPress")) return false

        if (item.isEnabled === false) return false

        const size = item.size
        if (size && (size.w <= 0 || size.h <= 0)) return false

        return true
    } catch (e) {
        return false
    }
}

/** An item's own label, which is often empty. Used only for the optional name alias. */
function labelOf(item) {
    try {
        const title = item.title
        if (title !== null && title !== undefined && String(title).trim() !== "") {
            return String(title).trim()
        }
    } catch (e) { /* fall through */ }
    try {
        const described = item.elementDescription
        if (described !== null && described !== undefined && String(described).trim() !== "") {
            return String(described).trim()
        }
    } catch (e) { /* fall through */ }
    return ""
}

// MARK: - Names

/** Lowercase, hyphenated, ASCII letters and digits only. Empty when nothing survives. */
function slug(text) {
    return String(text || "")
        .toLowerCase()
        .replace(/[^a-z0-9]+/g, "-")
        .replace(/^-+|-+$/g, "")
}

/**
 * Whether a title makes a name worth offering.
 *
 * Letters only. A title carrying digits is usually a reading rather than a name — a byte
 * count, a temperature, a time — and would give a name that changes under the user. A title
 * that slugs to nothing was an emoji or was empty.
 */
function isStableLabel(text) {
    const s = slug(text)
    return s !== "" && /^[a-z]+(-[a-z]+)*$/.test(s)
}

// MARK: - Scanning

/**
 * Every pressable menu bar extra, in menu bar order per application.
 *
 * @returns {object[]} `{application, bundleID, label, index, ofApplication, element, name,
 *          alias}`, where `index` is 1-based within the application and `ofApplication` is
 *          how many that application has.
 */
function extras() {
    const started = Date.now()
    const found = []

    for (const application of hs.application.runningApplications()) {
        const name = application.title || ""
        if (config.skipApplications.includes(name)) continue

        const bar = extrasBarFor(application)
        if (!bar) continue

        const items = childrenOf(bar).filter(isPressable)
        if (!items.length) continue

        const appSlug = slug(name) || `pid-${application.pid}`
        items.forEach((element, at) => {
            found.push({
                application: name,
                bundleID: application.bundleID || null,
                // Opened by clicking rather than through accessibility; see clickElement().
                own: application.bundleID === OWN_BUNDLE_ID,
                label: labelOf(element),
                index: at + 1,
                ofApplication: items.length,
                element: element,
                appSlug: appSlug,
                // Filled in below, once the count for this application is known.
                name: null,
                alias: null
            })
        })
    }

    // An application with one extra gets the bare name; with several, each is numbered. A
    // usable title answers as well, alongside the number rather than instead of it.
    for (const entry of found) {
        const base = config.namePrefix + entry.appSlug
        entry.name = entry.ofApplication === 1 ? base : `${base}-${entry.index}`
        entry.alias = isStableLabel(entry.label) && slug(entry.label) !== entry.appSlug
            ? `${base}-${slug(entry.label)}`
            : null
    }

    if (config.logTimings) {
        log(`scanned in ${Date.now() - started}ms, ${found.length} extras`)
    }
    return found
}

/** How an extra is described in a chooser row or a menu button. */
function describe(entry) {
    if (entry.label && entry.label !== entry.application) {
        return `${entry.application}: ${entry.label}`
    }
    if (entry.ofApplication > 1) return `${entry.application} ${entry.index}`
    return entry.application
}

// MARK: - Menu entries
//
// What is inside one of these menus, read without opening it.
//
// An item's menu is an AXMenu child, and its entries are that menu's children. Most
// applications build the menu when the item is created, so the entries can be read, named
// and invoked while nothing is on screen. Invoking an entry is not the same as pressing the
// item: the item opens a menu and enters a modal run loop, while an entry just performs its
// action, so no menu ever appears.
//
// Some applications build their menu only when it is opened — Control Center, NordVPN and
// several of Hammerspoon's own report no AXMenu child until then. Those are left as they
// are: the item itself can still be opened, and what is inside it is not known until it is.

/** An item's AXMenu, or null when it has none until opened. */
function menuOf(element) {
    for (const child of childrenOf(element)) {
        try {
            if (child.role === "AXMenu") return child
        } catch (e) { /* skip */ }
    }
    return null
}

/** Whether a menu entry is worth offering: it does something and it is not a separator. */
function isInvokable(entry) {
    try {
        if (entry.isEnabled === false) return false
        const title = entry.title
        if (title === null || title === undefined || String(title).trim() === "") return false
        const actions = entry.actionNames() || []
        return actions.includes("AXPress")
    } catch (e) {
        return false
    }
}

/**
 * Every entry in an item's menu, and in its submenus, depth-first.
 *
 * @param {object} element The menu bar item.
 * @param {number} depth How many levels of submenu to follow.
 * @returns {object[]} `{element, path}`, where `path` names the entry and the submenus above
 *          it, outermost first.
 */
function menuEntries(element, depth) {
    const menu = menuOf(element)
    if (!menu) return []

    const collect = (inMenu, above, left) => {
        const found = []
        for (const entry of childrenOf(inMenu)) {
            let title = ""
            try { title = String(entry.title || "").trim() } catch (e) { continue }

            const here = above.concat([title])

            // A submenu is an entry with an AXMenu of its own. It is followed rather than
            // offered: pressing it only opens the submenu.
            const below = left > 0 ? menuOf(entry) : null
            if (below) {
                found.push(...collect(below, here, left - 1))
                continue
            }

            if (isInvokable(entry)) found.push({ element: entry, path: here })
        }
        return found
    }

    return collect(menu, [], depth === undefined ? config.menuDepth : depth)
}

/**
 * Every menu entry of every extra, named.
 *
 * Names are the item's name and the entry's path: `mb-deepl-translate-text`. An entry whose
 * title yields nothing typeable is left out, since it could not be asked for.
 */
function entries() {
    const started = Date.now()
    const found = []

    for (const item of extras()) {
        for (const entry of menuEntries(item.element)) {
            const tail = entry.path.map(slug).filter((part) => part !== "").join("-")
            if (tail === "") continue
            found.push({
                application: item.application,
                bundleID: item.bundleID,
                own: item.own,
                item: item,
                element: entry.element,
                path: entry.path,
                name: `${item.name}-${tail}`
            })
        }
    }

    if (config.logTimings) {
        log(`read ${found.length} menu entries in ${Date.now() - started}ms`)
    }
    return found
}

/** How a menu entry is described in a chooser row. */
function describeEntry(entry) {
    return `${describe(entry.item)}  ▸  ${entry.path.join("  ▸  ")}`
}

// MARK: - Pressing

/**
 * Press one element.
 *
 * Hammerspoon's own items are clicked rather than pressed; see clickElement() for why. The
 * choice is made here rather than by the caller so that no caller can get it wrong.
 */
function pressElement(element, ownsIt) {
    if (!element) return false

    if (ownsIt) return clickElement(element)

    try {
        element.performAction("AXPress")
        return true
    } catch (e) {
        log(`could not press: ${e}`)
        return false
    }
}

/**
 * Open a menu by clicking where its item is, rather than by pressing it.
 *
 * performAction("AXPress") on an element belonging to this same process deadlocks
 * Hammerspoon. The accessibility call is delivered to the main thread, which is the thread
 * already running the JavaScript that made the call, and opening a menu enters a nested
 * modal run loop that never returns. Hammerspoon stops answering keys, its timers stop, and
 * it has to be killed. This happened twice while writing this Spoon.
 *
 * A click has none of that. It goes to the window server and comes back as an ordinary
 * event, with the main thread free the whole time, which is what happens when the menu bar
 * is clicked by hand.
 *
 * The pointer is put back where it was afterwards.
 */
function clickElement(element) {
    let position = null
    let size = null
    try {
        position = element.position
        size = element.size
    } catch (e) {
        log("could not read the item's position")
        return false
    }
    if (!position || !size || size.w <= 0 || size.h <= 0) {
        log("item has no position to click")
        return false
    }

    const at = { x: position.x + size.w / 2, y: position.y + size.h / 2 }

    if (config.logClicks) {
        log(`clicking (${Math.round(at.x)}, ${Math.round(at.y)}) ` +
            `for an item at (${Math.round(position.x)}, ${Math.round(position.y)}) ` +
            `sized ${Math.round(size.w)}x${Math.round(size.h)}`)
    }

    // absolutePosition(), not getAbsolutePosition(): the latter does not exist, and reading
    // it gives undefined rather than failing.
    let restoreTo = null
    try { restoreTo = hs.mouse.absolutePosition() } catch (e) { restoreTo = null }

    try {
        hs.mouse.setAbsolutePosition(at.x, at.y)
        // Two numbers, not a point: given an object, both arguments come out as nothing and
        // the click lands at the top left of the screen, on the Apple menu.
        hs.eventtap.leftClick(at.x, at.y)
    } catch (e) {
        log(`could not click the item: ${e}`)
        return false
    }

    if (restoreTo && config.restoreMouse) {
        // After the menu has had a moment to open, so the click is not cut short.
        restoreTimer = hs.timer.doAfter(config.restoreMouseDelay, () => {
            restoreTimer = null
            try { hs.mouse.setAbsolutePosition(restoreTo.x, restoreTo.y) } catch (e) { /* leave it */ }
        })
    }
    return true
}

/**
 * Press after whatever is showing has had time to close.
 *
 * A menu bar menu is dismissed by anything else taking focus, and a chooser or a menu is
 * still holding it when a choice is made. Pressing immediately opens the menu and the
 * dismissal then closes it again, which looks like the menu appearing and vanishing.
 *
 * The timer is held in a variable: an hs.timer with nothing referring to it can be
 * collected before it fires.
 */
function pressWhenClear(element, ownsIt) {
    pressTimer = hs.timer.doAfter(config.pressDelay, () => {
        pressTimer = null
        pressElement(element, ownsIt)
    })
    return true
}

/**
 * Press an extra by name, scanning for it now.
 *
 * The element found by an earlier scan is not kept: an application can replace its menu bar
 * item at any time, and pressing a stale element does nothing.
 */
function press(name) {
    const item = extras().find((e) => e.name === name || e.alias === name)
    if (item) return pressWhenClear(item.element, item.own)

    // A menu entry, which performs its own action rather than opening anything.
    const entry = entries().find((e) => e.name === name)
    if (entry) return pressWhenClear(entry.element, false)

    hs.ui.alert(`No menu bar extra named ${name}`).duration(2).show()
    return false
}

// MARK: - The chooser
//
// This Spoon's own, holding only menu bar extras. Both the icons and the names are here
// rather than in the command chooser, so nothing that has quit can be offered and nothing
// is scanned until it is asked for.

/**
 * Pick something from the menu bar and invoke it.
 *
 * @param {boolean} [deep] Offer the entries inside each menu as well as the items. Reading
 *        every menu of every item takes far longer than listing the items — around three
 *        seconds against a tenth of one on this machine — so it is asked for rather than
 *        assumed. Items whose menu is only built when opened are offered on their own
 *        either way.
 */
function choose(deep) {
    const items = extras()
    if (!items.length) {
        hs.ui.alert("No menu bar extras found").duration(2).show()
        return false
    }

    // Items first, then what is inside them. An item whose menu could not be read is still
    // offered on its own: opening it is all that can be done until it has been opened.
    const rows = items.map((item) => ({ kind: "item", item: item }))
    if (deep === true) {
        for (const entry of entries()) rows.push({ kind: "entry", entry: entry })
    }

    const icons = new Map()
    const iconFor = (bundleID) => {
        if (!bundleID) return null
        if (!icons.has(bundleID)) icons.set(bundleID, HSImage.fromAppBundle(bundleID))
        return icons.get(bundleID)
    }

    const chooser = hs.chooser.create()
    chooser.placeholder = deep === true ? "Menu bar, everything" : "Menu bar"
    chooser.searchSubText = true       // so the mb- names can be typed
    chooser.visibleRows = config.rowsToDisplay
    chooser.width = config.chooserWidth

    // setChoices() and onSelect, not a choices property and a callback: assigning those
    // two is accepted silently and leaves the chooser empty.
    chooser.setChoices(rows.map((row, at) => {
        if (row.kind === "item") {
            const item = row.item
            return {
                text: describe(item),
                subText: item.alias ? `${item.name}   ·   ${item.alias}` : item.name,
                image: iconFor(item.bundleID),
                index: at
            }
        }
        return {
            text: describeEntry(row.entry),
            subText: row.entry.name,
            image: iconFor(row.entry.bundleID),
            index: at
        }
    }))

    // Pressed after the chooser has gone, not from onSelect. hs.chooser orders its panel out
    // before calling back, but focus has not returned to whatever was in front by then, and
    // a menu opened before it does is dismissed as soon as it arrives. See pressWhenClear().
    chooser.onSelect = (chosen) => {
        if (!chosen || chosen.index === undefined) return
        const row = rows[chosen.index]
        if (!row) return

        // An item opens a menu, so it goes through the same path as before: pressed, or
        // clicked when it is one of Hammerspoon's own. An entry performs its own action and
        // opens nothing, so it is pressed whoever owns it.
        if (row.kind === "item") pressWhenClear(row.item.element, row.item.own)
        else pressWhenClear(row.entry.element, false)
    }

    chooser.show()
    return true
}

// MARK: - The menu
//
// Returned as buttons for hs_menu-gt. Built when asked, so it lists what is in the menu bar
// at that moment. One icon per application, drawn from its bundle.

function menu() {
    return extras().map((entry) => ({
        label: describe(entry),
        imageProvider: () => ({
            icon: entry.bundleID ? "bundle:" + entry.bundleID : "symbol:menubar.rectangle"
        }),
        // Deferred for the same reason as the chooser: the menu that offered this button is
        // still on screen and holding focus.
        fn: () => pressWhenClear(entry.element, entry.own)
    }))
}

// MARK: - Listing

/** Every extra and the names it answers to, for reading in the console. */
function list(deep) {
    const rows = extras().map((item) => {
        const names = item.alias ? `${item.name}, ${item.alias}` : item.name
        return `${describe(item).padEnd(40)} ${names}`
    })
    if (deep === true) {
        for (const entry of entries()) {
            rows.push(`  ${describeEntry(entry).padEnd(38)} ${entry.name}`)
        }
    }
    return rows
}

// MARK: - Starting and stopping
//
// Nothing to start: there is no watcher, no cache and no command defined per extra.

function start() {
    return module.exports
}

function stop() {
    return module.exports
}

module.exports = {
    config,

    extras,
    entries,
    list,
    choose,
    menu,
    press,

    start,
    stop,

    author: "Daniel M German",
    description: "Reach the macOS menu bar extras from the keyboard",
    version: "1.0"
}
