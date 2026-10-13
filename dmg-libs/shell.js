// Running external commands without losing them to a garbage collection.
//
// hs.task.shell() and hs.task.runAsync() keep no reference to the task they start, and
// nothing on the Swift side retains it either: hs.task's activeTasks is a
// Set<ObjectIdentifier>, which records identities and holds no references. So when a
// collection runs while the child is still alive, the task is destroyed, the child is sent
// SIGTERM, and the promise is neither resolved nor rejected for the lifetime of the process.
//
// Measured on 2026-10-07 against the app built from main after d55df50:
//
//   hs.task.shell("seq 1 200000")              never settled, in 4 runs of 4
//   this module's shellRun("seq 1 200000")     1288895 bytes, the exact output
//   this module's shellRun("seq 1 500000")     3388895 bytes
//
// Capturing output is what causes the collection: hs.task.runAsync accumulates output into
// JavaScript strings, so the more output there is to save, the likelier the capture is to
// destroy the task doing it. Commands producing little output fail at a lower rate rather
// than not at all — roughly one batch in eight, measured without forcing a collection.
//
// The fix is one reference. Every task started here is held in `running` from start() until
// its termination callback fires, so it cannot be collected while the child is alive.
// ai/issue_unfiled_task-gc.md has the full report; once hs.task retains running tasks
// itself, this module becomes a convenience rather than a workaround.
//
// Nothing here rejects. A command that cannot be started, or that exits non-zero, resolves
// with a non-zero `code` and whatever output arrived, so a caller reads one shape in all
// cases. That also avoids hs.task.runAsync's rejection shape, which is the result object
// rather than an Error — `e.message` on it is undefined, so a conventional catch logs
// nothing useful.

// Tasks that have started and not yet terminated. Module level, so a task outlives the
// function that started it.
const running = new Set()

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
                running.delete(task)
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

        running.add(task)
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
                running.delete(task)
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

        running.add(task)
        task.start()
        task.sendInput(input)
        task.closeInput()
    })
}

/**
 * Start a long-running command and return it, held until it exits.
 *
 * For a command that outlives the call: a server that is sent requests and answers them,
 * rather than one that is run for an answer. `commandRun` is the wrong shape for that --
 * it resolves only once the command has exited, which this kind never does until told to.
 *
 * The task is held for the same reason as everything else here, and that reason is more
 * acute for a long-lived one: the longer it runs, the likelier a collection reaches it.
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
            running.delete(task)
            if (options.onExit) options.onExit(code)
        },
        null,
        (kind, chunk) => {
            if (options.onOutput) options.onOutput(kind, chunk)
        })

    if (!task) return null

    running.add(task)
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

/** How many tasks are running, for checking that none are being leaked. */
function runningCount() {
    return running.size
}

module.exports = {
    commandRun: commandRun,
    commandRunInput: commandRunInput,
    commandStart: commandStart,
    shellRun: shellRun,
    shellRunLogging: shellRunLogging,
    runningCount: runningCount
}
