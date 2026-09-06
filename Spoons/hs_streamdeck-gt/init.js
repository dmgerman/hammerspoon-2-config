// hs_streamdeck-gt — displays hs_menu-gt menus on Elgato Stream Deck hardware.
//
// This Spoon is a presenter and nothing else: the menus, their buttons and what a press
// does all belong to hs_menu-gt, and the same menu can be displayed on screen at the same
// time. What is added here is the hardware and the chrome the hardware needs — a back
// button, an on/off button, and a fixed grid to fit them into.
//
//     const deck = hs.loadSpoon("hs_streamdeck-gt")
//     deck.setMenu("A00NA33332Q8DH", busMenu, "Buses")   // a particular deck
//     deck.setMenu("large", mainMenu)                    // any deck with 15 or more keys
//     deck.setDefaultMenu(smallMenu)
//     deck.start()
//
// A menu is looked up by serial number, then by size, then by the default, as the
// Hammerspoon 1 Spoon did.

// MARK: - User-configurable settings

const config = {
    // Brightness as a percentage, by time of day. Applied when a deck is attached, when
    // it is switched back on, and whenever the hour crosses one of the boundaries below.
    brightnessDay: 60,
    brightnessNight: 25,
    // brightnessDay applies from dayStartHour up to, but not including, dayEndHour.
    dayStartHour: 8,
    dayEndHour: 18,
    // How often the time of day is checked, in seconds.
    brightnessCheckSeconds: 60,

    // Blank the deck after this many seconds with no press. Null or 0 never blanks it.
    // The deck comes back with its on/off key, as though it had been switched off by hand.
    autoOffSeconds: 1800,

    // Blank the deck while the screen is locked, and restore it on unlock. A locked
    // machine's Stream Deck would otherwise stay lit, and its buttons would still work.
    blankWhenLocked: true,
    // Also blank it while the screen sleeps or the screen saver runs.
    blankWhenScreensaverRuns: true,
    // Returns to the parent menu. Occupies the first key of a submenu only.
    backButton: {
        label: "Back",
        icon: "back.png",
        background: "#202020"
    },
    // Blanks the deck. Occupies the last key of every menu. Set to null for neither.
    toggleButton: {
        label: "Off",
        icon: "symbol:power",
        background: "#202020"
    },
    // Moves to the next page, wrapping at the last one. Occupies the key before the on/off
    // key, and only in a menu with more buttons than keys. Its label carries the page it
    // goes to, as "More 2/3". Set to null to truncate such a menu instead.
    pageButton: {
        label: "More",
        background: "#202020"
    },
    // Drawn on a key holding nothing.
    fillerColor: "#000000"
}

// MARK: - State

let menusBySerial = {}
let menusBySize = {}
let defaultMenu = null
let watcher = null
// Adjusts every deck as the time of day changes. Held, because a timer with no reference
// left is garbage collected before it fires.
let brightnessTimer = null
// Blanks the decks while the screen is locked. Held for the same reason.
let powerWatcher = null

// One record per attached deck: the device, its session, its layout and its state.
const decks = new Map()

function menu() {
    const spoon = hs.spoons["hs_menu-gt"]
    if (!spoon) throw new Error("hs_menu-gt is not loaded")
    return spoon
}

// MARK: - Brightness and idleness

/**
 * The brightness for the current time of day, as a percentage.
 *
 * @returns {number} `config.brightnessDay` between the day hours, otherwise
 *          `config.brightnessNight`.
 */
function brightnessNow() {
    const hour = new Date().getHours()
    const isDay = hour >= config.dayStartHour && hour < config.dayEndHour
    return isDay ? config.brightnessDay : config.brightnessNight
}

// The last value set is remembered so that the periodic check only reaches the hardware
// when the brightness actually changes, rather than once a minute for ever.
function applyBrightness(record) {
    if (!record.on) return

    const wanted = brightnessNow()
    if (record.brightness === wanted) return

    try {
        record.device.setBrightness(wanted)
        record.brightness = wanted
    } catch (e) {
        console.error(`[hs_streamdeck-gt] could not set brightness: ${e.message}`)
    }
}

// A deck blanked because the screen locked is remembered separately from one switched off
// by hand or by the idle timer, so that unlocking restores only what locking blanked.
function handlePowerEvent(event) {
    const blanking =
        (config.blankWhenLocked && event === "screensDidLock") ||
        (config.blankWhenScreensaverRuns &&
            (event === "screensDidSleep" || event === "screensaverDidStart"))

    const restoring =
        (config.blankWhenLocked && event === "screensDidUnlock") ||
        (config.blankWhenScreensaverRuns &&
            (event === "screensDidWake" || event === "screensaverDidStop"))

    if (!blanking && !restoring) return

    for (const record of decks.values()) {
        if (blanking) {
            // Nothing to do if it is already dark; and do not claim to have blanked it,
            // or unlocking would switch on a deck the user had switched off.
            if (!record.on) continue
            record.blankedBySystem = true
            setOn(record, false)
            continue
        }

        if (!record.blankedBySystem) continue
        record.blankedBySystem = false
        setOn(record, true)
    }
}

/** Restart the countdown to blanking the deck. Called at every press. */
function restartIdleTimer(record) {
    if (record.idleTimer) {
        record.idleTimer.stop()
        record.idleTimer = null
    }
    if (!config.autoOffSeconds) return

    record.idleTimer = hs.timer.doAfter(config.autoOffSeconds, () => {
        record.idleTimer = null
        if (record.on) setOn(record, false)
    })
}

// MARK: - Menu lookup

/**
 * Register the menu a deck displays.
 *
 * @param {string} key A serial number, or "large" for a deck of 15 keys or more, or
 *        "small" for a smaller one.
 * @param {object[]|function} buttons The menu.
 * @param {string} [name] Its title.
 */
function setMenu(key, buttons, name) {
    const record = { menu: buttons, name: name || key }
    if (key === "large" || key === "small") menusBySize[key] = record
    else menusBySerial[key] = record
    refreshAll()
    return module.exports
}

/** Register the menu for a deck with no menu of its own. */
function setDefaultMenu(buttons, name) {
    defaultMenu = { menu: buttons, name: name || "Menu" }
    refreshAll()
    return module.exports
}

function menuForDevice(device) {
    const bySerial = menusBySerial[device.serialNumber]
    if (bySerial) return bySerial

    const size = device.keyCount >= 15 ? "large" : "small"
    return menusBySize[size] || defaultMenu
}

// MARK: - The presenter
//
// The deck has a fixed number of keys, and the chrome takes some of them: a back button
// on the first key of a submenu, and the on/off button on the last. The menu's buttons
// fill what is left. `layout` maps each key of the device to what it holds, so a press
// can be turned back into a position within the menu.
//
// A menu with more buttons than there are keys for is displayed a page at a time, and one
// further key holds the page button. The session renders the whole menu once whatever the
// page, so every image it sends is kept and a page turn repaints from what was already
// drawn rather than asking for it again.

function deckPresenter(record) {
    const device = record.device

    // The menu being displayed, the images drawn for it so far by button index, and where
    // in it the displayed page starts. All three are replaced at every present().
    let buttons = []
    let images = new Map()
    let page = 0

    function paintKey(key, image) {
        try {
            device.setButtonImage(key, image)
        } catch (e) {
            console.error(`[hs_streamdeck-gt] could not paint key ${key}: ${e.message}`)
        }
    }

    function paintChrome(key, spec) {
        menu().buttonImage(spec).then((image) => {
            if (image) paintKey(key, image)
        })
    }

    /** The first key the menu's own buttons may use, after the back key. */
    function firstButtonKey(session) {
        return session.canPop() && config.backButton ? 2 : 1
    }

    /** One past the last key they may use: the on/off key, or the end of the deck. */
    function lastButtonKey() {
        return config.toggleButton ? device.keyCount : device.keyCount + 1
    }

    /**
     * How the menu divides into pages, for the keys this menu leaves free.
     *
     * `pageKey` is null when everything fits, or when paging is not possible — no page
     * button configured, or a deck with no key to spare for one.
     */
    function paging(session) {
        const capacity = lastButtonKey() - firstButtonKey(session)
        if (buttons.length <= capacity || !config.pageButton || capacity < 2) {
            return { perPage: capacity, pages: 1, pageKey: null }
        }

        const perPage = capacity - 1
        return {
            perPage: perPage,
            pages: Math.ceil(buttons.length / perPage),
            pageKey: lastButtonKey() - 1
        }
    }

    // Draws the current page and records what each key holds. Called when the menu is
    // presented and again at every page turn; the session is not involved in the latter.
    function paint(session) {
        const { perPage, pages, pageKey } = paging(session)
        if (page >= pages) page = 0

        const layout = new Array(device.keyCount + 1).fill(null)
        let key = 1

        if (session.canPop() && config.backButton) {
            layout[key] = { kind: "back" }
            paintChrome(key, config.backButton)
            key += 1
        }

        const lastKey = lastButtonKey()
        let index = page * perPage
        const end = Math.min(buttons.length, index + perPage)
        for (; key < lastKey && index < end; key++, index++) {
            layout[key] = { kind: "button", index: index }
            device.setButtonColor(key, HSColor.hex(buttons[index].background || "#101014"))
            // Drawn before this page was displayed, if the session has got that far; the
            // rest follow through setImage as they are drawn.
            const image = images.get(index)
            if (image) paintKey(key, image)
        }

        for (; key < lastKey; key++) {
            if (key === pageKey) continue
            layout[key] = null
            device.setButtonColor(key, HSColor.hex(config.fillerColor))
        }

        if (pageKey) {
            layout[pageKey] = { kind: "page" }
            // The label names the page the key goes to rather than the one displayed, so it
            // says what pressing it does.
            paintChrome(pageKey, {
                ...config.pageButton,
                label: `${config.pageButton.label} ${((page + 1) % pages) + 1}/${pages}`
            })
        } else if (buttons.length > perPage) {
            // Nowhere to put a page key, so say what is not displayed rather than drop it
            // silently.
            console.error(
                `[hs_streamdeck-gt] ${buttons.length - perPage} of ${buttons.length} ` +
                `buttons do not fit on ${device.deckType} and are not shown`
            )
        }

        if (config.toggleButton) {
            layout[device.keyCount] = { kind: "toggle" }
            paintChrome(device.keyCount, config.toggleButton)
        }

        record.layout = layout
    }

    return {
        // Keys are painted one at a time, so images may arrive after the layout does.
        progressive: true,

        // A deck is always displaying something, so it cannot hide and `keepOpen` does not
        // apply to it. Only `navigate` does.
        canHide: false,

        present: function (session, list) {
            buttons = list
            images = new Map()
            page = 0
            record.session = session
            // Held on the record, since a press is handled outside this closure.
            record.turnPage = () => {
                const { pages } = paging(session)
                if (pages < 2) return
                page = (page + 1) % pages
                paint(session)
            }
            paint(session)
        },

        setImage: function (index, image) {
            images.set(index, image)

            const layout = record.layout || []
            for (let key = 1; key < layout.length; key++) {
                const slot = layout[key]
                if (slot && slot.kind === "button" && slot.index === index) {
                    paintKey(key, image)
                    return
                }
            }
        },

        // A menu button with `dismiss` closes its session. On a deck, which is always
        // displayed, that means returning to the root rather than going dark. The root is
        // opened from a timer so that the session finishes closing first; the timer is
        // held, because one with no reference left is garbage collected before it fires.
        close: function () {
            record.reopenTimer = hs.timer.doAfter(0, () => {
                record.reopenTimer = null
                openRoot(record)
            })
        }
    }
}

// MARK: - Devices

function openRoot(record) {
    const chosen = menuForDevice(record.device)
    if (!chosen) {
        console.error(
            `[hs_streamdeck-gt] no menu registered for ${record.device.deckType} ` +
            `(${record.device.serialNumber})`
        )
        return
    }
    record.session = menu().openSession(chosen.menu, deckPresenter(record), { name: chosen.name })
}

function attach(device) {
    if (decks.has(device.serialNumber)) return decks.get(device.serialNumber)

    // `pressed` latches what each key held when it went down. See handlePress.
    const record = {
        device: device,
        session: null,
        layout: [],
        // Set by the presenter while a menu is displayed; see deckPresenter.
        turnPage: null,
        on: true,
        pressed: new Map(),
        reopenTimer: null,
        idleTimer: null,
        // Set when the screen locking blanked it, so unlocking restores only that.
        blankedBySystem: false,
        // The brightness last set, so the periodic check is a no-op most of the time.
        brightness: null
    }
    decks.set(device.serialNumber, record)

    applyBrightness(record)
    restartIdleTimer(record)
    device.reset()

    device.buttonCallback((_device, key, isDown) => {
        try {
            handlePress(record, key, isDown)
        } catch (e) {
            console.error(`[hs_streamdeck-gt] press on key ${key} failed: ${e.message}`)
        }
    })

    openRoot(record)
    console.log(
        `[hs_streamdeck-gt] attached ${device.deckType} (${device.serialNumber}), ` +
        `${device.keyRows}x${device.keyColumns}`
    )
    return record
}

function detach(serialNumber) {
    const record = decks.get(serialNumber)
    if (!record) return

    if (record.idleTimer) {
        record.idleTimer.stop()
        record.idleTimer = null
    }
    if (record.session) record.session.close()
    decks.delete(serialNumber)
    console.log(`[hs_streamdeck-gt] detached ${serialNumber}`)
}

// A press acts on release, and on what the key held when it went *down*. Acting on the
// current layout instead would misread the release of any key that changed the menu:
// Back occupies the same key as the first button of the parent menu, so popping on the
// press and reading the release against the new layout pushed straight back in.
function handlePress(record, key, isDown) {
    if (isDown) {
        record.pressed.set(key, {
            slot: (record.layout || [])[key],
            session: record.session
        })
        // A dark deck shows nothing, so the press that wakes it cannot be aimed at
        // anything. It wakes on release and runs no action. setOn restarts the countdown.
        if (!record.on) return

        // Any press counts as use.
        restartIdleTimer(record)

        const slot = (record.layout || [])[key]
        // Only a menu button has a hold; the session times it.
        if (slot && slot.kind === "button" && record.session) record.session.down(slot.index)
        return
    }

    // Waking is handled before the latched slot is examined: a key holding nothing still
    // wakes the deck, and the key that woke it must not also act.
    if (!record.on) {
        record.pressed.delete(key)
        setOn(record, true)
        return
    }

    const latched = record.pressed.get(key)
    record.pressed.delete(key)
    if (!latched || !latched.slot) return

    const slot = latched.slot
    if (slot.kind === "toggle") {
        setOn(record, false)
        return
    }
    if (slot.kind === "back") {
        if (latched.session) latched.session.pop()
        return
    }
    // A page turn redraws from the images the session has already sent, so it is ignored
    // once that session has been replaced: the images belong to the menu it drew.
    if (slot.kind === "page") {
        if (latched.session === record.session && record.turnPage) record.turnPage()
        return
    }
    // Reported to the session that was displayed at the press. A session replaced since
    // then — by a button that dismissed it — is closed and ignores this.
    if (slot.kind === "button" && latched.session) latched.session.up(slot.index)
}

// Off means the backlight at zero, as the Hammerspoon 1 Spoon did, rather than the keys
// painted black. Every key goes dark, including the on/off key — painting them cannot do
// that, since whatever is drawn on the on/off key stays visible. The images are left in
// place, so waking costs one call and the menu that was displayed is still there.
function setOn(record, on) {
    record.on = on

    if (on) {
        // However it came back, it is no longer waiting on an unlock.
        record.blankedBySystem = false
        // Forgotten so that the brightness is set again: the time of day may have changed
        // while the deck was dark.
        record.brightness = null
        applyBrightness(record)
        restartIdleTimer(record)
        return
    }

    // Nothing to count down to while it is already dark.
    if (record.idleTimer) {
        record.idleTimer.stop()
        record.idleTimer = null
    }

    try {
        record.device.setBrightness(0)
        record.brightness = 0
    } catch (e) {
        console.error(`[hs_streamdeck-gt] could not turn the deck off: ${e.message}`)
    }
}

// MARK: - Public API

/**
 * Apply the current settings to every attached deck.
 *
 * The brightness and the idle countdown are set when a deck is attached, so a setting
 * changed afterwards — from the console, or from a command — does not take hold until the
 * next press or the next reload. Call this after changing one.
 */
function applySettings() {
    if (brightnessTimer) {
        brightnessTimer.stop()
        brightnessTimer = hs.timer.doEvery(config.brightnessCheckSeconds, () => {
            for (const record of decks.values()) applyBrightness(record)
        })
    }

    for (const record of decks.values()) {
        // Forgotten so the brightness is written even when the value has not changed.
        record.brightness = null
        applyBrightness(record)
        if (record.on) restartIdleTimer(record)
    }
    return module.exports
}

/** Redraw every attached deck, re-resolving menus computed by a function. */
function refreshAll() {
    for (const record of decks.values()) {
        if (record.on) openRoot(record)
    }
    return module.exports
}

/** The record for an attached deck, by serial number. */
function getDeck(serialNumber) {
    return decks.get(serialNumber) || null
}

/** Every attached deck, as an array of records. */
function getDecks() {
    return Array.from(decks.values())
}

/** Attach to every deck present, and to any that is plugged in later. */
function start() {
    for (const device of hs.streamdeck.all()) attach(device)

    watcher = (event, device) => {
        if (event === "connected" || event === "didConnect") attach(device)
        else detach(device.serialNumber)
    }
    hs.streamdeck.addWatcher(watcher)

    // Follows the time of day. applyBrightness only reaches the hardware when the value
    // changes, so this costs a comparison per deck per minute.
    if (brightnessTimer) brightnessTimer.stop()
    brightnessTimer = hs.timer.doEvery(config.brightnessCheckSeconds, () => {
        for (const record of decks.values()) applyBrightness(record)
    })

    powerWatcher = (event) => {
        try {
            handlePowerEvent(event)
        } catch (e) {
            console.error(`[hs_streamdeck-gt] power event ${event} failed: ${e.message}`)
        }
    }
    hs.power.addEventWatcher(powerWatcher)

    return module.exports
}

/** Release every deck and stop watching for them. */
function stop() {
    if (watcher) {
        hs.streamdeck.removeWatcher(watcher)
        watcher = null
    }
    if (brightnessTimer) {
        brightnessTimer.stop()
        brightnessTimer = null
    }
    if (powerWatcher) {
        hs.power.removeEventWatcher(powerWatcher)
        powerWatcher = null
    }
    for (const record of Array.from(decks.values())) {
        if (record.idleTimer) {
            record.idleTimer.stop()
            record.idleTimer = null
        }
        if (record.session) record.session.close()
        try {
            record.device.reset()
        } catch (e) {
            console.error(`[hs_streamdeck-gt] reset failed: ${e.message}`)
        }
    }
    decks.clear()
    return module.exports
}

module.exports = {
    config,
    setMenu,
    setDefaultMenu,
    getDeck,
    getDecks,
    refreshAll,
    applySettings,
    start,
    stop
}
