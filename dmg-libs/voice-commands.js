// Running Hammerspoon commands by voice, as a processor for hs_whisper-gt.
//
// A dictation is matched against two things, in this order:
//
// 1. PHRASES, short spoken forms such as "volume up". Each names a command and the
//    arguments to give it.
// 2. Every command defined with hs_interactive-gt, by its name spoken as words. "Window next
//    screen" runs window-next-screen, and "apple music play pause" runs
//    appleMusic-play-pause.
//
// The command is run the way the command chooser runs it. A parameter whose reader uses the
// focused window takes the window that had focus when the dictation ended, and a parameter
// whose reader needs input opens its prompt.

// Spoken phrase → {command, args}. The phrase is written the way phraseNormalize() leaves
// a dictation: lowercase, without punctuation, with single spaces.
const PHRASES = {
    // The command chooser, for choosing a command by hand.
    "commands": { command: "commands-execute" },
    "play": { command: "appleMusic-play" },
    "stop": { command: "appleMusic-pause" },
    "volume up": { command: "system-volume-adjust", args: [10] },
    "volume down": { command: "system-volume-adjust", args: [-10] },
    "emacs": { command: "window-select-emacs" }
}

/**
 * The dictation as lowercase words separated by single spaces. Whisper adds capitals and a
 * full stop even to a single word, and may write a command name with hyphens or with
 * spaces, so all of that is removed.
 */
function phraseNormalize(text) {
    return String(text)
        .toLowerCase()
        .replace(/[^\p{L}\p{N}\s]/gu, " ")
        .replace(/\s+/g, " ")
        .trim()
}

/**
 * The command whose name, without its hyphens, is the phrase without its spaces.
 *
 * Spaces and hyphens are both removed before comparing, because a name such as
 * appleMusic-play-pause is spoken as "apple music play pause".
 */
function commandFindByWords(interactive, phrase) {
    const wanted = phrase.replace(/ /g, "")
    const found = interactive.commands("alphabetic")
        .find((command) => command.name.toLowerCase().replace(/-/g, "") === wanted)
    return found ? { command: found.name } : null
}

/**
 * The command a dictation names, without running it.
 *
 * @param {object} interactive The hs_interactive-gt Spoon.
 * @param {string} text The transcription.
 * @returns {{command: string, args: ?Array}} The command and any arguments.
 * @throws {Error} When nothing matches, so that hs_whisper-gt reports it as a failure.
 */
function voiceCommandFind(interactive, text) {
    const phrase = phraseNormalize(text)
    if (!phrase) throw new Error("nothing was said")

    const found = PHRASES[phrase] || commandFindByWords(interactive, phrase)
    if (!found) throw new Error(`no command matches "${phrase}"`)
    if (!interactive.get(found.command)) {
        throw new Error(`"${phrase}" names ${found.command}, which is not defined`)
    }
    return found
}

/**
 * Run the command a dictation names.
 *
 * The command is started and not awaited. A command whose reader opens a prompt finishes
 * only when the prompt is answered, and the dictation should not wait for that.
 *
 * @param {object} interactive The hs_interactive-gt Spoon.
 * @param {string} text The transcription.
 * @returns {string} The name of the command that was started.
 * @throws {Error} When nothing matches, as voiceCommandFind().
 */
function voiceCommandRun(interactive, text) {
    const found = voiceCommandFind(interactive, text)
    Promise.resolve(interactive.callInteractively(found.command, { args: found.args || [] }))
        .catch((e) => console.error(`[voice-commands] ${found.command} failed: ${e.message}`))
    return found.command
}

module.exports = {
    PHRASES,
    phraseNormalize,
    voiceCommandFind,
    voiceCommandRun
}
