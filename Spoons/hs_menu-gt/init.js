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
//         { label: "Clock", command: "time-show" }
//     ])
//
// A button's action is a command defined by hs_interactive-gt, named rather than written
// inline, so the same action is reachable from a menu, from a key and from the command
// chooser. `app:` and `url:` are shorthands the session resolves directly, and `fn:` is
// the escape hatch for an action not worth naming.
//
// Button art is composed with hs.canvas and exported through imageFromCanvas(). A page is
// still assembled through promises, because an imageProvider may return one and because
// the presenters were written against them, but drawing itself is synchronous and in
// process. It was not always: before hs.canvas existed a tile was SVG rendered through
// HSImage.fromURL, and an icon had to reach that markup as a base64 data URI, which meant
// a subprocess per icon and a queue to run them in. Anything in a presenter that looks
// like it is guarding against a slow or abandoned drawing dates from then.

// MARK: - User-configurable settings

const config = {
    // Where a relative `icon` path is looked up.
    iconDir: hs.appinfo.configDir + "/icons",
    // Rendered tiles are kept here.
    cacheDir: hs.appinfo.configDir + "/.cache/menu-gt",
    // Edge of a button image, in pixels. 96 is the Stream Deck XL's native size.
    tileSize: 96,
    // A press held at least this long is a long press, and fires while still held.
    holdSeconds: 0.5,
    // Offered to buttons that declare no `key`, home row first. Lower case only: a capital
    // is an address a button asks for, not one handed out.
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
    // The size a label starts at. It shrinks, as far as labelSizeFloor, until it fits.
    labelSize: 15,
    labelSizeFloor: 9,
    // A font's PostScript name, not its display name — "Helvetica-Bold", not "Helvetica
    // Bold". Null draws in the system font. Used for a button's label and for the
    // presenter's letters alike.
    font: "Helvetica",
    // Template images, such as SF Symbols, are black on transparent and would be
    // invisible. They are recoloured to this.
    symbolColor: "#FFFFFF",

    // How see-through the menu is on screen, from 0 for invisible to 1 for solid. It
    // reaches the whole of it: the panel behind the buttons, and each button entire —
    // background, icon and label together — so that the whole menu is dimmed by the same
    // amount, rather than solid buttons being left on a translucent panel.
    //
    // It is applied when the menu is displayed, not when a button is drawn, so the cached
    // tiles are the same whatever it is set to, and a Stream Deck — which has no
    // transparency to give — is unaffected.
    alpha: 0.8,

    // The on-screen presenter.
    screen: {
        tile: 96,
        spacing: 12,
        padding: 18,
        background: "#1C1C1EF5",
        letterSize: 18,
        letterColor: "#FFD479",
        level: "floating",
        // How long a page's letters answer before the window is drawn. The keys are bound
        // as soon as the page is presented, so a press within this time acts and no window
        // ever appears; someone who knows the menu never sees it. Zero draws at once.
        showDelay: 0,
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
// Every button is drawn as one square image, composed with hs.canvas and exported with
// imageFromCanvas(). The whole of it is synchronous and in process; a button is a promise
// only because the SVG escape hatch below still is, and because the presenters were
// written against one.

const tileCache = new Map()

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

// Canvas colours are {red, green, blue, alpha} components in 0..1, so the hex strings the
// settings are written in are converted here. Eight digits carry the alpha.
function canvasColor(value, fallback) {
    const text = String(value || fallback || "#000000").replace("#", "")
    const hex = text.length === 3 ? text.split("").map((c) => c + c).join("") : text
    const component = (at) => parseInt(hex.slice(at, at + 2), 16) / 255
    return {
        red: component(0),
        green: component(2),
        blue: component(4),
        alpha: hex.length >= 8 ? component(6) : 1
    }
}

/** The overall transparency, as a multiplier. Out-of-range or unset values mean solid. */
function alphaFactor() {
    const value = Number(config.alpha)
    if (!isFinite(value)) return 1
    return Math.max(0, Math.min(1, value))
}

/**
 * A hex colour with `config.alpha` folded into it, for hs.ui, which takes a string.
 *
 * @param {string} value A colour, with or without its own alpha.
 * @returns {string} An eight-digit `#RRGGBBAA`.
 */
function hexWithAlpha(value, fallback) {
    const color = canvasColor(value, fallback)
    color.alpha *= alphaFactor()
    const byte = (component) => Math.round(Math.max(0, Math.min(1, component)) * 255)
        .toString(16).padStart(2, "0")
    return "#" + byte(color.red) + byte(color.green) + byte(color.blue) + byte(color.alpha)
}

// A canvas draws an image at whatever resolution the image already holds, so a symbol
// left at its natural size — a fraction of a button — arrives soft however large the
// frame it is given. Everything is rasterised at twice the tile edge instead.
//
// The longer side is what reaches that size: forcing both would distort anything that is
// not square, and an SF Symbol rarely is. `imageScaling` fits the result to its frame
// afterwards without stretching it.
function sizedForTile(image) {
    const box = config.tileSize * 2
    const current = image.size
    const width = (current && current.w) || box
    const height = (current && current.h) || box
    const scale = box / Math.max(width, height)

    const copy = image.copyImage()
    copy.size = new HSSize(Math.max(1, Math.round(width * scale)),
                           Math.max(1, Math.round(height * scale)))
    return copy
}

/**
 * Recolour a template image — an SF Symbol is black on transparent, and invisible as it
 * stands against a dark tile.
 *
 * The symbol establishes the alpha and a filled rectangle composited with `sourceIn`
 * paints through it. This needs a canvas of its own: a composite rule applies against
 * everything already drawn in the same canvas, so doing it in the tile would clip the
 * colour to the tile's background rather than to the symbol.
 *
 * @param {object} image The template image.
 * @param {string} hex The colour to paint it.
 * @returns {object} A recoloured HSImage, or the original if the canvas cannot render.
 */
function tintedImage(image, hex) {
    const source = sizedForTile(image)
    // The canvas takes the symbol's own proportions, so the recoloured copy comes back
    // without transparent margins around it and the tile can fit it on its own terms.
    const size = source.size
    const box = { w: (size && size.w) || config.tileSize * 2, h: (size && size.h) || config.tileSize * 2 }

    const canvas = hs.canvas.create({ x: 0, y: 0, w: box.w, h: box.h })
    canvas.appendElements([
        {
            type: "image",
            image: source,
            frame: { x: 0, y: 0, w: box.w, h: box.h },
            imageScaling: "scaleProportionally",
            imageAlignment: "center"
        },
        {
            type: "rectangle",
            action: "fill",
            fillColor: canvasColor(hex),
            frame: { x: 0, y: 0, w: box.w, h: box.h },
            compositeRule: "sourceIn"
        }
    ])
    const tinted = canvas.imageFromCanvas()
    canvas.destroy()
    return tinted || image
}

/**
 * Break a label into lines that fit a width, measuring as it goes.
 *
 * `minimumTextSize` reports what a string would need in the font a text element is already
 * carrying, so the wrapping is done against the font actually being drawn rather than
 * against a character count. A single word too long for the line is left alone, for
 * `textLineBreak` to truncate.
 *
 * @param {object} canvas The canvas holding the element.
 * @param {number} index The text element's index, whose font attributes are measured with.
 * @param {string} text The label.
 * @param {number} maxWidth The width to fit, in points.
 * @param {number} maxLines How many lines to allow.
 * @returns {Array} The lines.
 */
function wrapToWidth(canvas, index, text, maxWidth, maxLines) {
    const words = String(text).split(/\s+/).filter(Boolean)
    const lines = []
    let line = ""

    for (const word of words) {
        const candidate = line ? line + " " + word : word
        const measured = canvas.minimumTextSize(index, candidate)
        if (!line || (measured.w || 0) <= maxWidth) {
            line = candidate
            continue
        }
        lines.push(line)
        if (lines.length >= maxLines) return lines
        line = word
    }
    if (line && lines.length < maxLines) lines.push(line)
    return lines
}

/**
 * Lay a label into a box: wrapped to fit, and shrunk until it does.
 *
 * The text element is already on the canvas, so its size is changed in place and measured
 * again. Text scales linearly, but wrapping does not — a smaller font may fit more words
 * on a line — so the two are settled together, a step at a time, down to a floor that
 * stays readable.
 *
 * @param {object} canvas The canvas holding the element.
 * @param {number} index The text element's index.
 * @param {string} text The label.
 * @param {object} box `{w, h}` the label has to fit inside.
 * @param {number} maxLines How many lines to allow.
 * @returns {object} `{text, fontSize, height}` — the text with its line breaks in place.
 */
function fitLabel(canvas, index, text, box, maxLines) {
    let fontSize = config.labelSize

    for (;;) {
        canvas.setElementAttribute(index, "textSize", fontSize)
        // On a single line there is nothing to wrap to: breaking at a word boundary would
        // throw the rest of the label away. It is shrunk to fit instead, and if it still
        // does not fit at the floor, `textLineBreak` truncates what is drawn.
        const lines = maxLines === 1
            ? [String(text)]
            : wrapToWidth(canvas, index, text, box.w, maxLines)
        const laid = lines.join("\n")
        const measured = canvas.minimumTextSize(index, laid)

        const fits = (measured.w || 0) <= box.w && (measured.h || 0) <= box.h
        if (fits || fontSize <= config.labelSizeFloor) {
            return { text: laid, fontSize: fontSize, height: measured.h || fontSize }
        }
        fontSize -= 1
    }
}

/**
 * Draw one button.
 *
 * Composed and exported in process through hs.canvas, at twice the tile edge — the export
 * renders at the backing scale, so a 96 point tile arrives as a 192 pixel image.
 *
 * The label is laid out by the canvas rather than by arithmetic here: it is one text
 * element, centred by `textAlignment`, wrapped and shrunk against `minimumTextSize`, and
 * truncated by `textLineBreak` if it still will not fit.
 *
 * @param {object} spec `{background, image, tint, label, labelColor}`. `image` is an
 *        HSImage and `tint` a colour to recolour it to, for a template image such as an
 *        SF Symbol. Any may be omitted; a button with neither icon nor label is a plain
 *        coloured square.
 * @returns {object} An HSImage, or null when the canvas cannot render.
 */
function tileImage(spec) {
    const size = config.tileSize
    const hasLabel = spec.label !== undefined && spec.label !== null && spec.label !== ""
    const elements = [{
        type: "rectangle",
        action: "fill",
        fillColor: canvasColor(spec.background, config.background),
        frame: { x: 0, y: 0, w: size, h: size }
    }]

    if (spec.image) {
        // With a label beneath it the icon sits high and leaves room for the text; alone
        // it fills the tile. The frame is a box to fit within, not a shape to fill:
        // `imageScaling` keeps the icon's proportions inside it.
        const box = size * (hasLabel ? config.iconScale : config.iconScaleAlone)
        elements.push({
            type: "image",
            image: spec.tint ? tintedImage(spec.image, spec.tint) : sizedForTile(spec.image),
            frame: {
                x: (size - box) / 2,
                y: hasLabel ? size * 0.02 : (size - box) / 2,
                w: box,
                h: box
            },
            imageScaling: "scaleProportionally",
            imageAlignment: "center"
        })
    }

    // A label beneath an icon gets the strip below it and one line; a label on its own gets
    // the tile and up to three.
    const inset = 3
    const band = spec.image
        ? { x: inset, y: size * 0.02 + size * config.iconScale, w: size - inset * 2, h: size - (size * 0.02 + size * config.iconScale) - 2 }
        : { x: inset, y: inset, w: size - inset * 2, h: size - inset * 2 }
    const maxLines = spec.image ? 1 : 3

    const labelIndex = elements.length
    if (hasLabel) {
        elements.push({
            type: "text",
            text: spec.label,
            textSize: config.labelSize,
            textFont: config.font || undefined,
            textColor: canvasColor(spec.labelColor, config.labelColor),
            textAlignment: "center",
            // One line truncates with an ellipsis; three wrap, having already been broken
            // to fit, and clip only if something has gone wrong.
            textLineBreak: maxLines === 1 ? "truncateTail" : "wordWrap",
            frame: band
        })
    }

    const canvas = hs.canvas.create({ x: 0, y: 0, w: size, h: size })
    canvas.appendElements(elements)

    if (hasLabel) {
        // Measured now that the element exists: minimumTextSize reads the font from it.
        const laid = fitLabel(canvas, labelIndex, spec.label, band, maxLines)
        canvas.setElementAttribute(labelIndex, "text", laid.text)
        canvas.setElementAttribute(labelIndex, "textSize", laid.fontSize)
        // Sits on the bottom edge beneath an icon, and centred in the tile without one.
        const top = spec.image
            ? size - 2 - laid.height
            : band.y + (band.h - laid.height) / 2
        canvas.setElementAttribute(labelIndex, "frame",
            { x: band.x, y: Math.max(band.y, top), w: band.w, h: laid.height })
    }

    const image = canvas.imageFromCanvas()
    canvas.destroy()

    if (!image) console.error("[hs_menu-gt] canvas produced no image for a button")
    return image
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

    // A button that draws itself is never cached on disk: its picture is expected to
    // differ from one moment to the next, and a tile per minute would fill the cache.
    if (button.imageProvider) return dynamicImage(button, options)

    const iconSpec = button.icon || (button.app ? "bundle:" + button.app : null)
    const key = [
        iconSpec || "",
        button.hideLabel ? "" : (button.label || ""),
        button.background || "",
        button.labelColor || ""
    ].join("|")

    if (tileCache.has(key)) return tileCache.get(key)

    // A finished tile is kept on disk. Drawing one costs a few milliseconds and loading it
    // rather less, and without this every reload redraws every button.
    const file = tileFilename(key)
    if (hs.fs.exists(file)) {
        const stored = HSImage.fromPath(file)
        if (stored) {
            const ready = Promise.resolve(stored)
            tileCache.set(key, ready)
            return ready
        }
    }

    // A failure is not remembered, in memory or on disk. The distinction matters: a button
    // whose icon could not be loaded still draws — as its label, or as a question mark —
    // and that tile is a perfectly valid image. Saving it would make one bad render
    // permanent, and the button would never show its icon again however often the menu was
    // reopened, because the cache would answer before anything tried to draw it.
    const promise = renderButton(button, iconSpec).then(({ image, complete }) => {
        if (!image) {
            tileCache.delete(key)
            return image
        }
        if (!complete) {
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
 * @returns {Promise} Resolves to an HSImage, or to null.
 */
function dynamicImage(button, options) {
    const context = (options && options.context) || {}

    let produced
    try {
        produced = button.imageProvider(context)
    } catch (e) {
        console.error(`[hs_menu-gt] imageProvider for ${button.label || "a button"} failed: ${e.message}`)
        return Promise.resolve(null)
    }

    return resolveProduced(produced, button)
}

function resolveProduced(value, button) {
    if (value === undefined || value === null) return Promise.resolve(null)

    if (typeof value.then === "function") {
        return value.then((resolved) => resolveProduced(resolved, button))
    }

    if (typeof value === "string") {
        const text = value.trim()
        // The one drawing that is still SVG, and still asynchronous: a provider may hand
        // back markup of its own, which hs.canvas has no way to render.
        if (text.startsWith("<svg")) return imageFromMarkup(text)
        return Promise.resolve(tileImage({
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
    return drawButton(spec, iconSpec)
}

/**
 * Draw a button, and say whether it was drawn as asked.
 *
 * `complete` is false when the button wanted an icon and did not get one. The picture is
 * still returned and still displayed — a label reads better than a blank square — but it
 * is not what the button asked for, and the caller uses this to keep it out of the disk
 * cache so a later draw can try the icon again.
 *
 * @returns {Promise} Resolves to `{image, complete}`.
 */
function renderButton(button, iconSpec) {
    const label = button.hideLabel ? null : button.label
    const hasLabel = label !== undefined && label !== null && label !== ""

    // With no icon the label carries the button, as it did in Hammerspoon 1. Asking for
    // no icon and getting none is a complete drawing, not a failed one.
    if (!iconSpec) {
        return Promise.resolve({
            image: tileImage({
                background: button.background,
                label: label,
                labelColor: button.labelColor
            }),
            complete: true
        })
    }

    const image = iconImage(iconSpec)
    if (!image) {
        console.error(`[hs_menu-gt] icon not found: ${iconSpec}`)
        return Promise.resolve({
            image: tileImage({
                background: button.background,
                label: hasLabel ? label : "?",
                labelColor: button.labelColor
            }),
            complete: false
        })
    }

    // An SF Symbol is a template image: black on transparent, and invisible as it stands,
    // so it is recoloured before being drawn.
    const isSymbol = typeof iconSpec === "string" && iconSpec.startsWith("symbol:")
    const tint = isSymbol ? (button.symbolColor || config.symbolColor) : null

    // Nothing to compose: the icon is the whole button. This is the common case, and it is
    // how the Hammerspoon 1 configuration's icon buttons were drawn.
    if (!hasLabel && !isSymbol && !button.background) {
        const copy = image.copyImage()
        copy.size = new HSSize(config.tileSize, config.tileSize)
        return Promise.resolve({ image: copy, complete: true })
    }

    const drawn = tileImage({
        background: button.background,
        image: image,
        tint: tint,
        label: label,
        labelColor: button.labelColor
    })
    return Promise.resolve({ image: drawn, complete: drawn !== null })
}

/** Draw a button, for callers that only want the picture. */
function drawButton(button, iconSpec) {
    return renderButton(button, iconSpec).then(({ image }) => image)
}

/** Discard the button images held in memory. The tiles on disk are kept. */
function clearImageCache() {
    tileCache.clear()
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
    // Case is part of the address, so `a` and `A` are two letters and a declared key keeps
    // the case it was written in.
    const taken = new Set()
    for (const button of buttons) {
        if (button.key) taken.add(String(button.key))
    }

    // The pool is lower case throughout: a capital is an address a button asks for by
    // name, never one handed out here, so which letter a button answers to does not change
    // case as the menu around it grows.
    const pool = Array.from(config.alphabet).filter((c) => !taken.has(c))
    let next = 0

    return buttons.map((button) => {
        if (button.key) return String(button.key)
        return next < pool.length ? pool[next++] : null
    })
}

/**
 * A menu is an array of buttons, or a function returning one, so that a menu of running
 * applications or open windows is computed when it is opened rather than when it is
 * defined.
 *
 * It may also be an object, which is how a menu says something about itself rather than
 * about any one button:
 *
 *     { keepOpen: false, buttons: [ ... ] }
 *
 * `buttons` holds the menu, and may itself be a function. Everything alongside it is a
 * default for the buttons in it — see `menuDefaults`.
 */
function menuButtons(menu) {
    if (menu && !Array.isArray(menu) && typeof menu === "object") return menu.buttons
    return menu
}

/**
 * A menu's own settings: whatever it carries besides its buttons.
 *
 * @param {object|Array|function} menu The menu.
 * @returns {object} The settings, or an empty object for a menu that is a plain array.
 */
function menuDefaults(menu) {
    if (menu && !Array.isArray(menu) && typeof menu === "object") return menu
    return {}
}

function resolveButtons(menu, context) {
    const source = menuButtons(menu)
    const value = typeof source === "function" ? source(context) : source
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

    /** The menus open right now, outermost first. Pass to `restore` to come back here. */
    session.path = () => stack.map((entry) => ({ ...entry }))

    /**
     * Open at a path taken from `path()`, so a menu can be reopened where it was left.
     *
     * The path's root must be the menu this session was opened with. One belonging to
     * another menu is ignored rather than grafted onto an unrelated stack.
     */
    session.restore = (path) => {
        if (!Array.isArray(path) || !path.length) return session
        if (path[0].menu !== stack[0].menu) return session

        stack.length = 0
        for (const entry of path) stack.push({ ...entry })
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

    /**
     * Whether a button has something to do on a hold, as `index` within the current page.
     *
     * A presenter offering a second way to reach that action asks here, so that what
     * counts as having one is decided in a single place.
     */
    session.hasAlt = (index) => Boolean(page[index]) && hasLongAction(page[index])

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
        finish(button)
    }

    // Two questions follow a press, and only one of them is about the device.
    //
    // `navigate` says where you are left, which every presenter has to answer because every
    // one has a menu stack. `keepOpen` says whether the menu remains displayed, which only
    // a presenter that can hide has to answer: a Stream Deck is always displaying
    // something, so there is nothing for it to keep open or close.
    function finish(button) {
        // Taken before navigating: a button's `keepOpen` may fall back to the menu it
        // belongs to, and by the time the question is asked the stack has moved on.
        const menu = stack[stack.length - 1].menu

        const where = navigationFor(button)
        if (where === "parent" && session.canPop()) session.pop()
        else if (where === "root" && session.canPop()) session.popToRoot()

        if (presenter.canHide && !staysOpen(button, menu)) session.close()
    }

    /** Where the press leaves the stack: "stay", "parent" or "root". */
    function navigationFor(button) {
        if (button.navigate) return button.navigate
        // Older spellings, kept working. `deck` held this same question.
        if (button.deck) return button.deck
        if (button.dismiss === false || button.screen === "stay") return "stay"
        return "parent"
    }

    /**
     * Whether a presenter that can hide should stay displayed.
     *
     * A button answers for itself if it says anything at all — in the current spelling or
     * either of the older ones. Only a button that is silent on the question takes the
     * menu's `keepOpen`, so a default never overrules an entry that asked for something.
     */
    function staysOpen(button, menu) {
        if (button.keepOpen !== undefined) return Boolean(button.keepOpen)
        // Older spellings. `screen` held this same question, and `dismiss` held both.
        if (button.screen) return button.screen === "stay"
        if (button.dismiss !== undefined) return button.dismiss === false

        // A button with a submenu stays open whatever the menu around it defaults to.
        // A short press on one never reaches here, because it descends into the submenu
        // instead; a hold does reach here, since a hold on a submenu runs its action, and
        // that should not close the menu either.
        if (button.children) return true

        const fallback = menuDefaults(menu).keepOpen
        if (fallback !== undefined) return Boolean(fallback)
        return false
    }

    render()
    return session
}

// MARK: - The screen presenter
//
// hs.ui cannot change a window's contents once it is built, so every navigation destroys
// the window and builds a new one. The menu is driven from the keyboard: each button
// carries a letter, bound only while the menu is displayed.
//
// The keys and the window are separate: the letters answer from the moment a page is
// presented, and the window is drawn `config.screen.showDelay` seconds later. A press
// before then navigates or closes, which cancels the pending draw, so the menu is only
// displayed when it is needed as a reminder of what the letters are.

/**
 * The screen the user is on: the one holding the focused window.
 *
 * Asked of the focused window directly, as hs_time-gt does it, rather than through
 * `hs.screen.main()`. The two agree in practice — `main()` is `NSScreen.main`, the screen
 * holding the window with keyboard focus, and it was observed tracking the focused window
 * correctly even while Hammerspoon had a window of its own on screen. It is used as the
 * fallback rather than as the answer only because the focused window is the question this
 * actually asks, and because `main()` is documented in terms of key windows, which is a
 * detour through AppKit's idea of focus rather than the system's.
 *
 * Neither is `hs.screen.primary()`, which is the display carrying the menu bar — what
 * System Settings calls the Main Display, confusingly enough.
 *
 * @returns {object} An HSScreen, or null if there are no screens.
 */
function currentScreen() {
    const focused = hs.window.focusedWindow()
    if (focused && focused.screen) return focused.screen
    return hs.screen.main() || hs.screen.primary()
}

/**
 * A frame of the given size, centred on a screen.
 *
 * The two coordinate systems have to be reconciled to place it: hs.screen frames have
 * their origin at the top left of the primary display, while hs.ui window frames have
 * theirs at its bottom left, with y growing upwards. Centring on the primary screen is
 * symmetric and comes out the same either way — which is why drawing there needed no
 * conversion — but on any other screen the two disagree, and by the height of the screen
 * plus the height of the menu.
 *
 * @param {object} target The screen to centre on.
 * @param {number} width The window's width.
 * @param {number} height The window's height.
 * @returns {object} An `{x, y, w, h}` frame in hs.ui's coordinates.
 */
function centredOnScreen(target, width, height) {
    const reference = hs.screen.primary() || target
    if (!target || !reference) return { x: 0, y: 0, w: width, h: height }

    const area = target.fullFrame
    const primary = reference.fullFrame

    return {
        x: area.x + (area.w - width) / 2,
        y: (primary.y + primary.h) - ((area.y + (area.h - height) / 2) + height),
        w: width,
        h: height
    }
}

function screenPresenter() {
    let win = null
    let hotkeys = []
    // Binds the current page's keys. Set by present(), called again after a prompt. Also
    // says whether a page is displayed, since `win` is null while the draw is pending.
    let takeKeys = null
    // The pending draw, when the window has not been built yet.
    let showTimer = null
    // Whether a prompt has the keyboard. Held across pages: a menu redraws itself while a
    // chooser is up — a self-drawing button on its timer is enough — and the new page must
    // not take back the keys the prompt is using.
    let suspended = false
    // The screen the menu was raised on, held for as long as it is displayed. Every
    // navigation destroys the window and builds a new one, and asking again each time
    // would let a submenu open on a different screen from the menu it came from: by then
    // the focused window may be the menu's own, or nothing at all.
    let screen = null

    function releaseKeys() {
        for (const hotkey of hotkeys) {
            if (hotkey) hotkey.destroy()
        }
        hotkeys = []
    }

    function destroyWindow() {
        if (showTimer) {
            showTimer.stop()
            showTimer = null
        }
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

        // This presenter can hide, so a button's `keepOpen` applies to it.
        canHide: true,

        present: function (session, buttons) {
            releaseKeys()
            destroyWindow()

            const s = config.screen
            const letters = session.letters()

            // A letter is bound with both handlers, so a hold is distinguishable from a
            // tap exactly as it is on the Stream Deck.
            //
            // The letter is an address, and its case is part of it: `a` and `A` are two
            // buttons, reached without and with shift. Ctrl reaches whatever a hold
            // reaches, so ctrl-a and ctrl-shift-a act on those same two buttons. Ctrl is
            // bound only where there is a hold action, leaving the chord free otherwise.
            //
            // Kept as a function so the keys can be given up while a prompt is on screen
            // and taken again afterwards, from the page that is still displayed.
            takeKeys = () => {
                letters.forEach((letter, index) => {
                    if (!letter) return
                    const address = letter !== letter.toLowerCase() ? ["shift"] : []
                    const key = letter.toLowerCase()

                    bind(address, key, () => session.down(index), () => session.up(index))
                    if (session.hasAlt(index)) {
                        bind(["ctrl", ...address], key, () => session.activate(index, "long"), null)
                    }
                })
                for (const key of s.cancelKeys) bind([], key, () => session.close(), null)
                for (const key of s.backKeys) {
                    bind([], key, () => { if (session.canPop()) session.pop() }, null)
                }
            }
            // Bound before the window is drawn, so the letters answer during the delay.
            if (!suspended) takeKeys()

            const draw = () => {
                const count = buttons.length
                const columns = Math.max(1, s.columnsFor(count))
                const rows = Math.ceil(count / columns)

                // Each cell is the tile with its letter beneath it.
                const cellHeight = s.tile + s.letterSize + 6
                const width = columns * s.tile + (columns - 1) * s.spacing + s.padding * 2
                const height = rows * cellHeight + (rows - 1) * s.spacing + s.padding * 2

                if (!screen) screen = currentScreen()
                win = hs.ui.window(centredOnScreen(screen, width, height))
                    .titled(false)
                    .level(s.level)
                    .backgroundColor(hexWithAlpha(s.background, config.background))

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
                                // Dims the button entire — background, icon and label —
                                // so the menu is see-through as one piece.
                                .opacity(alphaFactor())
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
            }

            // A press before the timer fires navigates or closes, and both destroy the
            // window, which stops the timer: the page is then never drawn.
            const delay = Number(s.showDelay) || 0
            if (delay > 0) {
                showTimer = hs.timer.doAfter(delay, () => {
                    showTimer = null
                    draw()
                })
            } else {
                draw()
            }
        },

        // A chooser or a text prompt has the keyboard, and a hotkey outranks it: the menu
        // would answer the arrow keys meant for the chooser. So the menu stays drawn, as a
        // reminder of where you are, but stops listening until the prompt is gone.
        suspendKeys: function () {
            suspended = true
            releaseKeys()
        },

        // `takeKeys` rather than `win`: a page whose window is still pending is displayed
        // in every sense that matters here, and must take its keys back.
        resumeKeys: function () {
            suspended = false
            if (takeKeys && !hotkeys.length) takeKeys()
        },

        close: function () {
            releaseKeys()
            takeKeys = null
            suspended = false
            // Released with the menu, so the next one is raised on whichever screen is
            // current then rather than on the one this menu was opened on.
            screen = null
            destroyWindow()
        }
    }
}

// MARK: - Public API

let screenSession = null
// Where the on-screen menu was when it was last hidden, so it reopens there.
let screenPath = null
// The presenter drawing it, kept so its keys can be suspended while a prompt is up.
let screenKeys = null
// Undoes the subscription to hs_interactive-gt's prompts. Null when not subscribed.
let unwatchPrompts = null

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
    watchPrompts()

    const presenter = screenPresenter()
    screenKeys = presenter
    screenSession = openSession(menu, presenter, options)

    // A menu opened from inside a prompt — the M-x chooser runs a command that shows one —
    // must not take the keys the prompt is using.
    if (promptIsOpen()) presenter.suspendKeys()

    // Reopen where the menu was last left. A Stream Deck keeps its place because being
    // displayed is its whole state; the on-screen menu was starting over at the root only
    // because hiding it destroyed the session. Dismissing to do something else and pressing
    // the key again now comes back to the same submenu. A path belonging to another root
    // menu is refused by restore(), so showing a different menu starts at its own root.
    if (screenPath) screenSession.restore(screenPath)
    return screenSession
}

/** Hide the on-screen menu, if one is displayed. */
function hideScreen() {
    if (screenSession) {
        // Read before closing: the position outlives the session that held it.
        screenPath = screenSession.path()
        screenSession.close()
        screenSession = null
    }
    screenKeys = null
    return module.exports
}

/**
 * Give up the menu's keys while hs_interactive-gt has a prompt on screen, and take them
 * again when it goes away. See the presenter's suspendKeys for why.
 *
 * Subscribed on the first menu rather than at start(), since hs_interactive-gt loads this
 * Spoon and is not finished being set up when start() runs.
 */
function watchPrompts() {
    if (unwatchPrompts) return

    const spoon = interactive()
    if (!spoon || !spoon.onPromptChange) return

    unwatchPrompts = spoon.onPromptChange((open) => {
        if (!screenKeys) return
        if (open) screenKeys.suspendKeys()
        else screenKeys.resumeKeys()
    })
}

/** Whether hs_interactive-gt has a prompt on screen. */
function promptIsOpen() {
    const spoon = interactive()
    return Boolean(spoon && spoon.promptIsOpen && spoon.promptIsOpen())
}

/** Forget where the on-screen menu was, so the next one opens at its root. */
function resetScreenPosition() {
    screenPath = null
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
    if (unwatchPrompts) {
        unwatchPrompts()
        unwatchPrompts = null
    }
    return module.exports
}

module.exports = {
    config,
    // Displaying menus.
    showOnScreen,
    hideScreen,
    toggleOnScreen,
    resetScreenPosition,
    isShowingOnScreen,
    // For other presenters, such as hs_streamdeck-gt.
    openSession,
    buttonImage,
    imageFromMarkup,
    tileImage,
    openURL,
    iconImage,
    assignLetters,
    resolveButtons,
    clearImageCache,
    clearDiskCache,
    start,
    stop
}
