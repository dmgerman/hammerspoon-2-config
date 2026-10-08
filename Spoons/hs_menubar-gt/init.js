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
    // Hammerspoon's own items are listed too, and are reached through what their Spoon
    // registered with hs.menubar rather than through accessibility or the screen. See
    // instrument().
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

    // How much of a screen's width the notch covers, as a fraction. Used to work out which
    // items cannot be seen; see notchBandOf(), which explains why this is a guess and why
    // the guess is deliberately a wide one.
    notchFraction: 0.13,

    // The strip that shows the items which cannot be seen. See peek().
    peekSeconds: 4,          // how long it stays up; 0 to leave it until something hides it
    peekHeight: 34,
    peekOffset: 6,           // between the bottom of the menu bar and the top of the strip
    peekTextSize: 14,
    peekIconSize: 20,
    peekGap: 12,             // between one item and the next
    peekMargin: 8,           // between the strip and the right edge of the screen
    peekPadding: 12,         // between the strip's edge and the first and last item
    // The strip's background is translucent so that it takes on whatever is behind it, which
    // is what the menu bar itself does. Sampling the menu bar and copying the colour was the
    // alternative and is worse: the menu bar is not one colour — measured across this screen
    // it ran from #4F8CBC to #89B1D0, because it is translucent over the desktop picture — so
    // any single colour copied from it is right in one place and wrong everywhere else, and
    // it would go stale whenever the wallpaper or the window underneath changed.
    //
    // Only the background carries this alpha. The titles and icons are drawn over it at full
    // opacity, so they stay legible whatever is behind.
    peekBackground: { red: 0, green: 0, blue: 0, alpha: 0.45 },
    peekBorder: { red: 1, green: 1, blue: 1, alpha: 0.25 },
    peekForeground: { red: 1, green: 1, blue: 1, alpha: 1 },

    // Report how long a scan took.
    logTimings: false
}

// Held so it cannot be collected before it fires; see invokeEntryWhenClear().
let pressTimer = null

// The chooser, held so it cannot be collected while it is on screen. See choose().
let chooser = null

// The strip, and the timer that takes it away again. See peek().
let peekCanvas = null
let peekTimer = null

// Whether an application declares an icon of its own, by bundle path. Read from its
// Info.plist once; a bundle does not grow an icon while it is running. See applicationIcon().
const iconDeclared = new Map()

// A menu bar taller than this means the screen has a notch. An ordinary one is 24pt; a
// notched one here is 39pt.
const NOTCHLESS_MENU_BAR = 30

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
                // Where the application is, for reading its Info.plist. See applicationIcon().
                bundlePath: application.bundlePath || null,
                // Reached through the registry rather than accessibility; see instrument().
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
        // Hammerspoon's own are read from what their Spoon registered rather than through
        // accessibility. That covers the menus which are only built when opened, and what it
        // yields is invoked by calling a function, so nothing need be on screen.
        const record = item.own ? recordForExtra(item) : null
        const inside = record ? ownMenuEntries(record) : menuEntries(item.element)

        for (const entry of inside) {
            const tail = entry.path.map(slug).filter((part) => part !== "").join("-")
            if (tail === "") continue
            found.push({
                application: item.application,
                bundleID: item.bundleID,
                own: item.own,
                item: item,
                element: entry.element || null,
                fn: entry.fn || null,
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

// MARK: - Hammerspoon's own items
//
// Everyone else's items are pressed through accessibility, which does not care where they
// are. Hammerspoon's own cannot be: the call is delivered to the main thread, which is the
// thread already running the JavaScript that made it, and opening a menu there enters a
// nested modal run loop that never returns.
//
// Clicking where the item is was the way around that, and it only works while the item is
// somewhere clickable. On a MacBook with a notch that is often nowhere. Measured here: of
// thirty items, six were parked off screen by a menu bar manager, two sat under the notch
// and four behind the window title, and two more crossed the notch and back as Control
// Center's microphone indicator came and went. Thirteen of thirty had no pixel to click.
//
// So Hammerspoon's own items are not reached through the screen at all. hs.menubar is
// wrapped, and whatever each Spoon passes to its items is kept here. Choosing one of these
// entries calls the function that Spoon supplied, directly. No menu opens, nothing is
// pressed, and where the item sits never comes into it.
//
// This also reaches menus accessibility cannot read. An item given a function rather than
// an array builds its menu only when opened, so it has no AXMenu until then and reads as
// empty; two items here were empty for that reason. The function is held here and is simply
// called.
//
// instrument() must run before the Spoons that create items do, which is why this Spoon is
// loaded first in init.js.

// One record per item that still exists.
const ownRecords = []
let instrumented = false

/** The record for an item, made if this is the first time it has been seen. */
function recordFor(item) {
    for (const record of ownRecords) {
        if (record.item === item) return record
    }
    const record = { item: item, spec: null, click: null }
    ownRecords.push(record)
    return record
}

/**
 * Wrap hs.menubar so that what each Spoon gives its items is kept.
 *
 * The prototype is patched rather than each item, so an item is covered however it was made
 * and whenever. Safe to call twice; the second call does nothing.
 */
function instrument() {
    if (instrumented) return false

    let proto = null
    try {
        // Made only to reach the prototype every item shares, and destroyed at once.
        const sample = hs.menubar.create(true)
        proto = Object.getPrototypeOf(sample)
        sample.destroy()
    } catch (e) {
        log(`could not instrument hs.menubar: ${e}`)
        return false
    }
    if (!proto || typeof proto.setMenu !== "function") {
        log("hs.menubar items do not have the methods this Spoon expects")
        return false
    }

    const setMenu = proto.setMenu
    proto.setMenu = function (menuOrFn) {
        recordFor(this).spec = menuOrFn
        return setMenu.call(this, menuOrFn)
    }

    const setClickCallback = proto.setClickCallback
    proto.setClickCallback = function (fn) {
        recordFor(this).click = fn
        return setClickCallback.call(this, fn)
    }

    // So a destroyed item stops being offered. A Spoon that reloads makes new items, and the
    // records for the old ones would otherwise pile up and name entries that do nothing.
    const destroy = proto.destroy
    proto.destroy = function () {
        for (let at = ownRecords.length - 1; at >= 0; at -= 1) {
            if (ownRecords[at].item === this) ownRecords.splice(at, 1)
        }
        return destroy.call(this)
    }

    instrumented = true
    return true
}

/** What a recorded item is showing now, or "". */
function titleOfRecord(record) {
    try {
        const title = record.item.title
        return title === null || title === undefined ? "" : String(title).trim()
    } catch (e) {
        return ""
    }
}

/**
 * The record behind one of Hammerspoon's own extras, matched by what it is showing.
 *
 * Nothing is shared between an HSMenuBarItem and the accessibility element standing for it,
 * so the title is the only link. Both are read in the same moment, so even a title that
 * changes constantly — one of these is a network reading — still matches. A title held by
 * two items at once matches neither, and those fall back to being read through
 * accessibility.
 */
function recordForExtra(item) {
    if (!instrumented) return null
    const label = item.label || ""
    let found = null
    for (const record of ownRecords) {
        if (titleOfRecord(record) !== label) continue
        if (found) return null
        found = record
    }
    return found
}

/**
 * The entries of one of Hammerspoon's own items, as the Spoon that made it described them.
 *
 * An item given an array has those entries. An item given a function builds its menu when it
 * opens, so the function is called here to find out what it would build.
 */
function ownMenuEntries(record, depth) {
    let spec = record.spec
    if (typeof spec === "function") {
        try {
            spec = spec()
        } catch (e) {
            log(`a menu function failed: ${e}`)
            return []
        }
    }
    if (!Array.isArray(spec)) return []

    const collect = (list, above, left) => {
        const found = []
        for (const row of list) {
            if (!row) continue

            let title = ""
            try {
                title = String(row.title === undefined ? "" : row.title).trim()
            } catch (e) {
                continue
            }
            // The two titles hs.menubar reads as a separator rather than an entry.
            if (title === "" || title === "-" || title === "---") continue

            const here = above.concat([title])

            // A submenu is followed rather than offered, as with the accessibility walk.
            if (Array.isArray(row.menu)) {
                if (left > 0) found.push(...collect(row.menu, here, left - 1))
                continue
            }

            if (typeof row.fn === "function" && row.disabled !== true) {
                found.push({ fn: row.fn, path: here })
            }
        }
        return found
    }

    return collect(spec, [], depth === undefined ? config.menuDepth : depth)
}

// MARK: - Pressing

/**
 * Press an extra, opening its menu.
 *
 * Hammerspoon's own are handled apart; see pressOwnExtra().
 */
function pressItem(item) {
    if (!item || !item.element) return false
    if (item.own) return pressOwnExtra(item)

    try {
        item.element.performAction("AXPress")
        return true
    } catch (e) {
        log(`could not press ${item.name}: ${e}`)
        return false
    }
}

/**
 * Press one of Hammerspoon's own extras.
 *
 * An item given a click callback rather than a menu does its whole job in that callback, so
 * it is called and nothing has to be on screen.
 *
 * An item with a menu cannot have that menu opened: showing it is the action, and the only
 * thing that could do it is a click. So the entries inside are offered instead, which is the
 * same set of actions the menu would have shown.
 *
 * They are offered whether or not the item happens to be on screen. Clicking it when it is
 * visible would work, but then what this does would depend on where the notch had pushed the
 * item that minute, which is the thing this Spoon exists to stop mattering.
 */
function pressOwnExtra(item) {
    const record = recordForExtra(item)
    if (record && !record.spec && typeof record.click === "function") {
        try {
            record.click()
            return true
        } catch (e) {
            log(`${item.name} failed: ${e}`)
            return false
        }
    }

    return chooseWithin(item)
}

/** The entries inside one item, from the registry when there is one and the menu when not. */
function entriesWithin(item) {
    const record = item.own ? recordForExtra(item) : null
    return record ? ownMenuEntries(record) : menuEntries(item.element)
}

/**
 * Offer what is inside one item, for when its menu cannot be opened.
 *
 * The menu would have shown these same entries, and each performs its action without
 * anything being on screen, so this reaches everything the menu would have.
 */
function chooseWithin(item) {
    const inside = entriesWithin(item)
    if (!inside.length) {
        log(`${item.name} is not on screen and nothing inside it could be read`)
        hs.ui.alert(`${describe(item)} is not reachable`).duration(2).show()
        return false
    }

    // The module's chooser, not a local one; see choose() for why it is held there.
    chooser = hs.chooser.create()
    chooser.placeholder = describe(item)
    chooser.visibleRows = config.rowsToDisplay
    chooser.width = config.chooserWidth
    chooser.setChoices(inside.map((entry, at) => ({
        text: entry.path.join("  ▸  "),
        subText: describe(item),
        index: at
    })))

    chooser.onSelect = (chosen) => {
        if (!chosen || chosen.index === undefined) return
        const entry = inside[chosen.index]
        if (!entry) return
        invokeEntryWhenClear({
            fn: entry.fn || null,
            element: entry.element || null,
            name: item.name
        })
    }

    chooser.show()
    return true
}

/**
 * Invoke a menu entry, which performs its action without opening anything.
 *
 * One of Hammerspoon's own calls the function its Spoon supplied. Everyone else's is pressed
 * through accessibility.
 */
function invokeEntry(entry) {
    if (!entry) return false

    if (typeof entry.fn === "function") {
        try {
            entry.fn()
            return true
        } catch (e) {
            log(`${entry.name} failed: ${e}`)
            return false
        }
    }

    if (!entry.element) return false
    try {
        entry.element.performAction("AXPress")
        return true
    } catch (e) {
        log(`could not invoke ${entry.name}: ${e}`)
        return false
    }
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
function invokeEntryWhenClear(entry) {
    pressTimer = hs.timer.doAfter(config.pressDelay, () => {
        pressTimer = null
        invokeEntry(entry)
    })
    return true
}

/**
 * Find something by name and press it, scanning now.
 *
 * @param {string} name An item's name or alias, or a menu entry's name.
 * @param {boolean} [itemsOnly] Look only at the items. Reading every menu to find an entry
 *        costs seconds, and a caller that knows it named an item should not pay that to
 *        discover the item has gone.
 */
function pressNamed(name, itemsOnly) {
    const item = extras().find((e) => e.name === name || e.alias === name)
    if (item) return pressItem(item)

    // A menu entry, which performs its own action rather than opening anything.
    if (itemsOnly !== true) {
        const entry = entries().find((e) => e.name === name)
        if (entry) return invokeEntry(entry)
    }

    log(`${name} was not in the menu bar when the time came to press it`)
    hs.ui.alert(`No menu bar extra named ${name}`).duration(2).show()
    return false
}

/**
 * Press by name once whatever is showing has had time to close.
 *
 * The scan happens inside the timer rather than before it, so what is pressed is what is in
 * the menu bar at the moment of the press rather than a fifth of a second earlier. See
 * choose() for why that difference matters.
 */
function pressNamedWhenClear(name, itemsOnly) {
    pressTimer = hs.timer.doAfter(config.pressDelay, () => {
        pressTimer = null
        pressNamed(name, itemsOnly)
    })
    return true
}

/**
 * Press an extra by name.
 *
 * Nothing from an earlier scan is kept: an application can replace its menu bar item at any
 * time, and the items slide about as their neighbours change width.
 */
function press(name) {
    return pressNamedWhenClear(name, false)
}

// MARK: - Right-clicking
//
// Some extras answer a right click with a second, different menu; Caffeine is one. There is no
// accessibility action for that. Every extra in this menu bar advertises AXPress and nothing
// else bar the occasional AXCancel, and AXPress carries neither a button nor modifier flags.
// So the only way to deliver a right click is to post one at the item, which requires the item
// to be what is drawn at its own position.
//
// For the items the strip shows, it is not. An item left of the notch is drawn beneath the
// frontmost application's own menus, and accessibility hit-tests its centre to that
// application's AXMenuBar rather than to the item: measured here, Caffeine at 948,7.5 hit pid
// 1294's menu bar at 0,0 1800x39. A click posted there goes to the menu bar instead.
//
// Hammerspoon 1 could address an event to one application, with CGEventPostToPSN
// (extensions/eventtap/libeventtap_event.m:685). Hammerspoon 2's hs.eventtap posts only to
// .cghidEventTap (HSEventTapModule.swift:785), so that route does not exist from JavaScript.
// See ai/issue_unfiled_eventtap-post-to-application.md.
//
// The click is the only thing that cannot be delivered, though. The menu itself is readable:
// Caffeine's item has one AXMenu child holding About Caffeine, Preferences…, Activate for and
// Quit, each advertising AXPress, and AXPress does not care where the item is drawn. So where
// the click cannot be posted, the entries inside are offered instead and the chosen one is
// pressed — which is what chooseWithin() already does for Hammerspoon's own items, and for the
// same reason.
//
// Which menu that is depends on the application. An item whose two menus differ exposes only
// one of them to accessibility, and there is no way to ask which. So this reaches the entries
// of the menu the item exposes, not necessarily the ones its right click would have shown.

/** An item's frame as accessibility reports it, or null. */
function frameOf(item) {
    try {
        const frame = item.element.attributeValue("AXFrame")
        if (!frame) return null
        return { x: frame.x, y: frame.y, w: frame.w, h: frame.h }
    } catch (e) {
        return null
    }
}

/**
 * Whether a click posted at a frame's centre would reach the element that frame belongs to.
 *
 * Asked of accessibility rather than worked out from the geometry: what the hit test answers
 * with is what the click will reach, and the item is reachable only when that answer is the
 * item itself. Compared by frame, which is the one thing both elements report.
 */
function isWhereItIsDrawn(frame) {
    if (!frame || frame.w <= 0 || frame.h <= 0) return false
    try {
        const at = new HSPoint(frame.x + frame.w / 2, frame.y + frame.h / 2)
        const hit = hs.ax.elementAtPoint(at)
        if (!hit) return false
        const there = hit.attributeValue("AXFrame")
        if (!there) return false
        return there.x === frame.x && there.y === frame.y &&
            there.w === frame.w && there.h === frame.h
    } catch (e) {
        return false
    }
}

/**
 * Right-click an extra, so that it shows whatever it shows for a secondary click.
 *
 * An item that is where it is drawn gets a real right click, which is exactly what a right
 * click in the menu bar would have been. Every other item — which is every item the strip
 * shows — has the entries inside it offered instead.
 *
 * Hammerspoon's own go straight to the entries: hs.menubar calls a click callback with no
 * arguments (HSMenuBarItem.swift:166), so a Spoon's item has no secondary click of its own,
 * and pressOwnExtra() already offers what it has.
 */
function itemSecondaryPress(item) {
    if (!item || !item.element) return false
    if (item.own) return pressOwnExtra(item)

    const frame = frameOf(item)
    if (isWhereItIsDrawn(frame)) {
        try {
            hs.eventtap.rightClick(frame.x + frame.w / 2, frame.y + frame.h / 2)
            return true
        } catch (e) {
            log(`could not right-click ${item.name}: ${e}`)
            return false
        }
    }

    const at = frame ? `${Math.round(frame.x)},${Math.round(frame.y)}` : "its position"
    log(`${item.name} is not what is drawn at ${at}, so its entries are offered instead`)
    return chooseWithin(item)
}

/** Find an item by name and right-click it, scanning now. */
function namedSecondaryPress(name) {
    const item = extras().find((e) => e.name === name || e.alias === name)
    if (item) return itemSecondaryPress(item)

    log(`${name} was not in the menu bar when the time came to right-click it`)
    hs.ui.alert(`No menu bar extra named ${name}`).duration(2).show()
    return false
}

/**
 * Right-click by name once whatever is showing has had time to close.
 *
 * Same reasoning as pressNamedWhenClear(), and the same timer: only one press is ever in
 * flight, and the scan happens inside the timer so the position used is the current one.
 */
function namedSecondaryPressWhenClear(name) {
    pressTimer = hs.timer.doAfter(config.pressDelay, () => {
        pressTimer = null
        namedSecondaryPress(name)
    })
    return true
}

/** Right-click an extra by name. */
function secondaryPress(name) {
    return namedSecondaryPressWhenClear(name)
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
 * @param {boolean} [secondary] Right-click what is chosen rather than pressing it; see
 *        itemSecondaryPress(). Only the items are offered: an entry inside a menu has one
 *        action and no second one, so there is nothing for a right click to mean.
 */
function choose(deep, secondary) {
    const items = extras()
    if (!items.length) {
        hs.ui.alert("No menu bar extras found").duration(2).show()
        return false
    }

    // Items first, then what is inside them. An item whose menu could not be read is still
    // offered on its own: opening it is all that can be done until it has been opened.
    const rows = items.map((item) => ({ kind: "item", item: item }))
    if (deep === true && secondary !== true) {
        for (const entry of entries()) rows.push({ kind: "entry", entry: entry })
    }

    const icons = new Map()
    const iconFor = (bundleID) => {
        if (!bundleID) return null
        if (!icons.has(bundleID)) icons.set(bundleID, HSImage.fromAppBundle(bundleID))
        return icons.get(bundleID)
    }

    // Held in a module variable rather than only in this function. A chooser referred to by
    // nothing is collected while it is still on screen — HSChooser's deinit takes the window
    // with it — and the chooser then disappears with nobody having touched it. Every other
    // Spoon here that opens one holds it this way: the clipboard, the window switcher, kitty,
    // and hs_interactive-gt for the command chooser itself. See ai/chooser-collected.md.
    chooser = hs.chooser.create()
    chooser.placeholder = secondary === true ? "Menu bar, right click"
        : deep === true ? "Menu bar, everything" : "Menu bar"
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
    // a menu opened before it does is dismissed as soon as it arrives. See invokeEntryWhenClear().
    chooser.onSelect = (chosen) => {
        if (!chosen || chosen.index === undefined) return
        const row = rows[chosen.index]
        if (!row) return

        // An item is found again by name when the time comes to press it, rather than kept
        // from the scan that built this chooser. The items slide about: sampled every five
        // seconds for two minutes, seventeen of thirty moved 55pt each time Control Center's
        // microphone indicator appeared or went away. That is wider than most items are, so
        // a click aimed at where an item used to be lands on its neighbour and opens the
        // wrong menu. Two items crossed the notch in the same two minutes, and were
        // therefore clickable only part of the time. The item may also have been replaced
        // altogether, leaving an element that presses do nothing to.
        //
        // An entry is kept as it was found. It is pressed through accessibility rather than
        // clicked, so where it is does not matter, and its name is not stable enough to find
        // it again: the countdown's entry is `-start-25-min` until it is running and `-stop`
        // afterwards.
        if (row.kind !== "item") return invokeEntryWhenClear(row.entry)
        if (secondary === true) return namedSecondaryPressWhenClear(row.item.name)
        pressNamedWhenClear(row.item.name, true)
    }

    chooser.show()
    return true
}

/**
 * Pick something from the menu bar and right-click it.
 *
 * The chooser cannot tell a secondary selection from an ordinary one — hs.chooser's onSelect
 * is given the chosen row and nothing else, no button and no modifier flags — so this is a
 * second way in rather than a modifier on the first.
 */
function secondaryChoose() {
    return choose(false, true)
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
        // Deferred for the same reason as the chooser, and found again by name for the same
        // reason: this button may have been built minutes ago, and the items will have moved
        // since. See choose().
        fn: () => pressNamedWhenClear(entry.name, true)
    }))
}

// MARK: - What cannot be seen
//
// The menu bar holds more than there is room for, and macOS does not drop what does not fit.
// It puts it somewhere useless instead: under the notch, left of the notch among the
// application's own menus, or — when a menu bar manager such as Ice is running — thousands of
// points off the side of the screen. Those items are still in the menu bar, still listed by
// extras() and still pressable through everything above. They just cannot be seen or
// pointed at.
//
// peek() draws them, briefly, below the menu bar.

/** A screen's menu bar height, in points. */
function menuBarHeightOf(screen) {
    try {
        const full = screen.fullFrame
        const frame = screen.frame
        if (!full || !frame) return 0
        return frame.y - full.y
    } catch (e) {
        return 0
    }
}

/**
 * The band of a screen that the notch covers, or null when there is no notch.
 *
 * Hammerspoon 2 does not expose NSScreen's safe area, so this is worked out rather than read.
 * A menu bar taller than an ordinary one means a notch, and the notch is centred and about an
 * eighth of the width: measured here, 220pt of 1800, which is 12.2%.
 *
 * config.notchFraction is wider than that on purpose. Guessing wide puts an item in the strip
 * that could have been seen anyway; guessing narrow leaves one out of the strip that cannot
 * be seen at all, which is the one thing the strip exists to prevent.
 */
function notchBandOf(screen) {
    if (menuBarHeightOf(screen) <= NOTCHLESS_MENU_BAR) return null

    let full = null
    try { full = screen.fullFrame } catch (e) { return null }
    if (!full) return null

    const width = full.w * config.notchFraction
    const middle = full.x + full.w / 2
    return { left: middle - width / 2, right: middle + width / 2 }
}

/** The screen a point is on, or null when it is on none of them. */
function screenAt(point) {
    let screens = []
    try { screens = hs.screen.all() || [] } catch (e) { return null }

    for (const screen of screens) {
        let frame = null
        try { frame = screen.fullFrame } catch (e) { continue }
        if (!frame) continue
        if (point.x >= frame.x && point.x < frame.x + frame.w &&
            point.y >= frame.y && point.y < frame.y + frame.h) {
            return screen
        }
    }
    return null
}

/**
 * Whether an item is somewhere it can actually be seen.
 *
 * Two ways to fail. An item parked off every screen is nowhere at all. An item left of the
 * notch is in the half of the menu bar the application's own menus occupy, and is drawn
 * beneath them — whether it is under the notch itself or further left again makes no
 * difference to whether it can be seen.
 */
function isOnShow(item) {
    let position = null
    let size = null
    try {
        position = item.element.position
        size = item.element.size
    } catch (e) {
        return false
    }
    if (!position || !size) return false

    const screen = screenAt({ x: position.x + size.w / 2, y: position.y + size.h / 2 })
    if (!screen) return false

    const band = notchBandOf(screen)
    if (band && position.x < band.right) return false

    return true
}

/** Every item that is in the menu bar but cannot be seen there, in menu bar order. */
function hidden() {
    const found = extras().filter((item) => !isOnShow(item))
    found.sort((one, other) => {
        let a = 0
        let b = 0
        try { a = one.element.position.x } catch (e) { a = 0 }
        try { b = other.element.position.x } catch (e) { b = 0 }
        return a - b
    })
    return found
}

// MARK: - The strip

/**
 * How wide each item should be drawn.
 *
 * An item's width in the menu bar is no guide once its title is being drawn in place of its
 * glyph. AirDrop's item is 18pt wide because what it draws there is an icon, while the word
 * "AirDrop" at this size is three times that, and laying it out at 18pt clips it to "Air".
 *
 * So a title is measured, and only an item without one falls back to the width it occupies in
 * the menu bar. Measuring needs a canvas, because minimumTextSize takes the font from an
 * element rather than from its arguments; the one made here is never shown.
 */
/**
 * A name for an item that has no title, taken from its own menu.
 *
 * The application's name is not always a useful answer. SystemUIServer hosts several of the
 * system's menu extras at once, so naming one after the process that owns it makes Time
 * Machine and the VPN both "SystemUIServer". The VPN at least says what it is in
 * AXDescription; Time Machine reports no title, description, value or help at all.
 *
 * Its menu does say. A macOS menu extra almost always carries an entry naming itself — "Open
 * Time Machine Settings…", "Wi-Fi Settings…", "Bluetooth Settings…" — so that entry is where
 * the name comes from. Only the top level is read, which is one cheap menu rather than the
 * whole tree, and only for an item that has nothing better to offer.
 */
function menuName(item) {
    let inside = []
    try {
        inside = menuEntries(item.element, 0)
    } catch (e) {
        return ""
    }

    for (const entry of inside) {
        const title = entry.path[entry.path.length - 1] || ""
        const named = /^(?:Open\s+)?(.+?)\s+Settings…?$/.exec(title)
        if (named) return named[1]
    }
    return ""
}

/**
 * What to draw for an item as text, or "" when it should be drawn as an icon.
 *
 * Its own title where it has one, then its application's icon, then whatever its menu calls
 * it, and failing all of those the application's name. See applicationIcon() for why some
 * applications have no icon to show, and menuName() for why their name is not always enough.
 */
function peekTextOf(item) {
    if (item.label) return item.label
    if (applicationIcon(item)) return ""
    return menuName(item) || item.application || item.name
}

function peekSizesFor(items) {
    let probe = null
    try {
        probe = hs.canvas.create({ x: 0, y: 0, w: 10, h: config.peekHeight })
        probe.replaceElements([{
            type: "text",
            text: "",
            textSize: config.peekTextSize,
            frame: { x: 0, y: 0, w: 10, h: config.peekHeight }
        }])
    } catch (e) {
        probe = null
    }

    const sizes = items.map((item) => {
        const text = peekTextOf(item)
        if (text && probe) {
            try {
                const size = probe.minimumTextSize(0, text)
                if (size && size.w > 0) {
                    return { w: Math.ceil(size.w) + 4, h: Math.ceil(size.h) }
                }
            } catch (e) { /* fall through to the menu bar width */ }
        }
        try {
            const size = item.element.size
            if (size && size.w > 0) return { w: size.w, h: config.peekIconSize }
        } catch (e) { /* fall through */ }
        return { w: config.peekIconSize * 2, h: config.peekIconSize }
    })

    if (probe) {
        try { probe.destroy() } catch (e) { /* nothing to do */ }
    }
    return sizes
}

/**
 * An application's own icon, or null when it has none.
 *
 * HSImage.fromAppBundle() does not answer this. It looks the bundle up, and if it finds one it
 * returns NSWorkspace's icon for it — which, for a bundle that declares no icon, is the
 * generic grey placeholder rather than nothing. Its fallback symbol is no help either: that
 * only applies when the bundle id cannot be resolved at all, and these resolve fine.
 *
 * Two of the applications here are in that position. Fleet Desktop lives outside
 * /Applications, at /opt/orbit/bin/desktop/macos/stable, and has no Resources directory at
 * all; SystemUIServer is a faceless system agent. Both came back as the same placeholder,
 * which says nothing about which item it is and is worse than no icon, because it looks like
 * an icon.
 *
 * So the bundle is asked whether it declares one before its icon is used.
 */
function applicationIcon(item) {
    if (!item.bundleID || !item.bundlePath) return null

    if (!iconDeclared.has(item.bundlePath)) {
        let declared = false
        try {
            const path = item.bundlePath.replace(/\/+$/, "") + "/Contents/Info.plist"
            const info = hs.plist.fromFile(path)
            declared = !!(info && (info.CFBundleIconFile || info.CFBundleIconName))
        } catch (e) {
            declared = false
        }
        iconDeclared.set(item.bundlePath, declared)
    }

    if (!iconDeclared.get(item.bundlePath)) return null
    try {
        return HSImage.fromAppBundle(item.bundleID)
    } catch (e) {
        return null
    }
}

/** Take the strip away. */
function peekHide() {
    if (peekTimer) {
        try { peekTimer.stop() } catch (e) { /* it may already have fired */ }
        peekTimer = null
    }
    if (peekCanvas) {
        try { peekCanvas.destroy() } catch (e) { /* it may already have gone */ }
        peekCanvas = null
    }
    return true
}

/**
 * Show the items that cannot be seen, in a strip below the menu bar, aligned right.
 *
 * Each is drawn as its own title where it has one and as its application's icon where it does
 * not. A title is what most of these actually show — a countdown, a bandwidth reading, an
 * emoji — so for them the strip is exactly what the menu bar would have shown. An item with
 * no title cannot be reproduced: there is no way to read the glyph an application draws into
 * its own menu bar item, so its application's icon stands in.
 *
 * Clicking one does what choosing it from the chooser does.
 */
function peek() {
    peekHide()

    const items = hidden()
    if (!items.length) {
        hs.ui.alert("Every menu bar item is visible").duration(2).show()
        return false
    }

    let screen = null
    try { screen = hs.screen.all()[0] } catch (e) { screen = null }
    if (!screen) return false

    let full = null
    try { full = screen.fullFrame } catch (e) { return false }
    if (!full) return false

    const sizes = peekSizesFor(items)
    const inside = sizes.reduce((sum, each) => sum + each.w, 0) +
        config.peekGap * (items.length - 1)
    const stripWidth = inside + config.peekPadding * 2

    // hs.canvas works in unflipped AppKit coordinates: y counts up from the bottom of the
    // screen, where accessibility and hs.screen both count down from the top. So the strip's
    // y is its bottom edge, and sitting it directly under the menu bar means measuring the
    // menu bar down from the top of the screen and the strip's own height down from there.
    const under = full.y + full.h - menuBarHeightOf(screen)

    const canvas = hs.canvas.create({
        x: full.x + full.w - stripWidth - config.peekMargin,
        y: under - config.peekHeight - config.peekOffset,
        w: stripWidth,
        h: config.peekHeight
    })

    // An outline, because a translucent panel over a busy window has no edge of its own.
    const elements = [{
        type: "rectangle",
        frame: { x: 0.5, y: 0.5, w: stripWidth - 1, h: config.peekHeight - 1 },
        fillColor: config.peekBackground,
        strokeColor: config.peekBorder,
        strokeWidth: 1,
        roundedRectRadii: { xRadius: 7, yRadius: 7 },
        id: "_background"
    }]

    // Everything is centred on the strip's middle line. A title and an icon are different
    // heights, so each is placed by its own height rather than given the strip's full height:
    // text is drawn from the top of the frame it is given, so a full-height frame would sit
    // every title higher than the icons beside it.
    const middle = config.peekHeight / 2

    let at = config.peekPadding
    items.forEach((item, index) => {
        const width = sizes[index].w

        const text = peekTextOf(item)
        if (text) {
            const height = sizes[index].h
            elements.push({
                type: "text",
                text: text,
                textSize: config.peekTextSize,
                textColor: config.peekForeground,
                textAlignment: "center",
                frame: { x: at, y: middle - height / 2, w: width, h: height }
            })
        } else {
            // No title to reproduce, so the application it belongs to is the best that can be
            // shown. Centred in the same width the item has in the menu bar.
            const icon = config.peekIconSize
            elements.push({
                type: "image",
                image: applicationIcon(item),
                imageScaling: "scaleProportionally",
                frame: {
                    x: at + (width - icon) / 2,
                    y: middle - icon / 2,
                    w: icon,
                    h: icon
                }
            })
        }

        // The thing that is clicked, rather than the title or the icon itself. One target per
        // item, the full height of the strip and the full width of its slot, so that the
        // space around a short title or a small icon answers to the pointer as well.
        elements.push({
            type: "rectangle",
            frame: { x: at, y: 0, w: width, h: config.peekHeight },
            fillColor: { red: 0, green: 0, blue: 0, alpha: 0.01 },
            id: item.name,
            trackMouseDown: true,
            trackRightMouseDown: true
        })

        at += width + config.peekGap
    })

    canvas.replaceElements(elements)
    canvas.level("status")
    canvas.behaviorList(["canJoinAllSpaces", "stationary"])
    // So that clicking the strip does not bring Hammerspoon to the front; the point is to
    // reach a menu bar item, not to switch application.
    canvas.clickActivating(false)

    // A left click presses the item, which opens its menu. A right click asks for whatever the
    // item shows for a secondary click, and often cannot be delivered at all; see the comment
    // above itemSecondaryPress().
    canvas.mouseCallback((which, message, id, x, y) => {
        if (message !== "mouseDown" && message !== "rightMouseDown") return
        if (!id || id === "_canvas" || id === "_background") return
        peekHide()
        if (message === "rightMouseDown") return namedSecondaryPressWhenClear(id)
        pressNamedWhenClear(id, true)
    })

    canvas.show()
    peekCanvas = canvas

    if (config.peekSeconds > 0) {
        peekTimer = hs.timer.doAfter(config.peekSeconds, () => {
            peekTimer = null
            peekHide()
        })
    }
    return true
}

/** Show the strip, or take it away when it is already up. */
function peekToggle() {
    if (peekCanvas) return peekHide()
    return peek()
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
// No watcher, no cache and no command defined per extra. The one thing start() does is wrap
// hs.menubar, which has to happen before any other Spoon creates an item: a menu registered
// before the wrapping is in place is not recorded, and that item falls back to being read
// through accessibility. This Spoon is therefore loaded first in init.js.

function start() {
    instrument()
    return module.exports
}

function stop() {
    peekHide()
    return module.exports
}

module.exports = {
    config,

    extras,
    entries,
    hidden,
    list,
    choose,
    secondaryChoose,
    menu,
    press,
    secondaryPress,
    peek,
    peekHide,
    peekToggle,
    instrument,

    start,
    stop,

    author: "Daniel M German",
    description: "Reach the macOS menu bar extras from the keyboard",
    version: "1.0"
}
