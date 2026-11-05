// Reading credentials from ~/.authinfo.gpg, the file Emacs's auth-source reads. Shared by
// the Spoons in this directory, which load it with
// require(hs.appinfo.configDir + "/Spoons/lib/authinfo.js").
//
// The file is in netrc format, one entry per line:
//
//     machine api.deepl.com login apikey password 0123-abcd
//
// It is decrypted with gpg each time it is read. gpg asks gpg-agent for the passphrase, so
// the first read after the agent has forgotten it shows the pinentry dialog. Nothing
// decrypted is kept here: a caller that wants to avoid asking again keeps the password
// itself.

const shell = require(hs.appinfo.configDir + "/Spoons/lib/shell.js")

const config = {
    file: hs.fs.pathToAbsolute("~/.authinfo.gpg"),
    gpg: "/opt/homebrew/bin/gpg"
}

/**
 * Split netrc text into its words. A word in double quotes may hold spaces.
 *
 * @param {string} text
 * @returns {string[]}
 */
function words(text) {
    const result = []
    const pattern = /"((?:[^"\\]|\\.)*)"|(\S+)/g
    let match
    while ((match = pattern.exec(text)) !== null) {
        result.push(match[1] !== undefined ? match[1].replace(/\\(.)/g, "$1") : match[2])
    }
    return result
}

/**
 * Parse netrc text into its entries.
 *
 * @param {string} text
 * @returns {object[]} One object per `machine`, with the keys that followed it, as
 *   `{machine, login, password, port}`.
 */
function parse(text) {
    const entries = []
    const tokens = words(text)
    let entry = null
    for (let at = 0; at < tokens.length; at++) {
        const key = tokens[at]
        if (key === "machine" || key === "default") {
            entry = key === "default" ? { machine: null } : { machine: tokens[++at] }
            entries.push(entry)
            continue
        }
        if (entry) entry[key] = tokens[++at]
    }
    return entries
}

/**
 * The password of an entry in the authinfo file.
 *
 * @param {string} machine The entry's `machine`.
 * @param {string} [login] Its `login`, when the file has several entries for the machine.
 * @returns {Promise<string>} The password. Rejects when the file cannot be decrypted, or
 *   holds no matching entry; the error names the entry but never a password.
 */
async function password(machine, login) {
    const file = config.file
    const result = await shell.commandRun(config.gpg, ["--quiet", "--no-tty", "--decrypt", file])
    if (result.code !== 0) {
        throw new Error(`could not decrypt ${file}: ${(result.err || "").trim()}`)
    }

    const entry = parse(result.out).find((candidate) =>
        candidate.machine === machine && (!login || candidate.login === login))
    if (!entry || !entry.password) {
        const who = login ? `machine ${machine} login ${login}` : `machine ${machine}`
        throw new Error(`no password for ${who} in ${file}`)
    }
    return entry.password
}

module.exports = {
    config,
    parse,
    password
}
