// hs_menu-gt — hierarchical menus that are independent of the device displaying them.
//
// A menu is an array of button specifications. A session walks that menu, resolving one
// page at a time, and hands the page to a presenter. The presenter draws the page on some
// device and reports presses back; the menu holds no knowledge of the device. This Spoon
// provides a screen presenter, which draws the menu in an hs.ui window where every button
// carries a letter to press. hs_streamdeck-gt adds a presenter for Stream Deck hardware.
// Both display the same menu definition.
//
//     const menu = hs.loadSpoon("hs_menu-gt")
//     menu.showOnScreen([
//         { label: "Emacs", app: "org.gnu.Emacs", key: "e" },
//         { label: "Clock", command: "clock-show" }
//     ])
//
// A button's action is a command defined by hs_interactive-gt, named rather than written
// inline, so the same action is reachable from a menu, from a key and from the command
// chooser. `app:` and `url:` are shorthands the session resolves directly, and `fn:` is
// the escape hatch for an action not worth naming.
//
// Hammerspoon 2 has no canvas and cannot render text into an image, so button art is
// written as SVG and loaded through HSImage.fromURL with a data URL. That call is
// asynchronous, which is why a page is assembled through promises rather than drawn
// directly.

// MARK: - User-configurable settings

const config = {
    // Where a relative `icon` path is looked up.
    iconDir: hs.appinfo.configDir + "/icons",
    // Rendered tiles, and the PNG and base64 forms of each icon, are kept here.
    cacheDir: hs.appinfo.configDir + "/.cache/menu-gt",
    // Edge of a button image, in pixels. 96 is the Stream Deck XL's native size.
    tileSize: 96,
    // A press held at least this long is a long press, and fires while still held.
    holdSeconds: 0.5,
    // How long an icon encoding is given before it is abandoned.
    taskTimeout: 4,
    // How often the encoded file is looked for while the encoding runs.
    taskPollInterval: 0.05,
    // Offered to buttons that declare no `key`, home row first.
    alphabet: "asdfghjklqwertyuiopzxcvbnm",
    // The browser a `url` button opens in, as a bundle ID. Null uses the system default.
    // A button overrides it with `urlBundle`.
    urlBundle: null,

    // Button art. The icon is drawn as a fraction of the tile: smaller when a label sits
    // beneath it, nearly the whole tile when it is alone.
    iconScale: 0.74,
    iconScaleAlone: 0.94,
    background: "#101014",
    labelColor: "#F0F0F0",
    labelSize: 15,
    font: "Helvetica",
    // Template images, such as SF Symbols, are black on transparent and would be
    // invisible. They are recoloured to this.
    symbolColor: "#FFFFFF",

    // The on-screen presenter.
    screen: {
        tile: 96,
        spacing: 12,
        padding: 18,
        background: "#1C1C1EF5",
        letterSize: 18,
        letterColor: "#FFD479",
        level: "floating",
        // Dismisses the menu. Escape is always bound.
        cancelKeys: ["escape"],
        // Returns to the parent menu.
        backKeys: ["delete"],
        // The grid the buttons are laid out in. Given the number of buttons, returns the
        // number of columns; the rows follow. A wide, shallow grid suits a screen.
        columnsFor: (count) => Math.min(count, Math.max(4, Math.ceil(Math.sqrt(count * 1.6))))
    }
}

// MARK: - Paths

hs.fs.mkdir(config.cacheDir)

function expandPath(path) {
    const absolute = hs.fs.pathToAbsolute(path)
    return absolute ? absolute : path
}

// A relative icon name is resolved against config.iconDir, as the Hammerspoon 1
// configuration wrote them ("icons/bus_7.png" there, "bus_7.png" here).
function resolveIconPath(name) {
    if (name.startsWith("/") || name.startsWith("~")) return expandPath(name)
    const bare = name.replace(/^icons\//, "")
    return expandPath(config.iconDir + "/" + bare)
}

function cacheKeyToFilename(key) {
    return config.cacheDir + "/" + key.replace(/[^A-Za-z0-9._-]/g, "_") + ".png"
}

// djb2. A button's key holds its label and colours as well as its icon, so it needs
// reducing to something a filename can hold, while still telling two buttons apart.
function hashKey(key) {
    let hash = 5381
    for (let i = 0; i < key.length; i++) {
        hash = ((hash * 33) ^ key.charCodeAt(i)) >>> 0
    }
    return hash.toString(36)
}

// The readable part is there to make the cache directory legible; the hash is what
// distinguishes one tile from another.
function tileFilename(key) {
    const readable = key.replace(/[^A-Za-z0-9]/g, "_").slice(0, 32)
    return config.cacheDir + "/tile_" + readable + "_" + hashKey(key) + ".png"
}

// MARK: - Images
//
// Every button is drawn as one square image. Compositing an icon with a label needs the
// icon as a file, because SVG references it by URL and there is no other way to combine
// two images in Hammerspoon 2.

const tileCache = new Map()
const iconFileCache = new Map()
const iconDataCache = new Map()

/**
 * Resolve a button's icon specification to an image, without drawing it.
 *
 * Accepts an HSImage, `symbol:name` for an SF Symbol, `bundle:com.example.app` for an
 * application icon, or a path — absolute, `~`-relative, or relative to `config.iconDir`.
 *
 * @param {string|object} spec The icon specification.
 * @returns {object} An HSImage, or null when the icon cannot be loaded.
 */
function iconImage(spec) {
    if (!spec) return null
    if (typeof spec !== "string") return spec

    if (spec.startsWith("symbol:")) return HSImage.fromSymbol(spec.slice(7))
    if (spec.startsWith("bundle:")) return HSImage.fromAppBundle(spec.slice(7))
    return HSImage.fromPath(resolveIconPath(spec))
}

// SVG can only reference an image by URL, so the icon is written to the cache directory
// once and referenced from there afterwards. It is saved at twice the tile size: an
// application icon arrives at 32x32 and an SF Symbol smaller still, and both are drawn
// at up to 96.
function iconFile(image, key) {
    if (iconFileCache.has(key)) return iconFileCache.get(key)

    const path = cacheKeyToFilename(key)
    if (!hs.fs.exists(path)) {
        const copy = image.copyImage()
        copy.size = new HSSize(config.tileSize * 2, config.tileSize * 2)
        if (!copy.saveToFile(path)) {
            console.error(`[hs_menu-gt] could not write icon cache file ${path}`)
            return null
        }
    }

    iconFileCache.set(key, path)
    return path
}

function shellQuote(path) {
    return "'" + String(path).replace(/'/g, "'\\''") + "'"
}

// An hs.task promise is sometimes never resolved and never rejected. Twelve concurrent
// `sleep 1` tasks produced anywhere from zero to twelve completions across runs, with no
// error reported. The failure was only reproduced when the tasks were started from an
// hs.ipc evaluation, and not when they were started from a timer after that connection
// closed, so its cause is not established and it may not arise from init.js at all.
// Encodings are run one at a time regardless: an icon is encoded once ever and the result
// is kept on disk, so the cost is negligible, and a lost promise would otherwise leave a
// button blank with nothing logged.
let taskQueue = Promise.resolve()

function runSerially(task) {
    const result = taskQueue.then(task, task)
    // The queue itself must never reject, or every task behind it is skipped.
    taskQueue = result.then(() => null, () => null)
    return result
}

// Timers are held: one with no reference left is garbage collected before it fires.
const pendingTimers = new Set()

/**
 * Run a shell command that writes `outputPath`, and report whether the file arrived.
 *
 * The command is not run again when its promise is lost. The process runs to completion
 * either way — every encoding this happened to still produced a correct file — so the
 * file is watched for instead, and the result is taken as soon as it is complete. Waiting
 * for the timeout instead would cost four seconds for work that finished in ninety
 * milliseconds.
 *
 * The file is only accepted once its size stops changing, since it appears on disk before
 * it has been written in full.
 *
 * @param {string} command The command to run.
 * @param {string} outputPath The file it writes.
 * @returns {Promise} Resolves true when the file has been written.
 */
function runWritingFile(command, outputPath, isCurrent) {
    return runSerially(() => {
        // Checked here rather than at the call site: by the time a queued encoding
        // reaches the front, the menu that asked for it may no longer be displayed.
        if (isCurrent && !isCurrent()) return Promise.resolve(false)

        return new Promise((resolve) => {
            let settled = false
            let previousSize = -1
            const started = Date.now()

            const finish = (ok) => {
                if (settled) return
                settled = true
                if (poll) {
                    poll.stop()
                    pendingTimers.delete(poll)
                }
                resolve(ok)
            }

            const sizeOf = (path) => {
                const attributes = hs.fs.attributes(path)
                return attributes && attributes.size !== undefined ? attributes.size : -1
            }

            const poll = hs.timer.doEvery(config.taskPollInterval, () => {
                if (settled) return

                if (hs.fs.exists(outputPath)) {
                    const size = sizeOf(outputPath)
                    // Two readings the same means writing has stopped.
                    if (size > 0 && size === previousSize) {
                        finish(true)
                        return
                    }
                    previousSize = size
                }

                if (Date.now() - started > config.taskTimeout * 1000) {
                    finish(hs.fs.exists(outputPath) && sizeOf(outputPath) > 0)
                }
            })
            pendingTimers.add(poll)

            // Still the quickest answer when it arrives; the poll is what covers it when
            // it does not.
            hs.task.shell(command).then(
                (result) => {
                    if (result && result.exitCode === 0) finish(true)
                    else finish(hs.fs.exists(outputPath) && sizeOf(outputPath) > 0)
                },
                () => {}
            )
        })
    })
}

/**
 * An icon as a `data:` URI, for embedding in SVG.
 *
 * AppKit renders SVG as a self-contained document and does not fetch external resources,
 * so an icon has to be written into the markup rather than referenced by path. The bytes
 * cannot be read in process — hs.fs.read decodes as text and returns undefined for a PNG
 * — so the encoding is done by `base64`. Its output is text, so it is cached to disk and
 * read back directly on later runs, and the subprocess runs once per icon ever.
 *
 * @param {object} image The icon.
 * @param {string} key Identifies the icon, and names its cache files.
 * @returns {Promise} Resolves to a data URI, or to null if the icon cannot be encoded.
 */
function iconDataURI(image, key, isCurrent) {
    if (iconDataCache.has(key)) return iconDataCache.get(key)

    const png = iconFile(image, key)
    if (!png) return Promise.resolve(null)

    const encodedPath = png.replace(/\.png$/, ".b64")
    if (hs.fs.exists(encodedPath)) {
        const stored = hs.fs.read(encodedPath)
        if (stored) {
            const promise = Promise.resolve("data:image/png;base64," + String(stored).trim())
            iconDataCache.set(key, promise)
            return promise
        }
    }

    // base64 writes the file itself rather than returning it: hs.task.shell does not
    // resolve when a command produces output of this size, and an encoded icon runs to
    // well over a hundred kilobytes.
    const command = "base64 -i " + shellQuote(png) + " -o " + shellQuote(encodedPath)
    const promise = runWritingFile(command, encodedPath, isCurrent).then((ok) => {
        if (!ok) {
            // Not cached, so a later menu that wants this icon encodes it then. An
            // abandoned encoding is not a failure and is not reported as one.
            iconDataCache.delete(key)
            if (!isCurrent || isCurrent()) {
                console.error(`[hs_menu-gt] base64 produced nothing for ${png}`)
            }
            return null
        }
        const encoded = hs.fs.read(encodedPath)
        if (!encoded) {
            console.error(`[hs_menu-gt] base64 wrote nothing readable to ${encodedPath}`)
            return null
        }
        return "data:image/png;base64," + String(encoded).replace(/\s+/g, "")
    }).catch((e) => {
        console.error(`[hs_menu-gt] base64 failed for ${png}: ${e && e.message ? e.message : e}`)
        return null
    })

    iconDataCache.set(key, promise)
    return promise
}

function escapeXML(text) {
    return String(text)
        .replace(/&/g, "&amp;")
        .replace(/</g, "&lt;")
        .replace(/>/g, "&gt;")
        .replace(/"/g, "&quot;")
        .replace(/'/g, "&apos;")
}

// SVG does not wrap text, so a label is broken into lines here. A word longer than the
// line is truncated rather than allowed to overflow the button.
function wrapLabel(text, maxChars, maxLines) {
    const words = String(text).split(/\s+/).filter(Boolean)
    const lines = []
    let line = ""

    for (const word of words) {
        const candidate = line ? line + " " + word : word
        if (candidate.length <= maxChars) {
            line = candidate
            continue
        }
        if (line) lines.push(line)
        if (lines.length >= maxLines) break
        line = word
    }
    if (line && lines.length < maxLines) lines.push(line)

    return lines
        .slice(0, maxLines)
        .map((l) => (l.length > maxChars ? l.slice(0, maxChars - 1) + "…" : l))
}

/**
 * The SVG for one button.
 *
 * @param {object} spec `{background, iconData, tint, label, labelColor}`, where iconData
 *        is a `data:` URI. Any may be omitted; a button with neither icon nor label is a
 *        plain coloured square.
 * @returns {string} SVG markup, sized to `config.tileSize`.
 */
function tileMarkup(spec) {
    const size = config.tileSize
    const background = spec.background || config.background
    const parts = [`<rect width="${size}" height="${size}" fill="${background}"/>`]

    // A template image carries its shape in the alpha channel and is black throughout, so
    // it is recoloured by replacing RGB while keeping alpha.
    if (spec.tint) {
        const c = spec.tint
        parts.push(
            `<filter id="tint" color-interpolation-filters="sRGB">` +
            `<feFlood flood-color="${c}" result="flood"/>` +
            `<feComposite in="flood" in2="SourceAlpha" operator="in"/>` +
            `</filter>`
        )
    }
    const filter = spec.tint ? ' filter="url(#tint)"' : ""

    const hasLabel = spec.label !== undefined && spec.label !== null && spec.label !== ""
    const lines = hasLabel ? wrapLabel(spec.label, 13, spec.iconData ? 1 : 3) : []
    const labelColor = spec.labelColor || config.labelColor

    if (spec.iconData) {
        // With a label beneath it the icon sits high and leaves room for the text; alone
        // it fills the tile.
        const box = size * (lines.length > 0 ? config.iconScale : config.iconScaleAlone)
        const x = (size - box) / 2
        const y = lines.length > 0 ? size * 0.02 : (size - box) / 2
        parts.push(
            `<image x="${x.toFixed(1)}" y="${y.toFixed(1)}" ` +
            `width="${box.toFixed(1)}" height="${box.toFixed(1)}"${filter} ` +
            `preserveAspectRatio="xMidYMid meet" ` +
            `xlink:href="${spec.iconData}"/>`
        )
    }

    if (lines.length > 0) {
        // Shrink the text rather than truncate it, down to a floor that stays readable.
        const longest = Math.max(...lines.map((l) => l.length))
        const fontSize = Math.max(9, Math.min(config.labelSize, Math.floor(size * 1.55 / longest)))
        const lineHeight = fontSize * 1.15
        // Sits on the bottom edge beneath the icon, or centred vertically when the label
        // is the whole button.
        const firstBaseline = spec.iconData
            ? size - 5 - (lines.length - 1) * lineHeight
            : (size - (lines.length - 1) * lineHeight) / 2 + fontSize * 0.35

        lines.forEach((line, i) => {
            parts.push(
                `<text x="${size / 2}" y="${(firstBaseline + i * lineHeight).toFixed(1)}" ` +
                `font-family="${escapeXML(config.font)}" font-size="${fontSize}" ` +
                `fill="${labelColor}" text-anchor="middle">${escapeXML(line)}</text>`
            )
        })
    }

    return `<svg xmlns="http://www.w3.org/2000/svg" ` +
        `xmlns:xlink="http://www.w3.org/1999/xlink" ` +
        `width="${size}" height="${size}">${parts.join("")}</svg>`
}

/** Render SVG markup to an image. Resolves to null if the markup cannot be rendered. */
function imageFromMarkup(markup) {
    const url = "data:image/svg+xml;charset=utf-8," + encodeURIComponent(markup)
    return HSImage.fromURL(url).catch((e) => {
        console.error(`[hs_menu-gt] SVG render failed: ${e && e.message ? e.message : e}`)
        return null
    })
}

/**
 * The image for a button, drawn once and cached.
 *
 * @param {object} button A resolved button.
 * @returns {Promise} Resolves to an HSImage, or to null if it could not be drawn.
 */
function buttonImage(button, options) {
    if (button.image) return Promise.resolve(button.image)

    const isCurrent = options && options.isCurrent ? options.isCurrent : null

    // A button that draws itself is never cached on disk: its picture is expected to
    // differ from one moment to the next, and a tile per minute would fill the cache.
    if (button.imageProvider) return dynamicImage(button, options, isCurrent)

    const iconSpec = button.icon || (button.app ? "bundle:" + button.app : null)
    const key = [
        iconSpec || "",
        button.hideLabel ? "" : (button.label || ""),
        button.background || "",
        button.labelColor || ""
    ].join("|")

    if (tileCache.has(key)) return tileCache.get(key)

    // A finished tile is kept on disk. Drawing one costs an encoding subprocess and an SVG
    // render — about 190 ms for an application icon, and more when a task's promise is
    // lost and the timeout has to expire — while loading it costs a single call. Without
    // this, every reload redraws every button.
    const file = tileFilename(key)
    if (hs.fs.exists(file)) {
        const stored = HSImage.fromPath(file)
        if (stored) {
            const ready = Promise.resolve(stored)
            tileCache.set(key, ready)
            return ready
        }
    }

    // A failure is not remembered: caching it would make one bad render permanent for as
    // long as the configuration stays loaded.
    const promise = drawButton(button, iconSpec, isCurrent).then((image) => {
        if (!image) {
            tileCache.delete(key)
            return image
        }
        if (!image.saveToFile(file)) {
            console.error(`[hs_menu-gt] could not write tile cache file ${file}`)
        }
        return image
    })

    tileCache.set(key, promise)
    return promise
}

/**
 * The image for a button that draws itself.
 *
 * `imageProvider(context)` may return any of:
 *
 * - an `HSImage`, used as it stands,
 * - SVG markup, rendered as the whole button,
 * - a string, drawn as the button's label,
 * - an object of button fields — `label`, `background`, `labelColor`, `icon` — merged
 *   over the button and drawn as any other button is, which is the usual case,
 * - a promise of any of those.
 *
 * @param {object} button The button.
 * @param {object} [options] `{context}`, passed to the provider.
 * @param {function} [isCurrent] Whether the menu that asked for this is still displayed.
 * @returns {Promise} Resolves to an HSImage, or to null.
 */
function dynamicImage(button, options, isCurrent) {
    const context = (options && options.context) || {}

    let produced
    try {
        produced = button.imageProvider(context)
    } catch (e) {
        console.error(`[hs_menu-gt] imageProvider for ${button.label || "a button"} failed: ${e.message}`)
        return Promise.resolve(null)
    }

    return resolveProduced(produced, button, isCurrent)
}

function resolveProduced(value, button, isCurrent) {
    if (value === undefined || value === null) return Promise.resolve(null)

    if (typeof value.then === "function") {
        return value.then((resolved) => resolveProduced(resolved, button, isCurrent))
    }

    if (typeof value === "string") {
        const text = value.trim()
        if (text.startsWith("<svg")) return imageFromMarkup(text)
        return imageFromMarkup(tileMarkup({
            label: value,
            background: button.background,
            labelColor: button.labelColor
        }))
    }

    // An HSImage. Identified by behaviour rather than by type name, so a caller can hand
    // back anything image-shaped.
    if (typeof value.copyImage === "function") return Promise.resolve(value)

    // Button fields. Drawn through the ordinary path, so an icon, a label and a
    // background all work, but without the disk cache that buttonImage would apply.
    const spec = Object.assign({}, button, value)
    delete spec.imageProvider
    const iconSpec = spec.icon || (spec.app ? "bundle:" + spec.app : null)
    return drawButton(spec, iconSpec, isCurrent)
}

function drawButton(button, iconSpec, isCurrent) {
    const label = button.hideLabel ? null : button.label
    const hasLabel = label !== undefined && label !== null && label !== ""

    // With no icon the label carries the button, as it did in Hammerspoon 1.
    if (!iconSpec) {
        return imageFromMarkup(tileMarkup({
            background: button.background,
            label: label,
            labelColor: button.labelColor
        }))
    }

    const image = iconImage(iconSpec)
    if (!image) {
        console.error(`[hs_menu-gt] icon not found: ${iconSpec}`)
        return imageFromMarkup(tileMarkup({
            background: button.background,
            label: hasLabel ? label : "?",
            labelColor: button.labelColor
        }))
    }

    // An SF Symbol is a template image: black on transparent, and invisible as it stands.
    // Recolouring it means compositing, and so does a label or a background.
    const isSymbol = typeof iconSpec === "string" && iconSpec.startsWith("symbol:")
    const tint = isSymbol ? (button.symbolColor || config.symbolColor) : null

    // Nothing to compose: the icon is the whole button. This is the common case, it needs
    // no SVG and no subprocess, and it is how the Hammerspoon 1 configuration's icon
    // buttons were drawn.
    if (!hasLabel && !isSymbol && !button.background) {
        const copy = image.copyImage()
        copy.size = new HSSize(config.tileSize, config.tileSize)
        return Promise.resolve(copy)
    }

    // An icon is cached under its own name, on the assumption that a given path always
    // holds the same picture. A file that is rewritten — a generated forecast image, say
    // — breaks that, so a button may name its own key and include whatever makes the
    // picture different, such as the file's modification time.
    const iconKey = button.iconKey ||
        (typeof iconSpec === "string" ? iconSpec : ("image|" + (label || "")))
    return iconDataURI(image, iconKey, isCurrent).then((uri) => {
        if (!uri) {
            // Abandoned rather than failed: draw nothing, so that nothing is cached and
            // the menu that superseded this one is left alone.
            if (isCurrent && !isCurrent()) return null

            // The icon could not be encoded; the label alone is better than nothing.
            return imageFromMarkup(tileMarkup({
                background: button.background,
                label: hasLabel ? label : "?",
                labelColor: button.labelColor
            }))
        }
        return imageFromMarkup(tileMarkup({
            background: button.background,
            iconData: uri,
            tint: tint,
            label: label,
            labelColor: button.labelColor
        }))
    })
}

/** Discard the button images held in memory. The tiles on disk are kept. */
function clearImageCache() {
    tileCache.clear()
    iconFileCache.clear()
    iconDataCache.clear()
    return module.exports
}

/**
 * Delete every cached tile, encoded icon and intermediate file from disk, and empty the
 * caches in memory. Call after changing the drawing settings, which the cache keys do not
 * describe: a tile drawn under the previous settings would otherwise be reused.
 *
 * @returns {number} How many files were deleted.
 */
function clearDiskCache() {
    clearImageCache()

    let deleted = 0
    const entries = hs.fs.list(config.cacheDir) || []
    for (const entry of entries) {
        const path = entry.indexOf("/") === -1 ? config.cacheDir + "/" + entry : entry
        if (hs.fs.deletePath(path)) deleted += 1
    }
    return deleted
}

// MARK: - Buttons and letters

/**
 * Assign each button the letter that selects it on screen.
 *
 * A button's declared `key` is honoured; the rest are given unused letters from
 * `config.alphabet` in order. A menu larger than the alphabet leaves the remainder
 * without a letter, reachable on a Stream Deck but not from the keyboard.
 *
 * @param {object[]} buttons Resolved buttons.
 * @returns {string[]} One letter per button, positionally, or null where none is left.
 */
function assignLetters(buttons) {
    const taken = new Set()
    for (const button of buttons) {
        if (button.key) taken.add(String(button.key).toLowerCase())
    }

    const pool = Array.from(config.alphabet).filter((c) => !taken.has(c))
    let next = 0

    return buttons.map((button) => {
        if (button.key) return String(button.key).toLowerCase()
        return next < pool.length ? pool[next++] : null
    })
}

// A menu is an array, or a function returning one, so that a menu of running applications
// or open windows is computed when it is opened rather than when it is defined.
function resolveButtons(menu, context) {
    const value = typeof menu === "function" ? menu(context) : menu
    return Array.isArray(value) ? value.filter(Boolean) : []
}

// MARK: - Actions

function interactive() {
    return hs.spoons["hs_interactive-gt"]
}

function runCommand(name, args) {
    const spoon = interactive()
    if (!spoon) {
        console.error(`[hs_menu-gt] hs_interactive-gt is not loaded; cannot run ${name}`)
        return
    }
    // callInteractively rather than call, so a command whose arguments the menu does not
    // supply reads them from the snapshot taken at the press — the focused window is
    // still the user's at that moment.
    spoon.callInteractively(name, { args: args || [] })
}

/**
 * Open a URL.
 *
 * @param {string} target The URL.
 * @param {string} [bundleID] The browser to open it in. Defaults to the system handler.
 */
function openURL(target, bundleID) {
    if (bundleID) hs.urlevent.openURLWithBundle(target, bundleID)
    else hs.urlevent.openURL(target)
}

/**
 * Bring an application forward, starting it if it is not running.
 *
 * @param {string} bundleID The application's bundle ID.
 * @param {boolean} [hideIfActive] Hide it instead when it is already frontmost.
 */
function activateApp(bundleID, hideIfActive) {
    const app = hs.application.matchingBundleID(bundleID)

    if (hideIfActive && app && app.isActive) {
        app.hide()
        return
    }

    // Not app.activate(): NSRunningApplication.activate() is subject to macOS cooperative
    // activation and does nothing when the calling application is not frontmost, which
    // Hammerspoon never is at the moment a key or a Stream Deck button is pressed. It
    // fails silently. launchOrFocus goes through NSWorkspace.openApplication, which is not
    // restricted, and starts the application when it is not already running.
    hs.application.launchOrFocus(bundleID)
}

// MARK: - Sessions
//
// A session is one presenter's walk through one menu: which menu is displayed, what was
// pushed to reach it, and what a press means. Each presenter owns a session, so opening a
// submenu on the Stream Deck does not move the on-screen menu, and the two can display
// different parts of the same menu at once.

/**
 * Open a menu on a presenter.
 *
 * @param {object[]|function} menu The root menu.
 * @param {object} presenter The presenter that displays it.
 * @param {object} [options] `{name}`, the root menu's title.
 * @returns {object} The session.
 */
function openSession(menu, presenter, options) {
    const settings = options || {}
    const stack = [{ menu: menu, name: settings.name || "Menu" }]

    let page = []
    let letters = []
    let closed = false
    // Incremented by every render. Images belong to the render that asked for them, and a
    // render that has been superseded must neither paint nor go on encoding: a menu can
    // take seconds to draw the first time, which is long enough to navigate away from it.
    let generation = 0

    const holdTimers = new Map()
    const heldFired = new Set()

    // One per button that refreshes itself, and the last state each reported.
    const updateTimers = new Set()
    let lastStates = new Map()

    const session = {}

    function context() {
        return { session: session, presenter: presenter, depth: stack.length - 1 }
    }

    /** Whether there is a parent menu to return to. */
    session.canPop = () => stack.length > 1

    /** The buttons currently displayed, in presentation order. */
    session.buttons = () => page

    /** The letter that selects each displayed button, positionally. */
    session.letters = () => letters

    /** The title of the menu currently displayed. */
    session.title = () => stack[stack.length - 1].name

    /** The index of the button a letter selects, or -1. */
    session.indexOfLetter = (letter) => letters.indexOf(String(letter).toLowerCase())

    // Resolve the current menu, hand it to the presenter, then fill in the images as they
    // are drawn. A presenter that cannot change its content after it is displayed sets
    // `progressive` false and is given the page only once every image has resolved.
    // A button's state is compared as text, so that an object or an array from a
    // stateProvider is compared by value rather than by identity.
    function stateOf(button, index) {
        if (!button.stateProvider) return undefined
        try {
            return JSON.stringify(button.stateProvider())
        } catch (e) {
            console.error(`[hs_menu-gt] stateProvider for ${button.label || index} failed: ${e.message}`)
            return undefined
        }
    }

    function stopUpdateTimers() {
        for (const timer of updateTimers) timer.stop()
        updateTimers.clear()
    }

    // Refresh one self-drawing button, if what it depends on has changed.
    function update(index, isCurrent) {
        const button = page[index]
        if (!button || !isCurrent()) return

        if (button.stateProvider) {
            const state = stateOf(button, index)
            if (state === lastStates.get(index)) return
            lastStates.set(index, state)
        }

        buttonImage(button, {
            isCurrent: isCurrent,
            context: { session: session, index: index, state: lastStates.get(index) }
        }).then((image) => {
            if (!isCurrent() || !image || !presenter.setImage) return
            presenter.setImage(index, image)
        })
    }

    // Only a presenter that can change what it displays can refresh a button. An hs.ui
    // window cannot, and rebuilding it once a second would take the keyboard with it, so
    // its self-drawing buttons are drawn once when the menu opens.
    function startUpdateTimers(isCurrent) {
        if (!presenter.progressive) return

        page.forEach((button, index) => {
            if (!button.imageProvider || !button.updateInterval) return

            const timer = hs.timer.doEvery(button.updateInterval, () => {
                if (!isCurrent()) {
                    timer.stop()
                    updateTimers.delete(timer)
                    return
                }
                update(index, isCurrent)
            })
            updateTimers.add(timer)
        })
    }

    function render() {
        if (closed) return

        generation += 1
        const thisGeneration = generation
        const isCurrent = () => !closed && thisGeneration === generation

        stopUpdateTimers()
        lastStates = new Map()

        page = resolveButtons(stack[stack.length - 1].menu, context())
        letters = assignLetters(page)

        const images = page.map((button, index) => {
            // Seeded here so the first tick after the menu opens does not redraw a button
            // whose state has not changed since.
            const state = stateOf(button, index)
            if (state !== undefined) lastStates.set(index, state)

            return buttonImage(button, {
                isCurrent: isCurrent,
                context: { session: session, index: index, state: state }
            })
        })

        startUpdateTimers(isCurrent)

        if (presenter.progressive) {
            presenter.present(session, page)
            images.forEach((promise, index) => {
                promise.then((image) => {
                    if (!isCurrent() || !image || !presenter.setImage) return
                    presenter.setImage(index, image)
                })
            })
            return
        }

        Promise.all(images).then((resolved) => {
            if (!isCurrent()) return
            resolved.forEach((image, index) => { page[index].image = image })
            presenter.present(session, page)
        })
    }

    /** Display a submenu, keeping the current menu on the stack. */
    session.push = (button) => {
        stack.push({ menu: button.children, name: button.label || "Menu" })
        cancelHolds()
        render()
        return session
    }

    /** Return to the parent menu. Does nothing at the root. */
    session.pop = () => {
        if (!session.canPop()) return session
        stack.pop()
        cancelHolds()
        render()
        return session
    }

    /** Return to the root menu. */
    session.popToRoot = () => {
        if (!session.canPop()) return session
        stack.length = 1
        cancelHolds()
        render()
        return session
    }

    /** Redraw the current menu, re-resolving a menu computed by a function. */
    session.refresh = () => {
        render()
        return session
    }

    /** Close the menu and release the presenter. */
    session.close = () => {
        if (closed) return session
        closed = true
        cancelHolds()
        stopUpdateTimers()
        if (presenter.close) presenter.close()
        return session
    }

    /** Refresh one self-drawing button now, without waiting for its interval. */
    session.update = (index) => {
        const thisGeneration = generation
        update(index, () => !closed && thisGeneration === generation)
        return session
    }

    session.isClosed = () => closed

    // MARK: Press recognition
    //
    // Both presenters report a press as a button going down and later coming up: the
    // Stream Deck through buttonCallback, the screen through a hotkey bound with both a
    // press and a release handler. A hold fires as soon as the threshold elapses, while
    // the button is still down, which is how the Hammerspoon 1 Spoon behaved. macOS does
    // not deliver key auto-repeat to hs.hotkey, so a repeated press event cannot occur.

    function cancelHolds() {
        for (const timer of holdTimers.values()) timer.stop()
        holdTimers.clear()
        heldFired.clear()
    }

    /** Report that a button was pressed. `index` is positional within the current page. */
    session.down = (index) => {
        if (closed || !page[index]) return session
        heldFired.delete(index)

        const button = page[index]
        // Only a button with something to do on a hold needs the timer.
        if (!hasLongAction(button)) return session

        holdTimers.set(index, hs.timer.doAfter(config.holdSeconds, () => {
            holdTimers.delete(index)
            heldFired.add(index)
            act(index, "long")
        }))
        return session
    }

    /** Report that a button was released. */
    session.up = (index) => {
        if (closed || !page[index]) return session

        const timer = holdTimers.get(index)
        if (timer) {
            timer.stop()
            holdTimers.delete(index)
        }
        // The long action already ran while the button was held.
        if (heldFired.has(index)) {
            heldFired.delete(index)
            return session
        }
        act(index, "short")
        return session
    }

    /** Run a button's action without a press, as `index` within the current page. */
    session.activate = (index, kind) => {
        act(index, kind || "short")
        return session
    }

    function hasLongAction(button) {
        return Boolean(button.altCommand || button.altFn || button.app)
    }

    function act(index, kind) {
        const button = page[index]
        if (!button || closed) return

        const long = kind === "long"

        // A submenu opens on a short press; a hold on it is left for an action.
        if (!long && button.children) {
            session.push(button)
            return
        }
        if (button.back) {
            session.pop()
            return
        }

        const command = long ? button.altCommand : button.command
        const args = long ? button.altArgs : button.args
        const fn = long ? button.altFn : button.fn

        let acted = false
        try {
            if (fn) {
                fn(context(), button)
                acted = true
            } else if (command) {
                runCommand(command, args)
                acted = true
            } else if (button.app) {
                // A hold hides an application that is already frontmost, so one button
                // both reveals and dismisses it.
                activateApp(button.app, long)
                acted = true
            } else if (button.url) {
                openURL(button.url, button.urlBundle || config.urlBundle)
                acted = true
            }
        } catch (e) {
            console.error(`[hs_menu-gt] ${button.label || "button"} failed: ${e.message}`)
        }

        if (!acted) return

        // `dismiss` closes the menu after acting, which suits a menu displayed on demand.
        // A presenter that is always displayed, such as a Stream Deck, treats closing as
        // a return to the root.
        if (button.dismiss !== false) session.close()
    }

    render()
    return session
}

// MARK: - The screen presenter
//
// hs.ui cannot change a window's contents once it is built, so every navigation destroys
// the window and builds a new one. The menu is driven from the keyboard: each button
// carries a letter, bound only while the menu is displayed.

function screenPresenter() {
    let win = null
    let hotkeys = []

    function releaseKeys() {
        for (const hotkey of hotkeys) {
            if (hotkey) hotkey.destroy()
        }
        hotkeys = []
    }

    function destroyWindow() {
        if (!win) return
        win.destroy()
        win = null
    }

    function bind(mods, key, down, up) {
        const hotkey = hs.hotkey.bind(mods, key, down, up)
        if (hotkey) hotkeys.push(hotkey)
        else console.error(`[hs_menu-gt] could not bind ${key} for the on-screen menu`)
    }

    return {
        // hs.ui windows cannot be altered after they are shown.
        progressive: false,

        present: function (session, buttons) {
            releaseKeys()
            destroyWindow()

            const s = config.screen
            const letters = session.letters()
            const count = buttons.length
            const columns = Math.max(1, s.columnsFor(count))
            const rows = Math.ceil(count / columns)

            // Each cell is the tile with its letter beneath it.
            const cellHeight = s.tile + s.letterSize + 6
            const width = columns * s.tile + (columns - 1) * s.spacing + s.padding * 2
            const height = rows * cellHeight + (rows - 1) * s.spacing + s.padding * 2

            // Centring is symmetric, so it holds whichever corner the origin is in.
            const screen = hs.screen.primary().fullFrame
            win = hs.ui.window({
                x: screen.x + (screen.w - width) / 2,
                y: screen.y + (screen.h - height) / 2,
                w: width,
                h: height
            })
                .titled(false)
                .level(s.level)
                .backgroundColor(s.background)

            win.vstack().spacing(s.spacing).padding(s.padding)
            for (let row = 0; row < rows; row++) {
                win.hstack().spacing(s.spacing)
                for (let column = 0; column < columns; column++) {
                    const index = row * columns + column
                    if (index >= count) break

                    win.vstack().spacing(2)
                    if (buttons[index].image) {
                        win.image(buttons[index].image)
                            .resizable()
                            .aspectRatio("fit")
                            .frame({ w: s.tile, h: s.tile })
                    } else {
                        win.rectangle()
                            .fill(config.background)
                            .cornerRadius(8)
                            .frame({ w: s.tile, h: s.tile })
                    }
                    win.text(letters[index] ? letters[index] : " ")
                        .font(HSFont.customSize(config.font, s.letterSize))
                        .foregroundColor(s.letterColor)
                    win.end()
                }
                win.end()
            }
            win.end()
            win.show()

            // A letter is bound with both handlers, so a hold is distinguishable from a
            // tap exactly as it is on the Stream Deck.
            letters.forEach((letter, index) => {
                if (!letter) return
                bind([], letter, () => session.down(index), () => session.up(index))
            })
            for (const key of s.cancelKeys) bind([], key, () => session.close(), null)
            for (const key of s.backKeys) {
                bind([], key, () => { if (session.canPop()) session.pop() }, null)
            }
        },

        close: function () {
            releaseKeys()
            destroyWindow()
        }
    }
}

// MARK: - Public API

let screenSession = null

/**
 * Display a menu on screen, driven by the keyboard.
 *
 * Calling this while a menu is displayed replaces it.
 *
 * @param {object[]|function} menu The root menu.
 * @param {object} [options] `{name}`, the menu's title.
 * @returns {object} The session displaying it.
 */
function showOnScreen(menu, options) {
    hideScreen()
    screenSession = openSession(menu, screenPresenter(), options)
    return screenSession
}

/** Hide the on-screen menu, if one is displayed. */
function hideScreen() {
    if (screenSession) {
        screenSession.close()
        screenSession = null
    }
    return module.exports
}

/** Whether a menu is displayed on screen. */
function isShowingOnScreen() {
    return Boolean(screenSession) && !screenSession.isClosed()
}

/** Hide the on-screen menu if it is displayed, and show `menu` otherwise. */
function toggleOnScreen(menu, options) {
    if (isShowingOnScreen()) return hideScreen()
    return showOnScreen(menu, options)
}

function start() {
    return module.exports
}

function stop() {
    hideScreen()
    return module.exports
}

module.exports = {
    config,
    // Displaying menus.
    showOnScreen,
    hideScreen,
    toggleOnScreen,
    isShowingOnScreen,
    // For other presenters, such as hs_streamdeck-gt.
    openSession,
    buttonImage,
    imageFromMarkup,
    tileMarkup,
    openURL,
    iconImage,
    iconFile,
    assignLetters,
    resolveButtons,
    clearImageCache,
    clearDiskCache,
    start,
    stop
}
