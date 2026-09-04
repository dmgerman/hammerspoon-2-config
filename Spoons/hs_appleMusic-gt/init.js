// hs_appleMusic-gt — a port of the Hammerspoon 1 hs_music Spoon.
//
// Playback, volume and track information go through AppleScript: Hammerspoon 2 has no
// hs.itunes, and Music's scripting interface covers all of it.
//
// Playing a named album cannot. AppleScript reaches only what is in the library, and a
// library that streams holds almost nothing, so an album from the list has to be played
// the way a person would. Version 1 typed into Music's search field and clicked the first
// card in the results. This asks the iTunes Search API for the album's identifier instead,
// opens that album's page with a music:// URL, and presses the Play button on it. The
// album is then chosen by identifier rather than by whichever card came first, which is
// what kept turning a plain album into its deluxe edition.

// MARK: - User-configurable settings

const config = {
    // One "Band|Album" per line. Blank lines, lines starting with #, and lines without a
    // separator are ignored.
    albumListPath: `${hs.appinfo.configDir}/albums.txt`,

    // Which Apple Music storefront to search. A wrong one finds nothing.
    storefront: "ca",

    // Placeholders: {name}, {artist}, {album}.
    trackFormat: "{name} - {artist} [{album}]",
    alertDuration: 3,

    // nextAlbum and previousAlbum skip a track at a time until the album changes. The
    // limit stops a long playlist of single-track albums from skipping forever.
    maxAlbumSkipAttempts: 20,
    albumSkipInterval: 0.3,

    // Auto-play starts a random album whenever Music reports "stopped".
    autoPlayInterval: 30,

    // The album page takes a moment to render after the URL opens, so its Play button is
    // waited for rather than expected.
    playButtonTitle: "Play",
    playButtonPollInterval: 0.4,
    playButtonTimeout: 10,

    // How many search results to consider before matching on name.
    searchLimit: 25
}

const MUSIC_BUNDLE_ID = "com.apple.Music"

// MARK: - State

let autoPlayTimer = null
let albumSkipTimer = null
let playButtonTimer = null
// Held so it is not collected while displayed.
let activeChooser = null

// MARK: - Talking to Music

function alert(message) {
    hs.ui.alert(message).duration(config.alertDuration).show()
}

/** A string as the contents of an AppleScript string literal. */
function forAppleScript(text) {
    return String(text).replace(/\\/g, "\\\\").replace(/"/g, '\\"')
}

/** A string as one single-quoted shell word. */
function forShell(text) {
    return `'${String(text).replace(/'/g, "'\\''")}'`
}

/**
 * Run AppleScript against Music and return its result.
 *
 * @param {string} body The statements inside `tell application "Music"`.
 * @returns {?string} The result as text, or null if the script failed.
 */
function tellMusic(body) {
    const outcome = hs.osascript.applescriptSync(`tell application "Music"\n${body}\nend tell`)
    if (!outcome || !outcome.success) {
        console.error(`[hs_appleMusic-gt] AppleScript failed: ${outcome ? outcome.raw : "no result"}`)
        return null
    }
    return outcome.result === undefined || outcome.result === null ? "" : String(outcome.result)
}

/** Whether Music is running. Asked of the application list, so Music is not launched. */
function isRunning() {
    return hs.application.matchingBundleID(MUSIC_BUNDLE_ID) !== null
}

/** Reports and returns false when Music is not running, for the callers that need it. */
function requireRunning() {
    if (isRunning()) return true
    alert("Music is not running")
    return false
}

/** "playing", "paused", "stopped", or "not running". */
function playerState() {
    if (!isRunning()) return "not running"
    return tellMusic("get player state as text") || "unknown"
}

function isPlaying() {
    return playerState() === "playing"
}

// MARK: - Playback

function togglePlayPause() {
    if (!requireRunning()) return module.exports
    tellMusic("playpause")
    return module.exports
}

function play() {
    if (!requireRunning()) return module.exports
    tellMusic("play")
    return module.exports
}

/** Stop playback. Playing again restarts the album rather than resuming it. */
function stop() {
    if (!requireRunning()) return module.exports
    tellMusic("stop")
    return module.exports
}

function nextTrack() {
    if (!requireRunning()) return module.exports
    tellMusic("next track")
    return module.exports
}

function previousTrack() {
    if (!requireRunning()) return module.exports
    tellMusic("previous track")
    return module.exports
}

// MARK: - What is playing

/**
 * The current track.
 *
 * @returns {?object} `{name, artist, album}`, or null when nothing is playing.
 */
function currentTrack() {
    if (!isRunning()) return null
    // One call rather than three, so the three fields describe the same track even if it
    // changes while they are read. Tab-separated: none of the three may contain a tab.
    const line = tellMusic(
        'try\n' +
        'return (get name of current track) & "\\t" & (get artist of current track) & "\\t" & (get album of current track)\n' +
        'on error\n' +
        'return ""\n' +
        'end try'
    )
    if (!line) return null

    const parts = String(line).split("\t")
    if (parts.length < 3) return null
    return { name: parts[0], artist: parts[1], album: parts[2] }
}

function formatTrack(track) {
    return config.trackFormat
        .replace("{name}", track.name)
        .replace("{artist}", track.artist)
        .replace("{album}", track.album)
}

/** The current track as `config.trackFormat` describes it, or null. */
function getCurrentTrack() {
    const track = currentTrack()
    return track ? formatTrack(track) : null
}

function getCurrentArtist() {
    const track = currentTrack()
    return track ? track.artist : null
}

function getCurrentAlbum() {
    const track = currentTrack()
    return track ? track.album : null
}

/** Show the current track, and copy the same text to the pasteboard, as version 1 did. */
function showCurrentTrack() {
    if (!requireRunning()) return module.exports
    const track = currentTrack()
    if (!track) {
        alert("Nothing is playing")
        return module.exports
    }
    const text = formatTrack(track)
    hs.pasteboard.writeString(text)
    alert(text)
    return module.exports
}

// MARK: - Volume

/** Music's own volume, 0 to 100, or null when it cannot be read. */
function getVolume() {
    if (!isRunning()) return null
    const value = tellMusic("get sound volume")
    return value === null || value === "" ? null : Number(value)
}

/** Show the volume as well as returning it, for a menu button that reports it. */
function showVolume() {
    const volume = getVolume()
    alert(volume === null ? "Music is not running" : `Volume ${volume}`)
    return volume
}

/**
 * Set the volume.
 *
 * @param {number} level 0 to 100. Values outside that are clamped.
 * @returns {?number} The volume set, or null when Music is not running.
 */
function setVolume(level) {
    if (!requireRunning()) return null
    const wanted = Math.max(0, Math.min(100, Math.round(Number(level))))
    if (!Number.isFinite(wanted)) {
        alert(`Illegal volume [${level}]`)
        return null
    }
    tellMusic(`set sound volume to ${wanted}`)
    return wanted
}

/**
 * Change the volume by `delta`, which may be negative.
 *
 * @returns {?number} The new volume, or null when Music is not running.
 */
function adjustVolume(delta) {
    const current = getVolume()
    if (current === null) {
        alert("Music is not running")
        return null
    }
    const volume = setVolume(current + Number(delta))
    if (volume !== null) alert(`Volume ${volume}`)
    return volume
}

// MARK: - Skipping a whole album
//
// Music has no "next album", so tracks are skipped until the album name changes. Done on a
// timer rather than in a loop: each skip has to reach Music and be reflected back before
// the next album name is worth reading, and a loop would block everything else meanwhile.

function stopAlbumSkip() {
    if (albumSkipTimer) {
        albumSkipTimer.stop()
        albumSkipTimer = null
    }
}

function skipToNewAlbum(direction) {
    if (!requireRunning()) return module.exports

    const startAlbum = getCurrentAlbum()
    if (startAlbum === null) {
        alert("Nothing is playing")
        return module.exports
    }

    stopAlbumSkip()
    let attempts = 0

    const step = () => {
        attempts += 1
        if (direction === "next") nextTrack()
        else previousTrack()

        albumSkipTimer = hs.timer.doAfter(config.albumSkipInterval, () => {
            const album = getCurrentAlbum()

            if (album !== null && album !== startAlbum) {
                albumSkipTimer = null
                // Going back lands on the last track of the previous album, so walk to its
                // first track: keep going back while the album stays the same, then
                // forward once.
                if (direction === "previous") seekToFirstTrack(album)
                else alert(`Album: ${album}`)
                return
            }

            if (attempts >= config.maxAlbumSkipAttempts) {
                albumSkipTimer = null
                alert(`No other album within ${config.maxAlbumSkipAttempts} tracks`)
                return
            }
            step()
        })
    }

    step()
    return module.exports
}

function seekToFirstTrack(targetAlbum) {
    let attempts = 0

    const step = () => {
        attempts += 1
        previousTrack()

        albumSkipTimer = hs.timer.doAfter(config.albumSkipInterval, () => {
            const album = getCurrentAlbum()

            if (album !== targetAlbum || attempts >= config.maxAlbumSkipAttempts) {
                // One track too far, or far enough: come forward to the first track.
                nextTrack()
                albumSkipTimer = null
                alert(`Album: ${targetAlbum}`)
                return
            }
            step()
        })
    }

    step()
}

function nextAlbum() {
    return skipToNewAlbum("next")
}

function previousAlbum() {
    return skipToNewAlbum("previous")
}

// MARK: - The album list

/** The album name a URL carries, from the slug Apple Music puts in its path. */
function labelFromURL(url) {
    const match = /\/album\/([^/?#]+)/.exec(url)
    if (!match) return url
    return decodeURIComponent(match[1]).replace(/-/g, " ")
}

/**
 * Read the album list.
 *
 * A line is either a URL to an album page or a `Band|Album` name. Everything from a # to
 * the end of the line is a comment, so a whole line can be one; on a URL line the comment
 * also names the album, a URL having no readable name of its own.
 *
 * @param {string} [path] Defaults to `config.albumListPath`.
 * @returns {object[]} Entries in file order, each `{kind: "url", url, label}` or
 *          `{kind: "name", band, album}`.
 */
function readAlbums(path) {
    const file = path || config.albumListPath
    if (!hs.fs.exists(file)) {
        alert(`No album list at ${file}`)
        return []
    }

    const contents = hs.fs.read(file)
    if (contents === null || contents === undefined) {
        alert(`Could not read ${file}`)
        return []
    }

    const albums = []
    for (const raw of String(contents).split("\n")) {
        const hash = raw.indexOf("#")
        const comment = hash < 0 ? "" : raw.slice(hash + 1).trim()
        const line = (hash < 0 ? raw : raw.slice(0, hash)).trim()
        if (!line) continue

        if (/^(https?|music):\/\//i.test(line)) {
            albums.push({ kind: "url", url: line, label: comment || labelFromURL(line) })
            continue
        }

        const separator = line.indexOf("|")
        if (separator < 0) continue

        const band = line.slice(0, separator).trim()
        const album = line.slice(separator + 1).trim()
        if (band && album) albums.push({ kind: "name", band, album })
    }
    return albums
}

/** How an entry is named in an alert or a chooser. */
function describeEntry(entry) {
    if (!entry) return "?"
    return entry.kind === "url" ? entry.label : `${entry.band} — ${entry.album}`
}

/** One entry at random, or null when the list is empty. */
function pickRandomAlbum(path) {
    const albums = readAlbums(path)
    if (!albums.length) return null
    return albums[Math.floor(Math.random() * albums.length)]
}

/** Play a random album from the list. */
function playRandomAlbum(path) {
    const choice = pickRandomAlbum(path)
    if (!choice) {
        alert(`No albums in ${path || config.albumListPath}`)
        return module.exports
    }
    alert(describeEntry(choice))
    playEntry(choice)
    return module.exports
}

/** Show the list, sorted by what it is named, and play what is chosen. */
function chooseAlbum(path) {
    const albums = readAlbums(path)
    if (!albums.length) {
        alert(`No albums in ${path || config.albumListPath}`)
        return module.exports
    }

    // A URL entry sorts by its label and a named one by its band, so both sit where the
    // eye looks for them.
    const sortKey = (e) => (e.kind === "url" ? e.label : `${e.band} ${e.album}`).toLowerCase()
    const sorted = albums.slice().sort((a, b) => sortKey(a).localeCompare(sortKey(b)))

    const chooser = hs.chooser.create()
    chooser.placeholder = "Album"
    chooser.searchSubText = true
    chooser.setChoices(sorted.map((entry) => ({
        text: entry.kind === "url" ? entry.label : entry.album,
        subText: entry.kind === "url" ? "link" : entry.band,
        entry: entry
    })))
    chooser.onSelect = (item) => {
        activeChooser = null
        if (!item) return
        playEntry(item.entry)
    }
    activeChooser = chooser
    chooser.show()
    return module.exports
}

/** Append the album now playing to the list, unless it is already there. */
function addCurrentAlbum(path) {
    if (!requireRunning()) return module.exports

    const track = currentTrack()
    if (!track || !track.album || !track.artist) {
        alert("Nothing is playing")
        return module.exports
    }

    const file = path || config.albumListPath
    const already = readAlbums(file).some((entry) =>
        entry.kind === "name" &&
        entry.band.toLowerCase() === track.artist.toLowerCase() &&
        entry.album.toLowerCase() === track.album.toLowerCase())

    if (already) {
        alert(`Already listed: ${track.artist} — ${track.album}`)
        return module.exports
    }

    hs.fs.append(file, `${track.artist}|${track.album}\n`)
    alert(`Added: ${track.artist} — ${track.album}`)
    return module.exports
}

// MARK: - Finding an album in the Apple Music catalogue

/**
 * Ask the iTunes Search API which album this is.
 *
 * An exact match on both artist and album name is preferred, because a search for an album
 * also returns its deluxe and anniversary editions. Where there is no single exact match
 * the first result is used and the ambiguity is reported, so a wrong album is visible
 * rather than silent.
 *
 * @param {string} band
 * @param {string} album
 * @returns {Promise<?object>} `{name, artist, url}`, or null when nothing was found.
 */
function resolveAlbum(band, album) {
    const term = hs.http.encodeForQuery(`${band} ${album}`)
    const url = `https://itunes.apple.com/search?term=${term}&entity=album` +
        `&limit=${config.searchLimit}&country=${config.storefront}`

    return hs.http.get(url).then((response) => {
        if (!response || response.status !== 200) {
            alert(`Search failed for ${band} — ${album}`)
            return null
        }

        let results
        try {
            results = JSON.parse(response.body).results || []
        } catch (e) {
            alert(`Search returned nothing usable for ${band} — ${album}`)
            return null
        }

        if (!results.length) {
            alert(`Not found: ${band} — ${album}`)
            return null
        }

        const same = (a, b) => String(a).trim().toLowerCase() === String(b).trim().toLowerCase()
        const exact = results.filter((r) => same(r.collectionName, album) && same(r.artistName, band))

        let chosen
        if (exact.length === 1) {
            chosen = exact[0]
        } else {
            chosen = exact.length ? exact[0] : results[0]
            const what = exact.length
                ? `${exact.length} albums match exactly`
                : "no exact match"
            alert(`${band} — ${album}: ${what}, playing ${chosen.artistName} — ${chosen.collectionName}`)
        }

        return {
            name: chosen.collectionName,
            artist: chosen.artistName,
            // The same page, opened in Music rather than in a browser.
            url: String(chosen.collectionViewUrl).replace(/^https:/, "music:")
        }
    }).catch((e) => {
        alert(`Search failed for ${band} — ${album}`)
        console.error(`[hs_appleMusic-gt] search failed: ${e}`)
        return null
    })
}

// MARK: - Playing an album

function stopWaitingForPlayButton() {
    if (playButtonTimer) {
        playButtonTimer.stop()
        playButtonTimer = null
    }
}

/** Music's Play button, once its album page has rendered, or null. */
function findPlayButton() {
    const app = hs.application.matchingBundleID(MUSIC_BUNDLE_ID)
    if (!app) return null

    const element = hs.ax.applicationElement(app)
    if (!element) return null

    // findByRole walks the tree itself. The album page carries exactly one button with
    // this title; the buttons on each track row are untitled.
    const buttons = hs.ax.findByRole("AXButton", element)
        .filter((button) => button.title === config.playButtonTitle)
    return buttons.length ? buttons[0] : null
}

/** Wait for the Play button to appear, then press it. */
function pressPlayWhenReady(description) {
    stopWaitingForPlayButton()
    const deadline = Math.ceil(config.playButtonTimeout / config.playButtonPollInterval)
    let attempts = 0

    const poll = () => {
        attempts += 1
        const button = findPlayButton()

        if (button) {
            playButtonTimer = null
            button.performAction("AXPress")
            return
        }
        if (attempts >= deadline) {
            playButtonTimer = null
            alert(`Music did not offer a Play button for ${description}`)
            return
        }
        playButtonTimer = hs.timer.doAfter(config.playButtonPollInterval, poll)
    }

    playButtonTimer = hs.timer.doAfter(config.playButtonPollInterval, poll)
}

/**
 * Open an album page in Music.
 *
 * The URL is given the music: scheme, so it reaches Music rather than whichever
 * application handles http.
 *
 * Opened by a subprocess rather than by AppleScript's `open location`. That command blocks
 * until the URL has been handed over, and this runs inside the callback of the search
 * request, which JavaScriptCore runs on the main thread: blocking there stops every timer,
 * every hotkey and the dismissal of any alert on screen, and the deadlock does not clear.
 */
function openAlbumURL(url) {
    const musicURL = String(url).replace(/^https?:/i, "music:")
    return hs.task.shell(`/usr/bin/open ${forShell(musicURL)}`)
        .catch((e) => {
            console.error(`[hs_appleMusic-gt] could not open ${musicURL}: ${e}`)
            alert("Could not open the album in Music")
        })
}

/**
 * Play an album from the list, by URL or by name.
 *
 * @param {object} entry From `readAlbums`.
 * @returns {object} The Spoon. A named album is looked up first, so playing begins later.
 */
function playEntry(entry) {
    if (!entry) return module.exports

    // A URL needs no lookup: it already names one album exactly.
    if (entry.kind === "url") {
        openAlbumURL(entry.url)
        pressPlayWhenReady(entry.label)
        return module.exports
    }
    return playAlbum(entry.band, entry.album)
}

/**
 * Play an album by name, whether or not it is in the library.
 *
 * @param {string} band
 * @param {string} album
 * @returns {object} The Spoon. The playing happens later: the album is looked up, its page
 *          is opened, and the Play button is pressed once it has rendered.
 */
function playAlbum(band, album) {
    if (!band || !album) {
        alert("playAlbum needs a band and an album")
        return module.exports
    }

    resolveAlbum(band, album).then((found) => {
        if (!found) return
        openAlbumURL(found.url)
        pressPlayWhenReady(`${found.artist} — ${found.name}`)
    }).catch((e) => {
        // A throw inside a then() is otherwise swallowed by the promise, which is what
        // made the first failure here look like nothing happening at all.
        console.error(`[hs_appleMusic-gt] playing ${band} — ${album} failed: ${e}`)
        alert(`Could not play ${band} — ${album}`)
    })

    return module.exports
}

// MARK: - Auto-play
//
// Starts a random album whenever Music has stopped. A paused Music is left alone: pausing
// is a decision, stopping is the end of an album.

function autoPlayTick() {
    const state = playerState()
    if (state !== "stopped" && state !== "not running") return

    const choice = pickRandomAlbum()
    if (!choice) {
        alert(`Auto-play off: no albums in ${config.albumListPath}`)
        stopAutoPlay()
        return
    }

    alert(`Auto-play: ${describeEntry(choice)}`)
    playEntry(choice)
}

/** Start the watcher. Checks at once rather than waiting out the first interval. */
function startAutoPlay() {
    if (autoPlayTimer) return false
    autoPlayTimer = hs.timer.doEvery(config.autoPlayInterval, () => autoPlayTick())
    autoPlayTick()
    return true
}

function stopAutoPlay() {
    if (!autoPlayTimer) return false
    autoPlayTimer.stop()
    autoPlayTimer = null
    return true
}

function isAutoPlayEnabled() {
    return autoPlayTimer !== null
}

/** Turn auto-play on or off, and say which it now is. */
function toggleAutoPlay() {
    const enabled = isAutoPlayEnabled() ? !stopAutoPlay() : startAutoPlay()
    alert(`Auto-play ${enabled ? "on" : "off"}`)
    return enabled
}

// MARK: - Lifecycle

/** Bring Music forward, launching it if it is not running. */
function focus() {
    hs.application.launchOrFocus(MUSIC_BUNDLE_ID)
    return module.exports
}

/** Report a missing album list, which is the one thing that silently does nothing. */
function start() {
    if (!hs.fs.exists(config.albumListPath)) {
        console.error(`[hs_appleMusic-gt] no album list at ${config.albumListPath}`)
    }
    return module.exports
}

/** Stop auto-play and abandon any skip or Play button still being waited for. */
function stop_() {
    stopAutoPlay()
    stopAlbumSkip()
    stopWaitingForPlayButton()
    return module.exports
}

module.exports = {
    config,
    // Playback.
    isRunning,
    playerState,
    isPlaying,
    togglePlayPause,
    play,
    stop,
    nextTrack,
    previousTrack,
    nextAlbum,
    previousAlbum,
    // What is playing.
    currentTrack,
    getCurrentTrack,
    getCurrentArtist,
    getCurrentAlbum,
    showCurrentTrack,
    // Volume.
    getVolume,
    showVolume,
    setVolume,
    adjustVolume,
    // Albums.
    readAlbums,
    pickRandomAlbum,
    resolveAlbum,
    playAlbum,
    playEntry,
    playRandomAlbum,
    chooseAlbum,
    addCurrentAlbum,
    // Auto-play.
    startAutoPlay,
    stopAutoPlay,
    toggleAutoPlay,
    isAutoPlayEnabled,
    // Lifecycle.
    focus,
    start,
    stop: stop_
}
