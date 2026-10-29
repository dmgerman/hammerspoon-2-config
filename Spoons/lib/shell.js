// Running external commands, resolving to one result shape. Shared by the Spoons in this
// directory, which load it with require(__dirname + "/../lib/shell.js").
//
// Nothing here rejects. A command that cannot be started, or that exits non-zero, resolves
// with a non-zero `code` and whatever output arrived, so a caller reads one shape in all
// cases. That also avoids hs.task.runAsync's rejection shape, which is the result object
// rather than an Error — `e.message` on it is undefined, so a conventional catch logs
// nothing useful.
//
// This module began as a workaround for upstream #267: hs.task kept no reference to a
// running task, so a garbage collection killed the child and left hs.task.shell()'s promise
// pending for good. That was fixed in 58f4e39f, which keeps a running task alive until it
// terminates, so tasks are no longer held here.

/**
 * Run a command, resolving to its output and exit code.
 *
 * @param {string} launchPath The executable, as `/usr/bin/open`.
 * @param {string[]} args Passed as an argument list, so nothing needs shell quoting.
 * @returns {Promise<{out: string, err: string, code: number}>} Never rejects. `code` is -1
 *   when the task could not be created at all.
 */
function commandRun(launchPath, args) {
    return new Promise((resolve) => {
        let out = ""
        let err = ""

        const task = hs.task.create(launchPath, args || [],
            (code) => {
                resolve({out: out, err: err, code: code})
            },
            null,
            (kind, chunk) => {
                if (kind === "stdout") out += chunk
                else if (kind === "stderr") err += chunk
            })

        if (!task) {
            resolve({out: "", err: `could not start ${launchPath}`, code: -1})
            return
        }

        task.start()
    })
}

/**
 * Run a command, writing `input` to its standard input, and resolve as `commandRun` does.
 *
 * For a filter: a command that reads text on stdin and writes the result to stdout. The
 * input is sent as soon as the task starts and stdin is then closed, which is what makes a
 * command that reads to end-of-input finish at all.
 *
 * @param {string} launchPath The executable.
 * @param {string[]} args Passed as an argument list.
 * @param {string} input Written to the command's standard input.
 * @returns {Promise<{out: string, err: string, code: number}>} Never rejects, as `commandRun`.
 */
function commandRunInput(launchPath, args, input) {
    return new Promise((resolve) => {
        let out = ""
        let err = ""

        const task = hs.task.create(launchPath, args || [],
            (code) => {
                resolve({out: out, err: err, code: code})
            },
            null,
            (kind, chunk) => {
                if (kind === "stdout") out += chunk
                else if (kind === "stderr") err += chunk
            })

        if (!task) {
            resolve({out: "", err: `could not start ${launchPath}`, code: -1})
            return
        }

        task.start()
        task.sendInput(input)
        task.closeInput()
    })
}

/**
 * Start a long-running command and return it.
 *
 * For a command that outlives the call: a server that is sent requests and answers them,
 * rather than one that is run for an answer. `commandRun` is the wrong shape for that --
 * it resolves only once the command has exited, which this kind never does until told to.
 *
 * @param {string} launchPath The executable.
 * @param {string[]} args Passed as an argument list.
 * @param {object} [handlers]
 * @param {function} [handlers.onOutput] Called as `(kind, chunk)` for each piece of output,
 *   where `kind` is "stdout" or "stderr". Chunks are whatever the pipe delivers, so a
 *   caller reading lines must join them itself.
 * @param {function} [handlers.onExit] Called as `(code)` when the command exits.
 * @returns {?object} The task, for `sendInput`, `terminate` and `isRunning`, or null if it
 *   could not be started.
 */
function commandStart(launchPath, args, handlers) {
    const options = handlers || {}

    const task = hs.task.create(launchPath, args || [],
        (code) => {
            if (options.onExit) options.onExit(code)
        },
        null,
        (kind, chunk) => {
            if (options.onOutput) options.onOutput(kind, chunk)
        })

    if (!task) return null

    task.start()
    return task
}

/**
 * Run a shell command, resolving to its output and exit code.
 *
 * The replacement for `hs.task.shell()`. Use `commandRun` instead when the arguments are
 * already a list, so that quoting cannot be got wrong.
 *
 * @param {string} command Passed to `/bin/sh -c`, so pipes and redirection work.
 * @returns {Promise<{out: string, err: string, code: number}>} Never rejects.
 */
function shellRun(command) {
    return commandRun("/bin/sh", ["-c", command])
}

/**
 * Run a command for its effect, reporting a failure on the console.
 *
 * For the `open -a ...` calls that have no output worth reading. The promise is returned
 * for a caller that wants to wait, and can be ignored.
 *
 * @param {string} label Names the caller in the error, as "hs_appleMusic-gt".
 * @param {string} command Passed to `/bin/sh -c`.
 * @returns {Promise<boolean>} Whether the command exited zero.
 */
function shellRunLogging(label, command) {
    return shellRun(command).then((result) => {
        if (result.code === 0) return true
        const detail = (result.err || result.out || "").trim()
        console.error(`[${label}] command failed (exit ${result.code})` +
            (detail ? `: ${detail}` : "") + `: ${command}`)
        return false
    })
}

module.exports = {
    commandRun: commandRun,
    commandRunInput: commandRunInput,
    commandStart: commandStart,
    shellRun: shellRun,
    shellRunLogging: shellRunLogging
}
