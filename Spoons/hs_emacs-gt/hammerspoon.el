;;; hammerspoon.el --- communicate with Hammerspoon 2 for hs_emacs-gt  -*- lexical-binding: t; -*-

;; Copyright (C) 2021-26 Daniel M. German <dmg@turingmachine.org>
;; Copyright (C) 2021 Jeremy Friesen <emacs@jeremyfriesen.com>

;; Author: Daniel M. German <dmg@turingmachine.org>
;;         Jeremy Friesen <emacs@jeremyfriesen.com>
;; Maintainer: Daniel M. German <dmg@turingmachine.org>
;; Keywords: hammerspoon, os x
;; Homepage: https://github.com/dmgerman/editWithEmacs.spoon

;; GNU Emacs is free software: you can redistribute it and/or modify
;; it under the terms of the GNU General Public License as published by
;; the Free Software Foundation, either version 3 of the License, or
;; (at your option) any later version.

;;; Commentary:

;; The Emacs side of the hs_emacs-gt Spoon.  Every call to Hammerspoon 2 from
;; Emacs goes through this file, so callers never have to write JavaScript:
;;
;;   `hammerspoon-alert'              an alert in the middle of the screen
;;   `hammerspoon-window-alert'       an alert over the focused window
;;   `hammerspoon-message'            the Spoon's own message display
;;   `hammerspoon-status'             text in the Spoon's menu bar item
;;   `hammerspoon-status-clear'       the menu bar item without text
;;   `hammerspoon-application-focus'  launch or bring forward an application
;;   `hammerspoon-unlock-seconds'     seconds since the screen was unlocked
;;
;; `hammerspoon-do' and `hammerspoon-execute' send any other JavaScript, and
;; Org source blocks in the language "hammerspoon" run in Hammerspoon 2.
;;
;; Editing another application's text field in Emacs is in
;; hammerspoon-emacs-everywhere.el, beside this file.
;;
;; The client, hs2, behaves in three ways that this file has to allow for:
;;
;;   1. It reads JavaScript from standard input, because it has no -c option.
;;   2. It evaluates that input one line at a time, so a command must be a
;;      single line.  `hammerspoon--js-string' quotes text so that it is.
;;   3. It prints "Connected to Hammerspoon 2" on standard output before the
;;      result, and prints JavaScript errors there too.  Only its exit status
;;      tells them apart: 0 on success, 1 when it could not reach
;;      Hammerspoon 2, and 65 when the JavaScript threw.
;;
;; Hammerspoon 2 must have run `hs.ipc.start()`, and the client must be
;; installed with `hs.ipc.installBinary()` from the Hammerspoon console.
;;
;; A Hammerspoon that does not answer must not stall Emacs, because the clock
;; code in dmg-org-helpers calls it once a minute.  So every call has a time
;; limit, and after `hammerspoon-failure-threshold' failures in a row the calls
;; stop for `hammerspoon-cooldown' seconds.  `hammerspoon-reset' resumes them.

;;; Code:

(require 'json)

(defgroup hammerspoon nil
  "Communicate with Hammerspoon 2."
  :group 'external)

(defcustom hammerspoon-binary "hs2"
  "The Hammerspoon 2 client: a name to find on `exec-path', or a full path.
This is not \"hs\", which is the Hammerspoon 1 client and runs Lua."
  :type 'string
  :group 'hammerspoon)

(defcustom hammerspoon-spoon "hs_emacs-gt"
  "Name of the Spoon that answers these calls."
  :type 'string
  :group 'hammerspoon)

(defcustom hammerspoon-timeout 2.0
  "Seconds `hammerspoon-execute' waits for a result before giving up."
  :type 'number
  :group 'hammerspoon)

(defcustom hammerspoon-async-timeout 10.0
  "Seconds after which a client started by `hammerspoon-do' is killed.
This stops one stuck client process accumulating per call while
Hammerspoon is not answering."
  :type 'number
  :group 'hammerspoon)

(defcustom hammerspoon-failure-threshold 3
  "Failed calls in a row after which calls stop for `hammerspoon-cooldown'."
  :type 'integer
  :group 'hammerspoon)

(defcustom hammerspoon-cooldown 300.0
  "Seconds to skip calls once `hammerspoon-failure-threshold' is reached.
When they have passed, one call is let through.  If it succeeds, calls
resume as normal."
  :type 'number
  :group 'hammerspoon)

;; Only `hammerspoon--note-failure', `hammerspoon--note-success' and
;; `hammerspoon-reset' write these two.
(defvar hammerspoon--consecutive-failures 0
  "Number of failed calls in a row.  Any success sets it back to 0.")

(defvar hammerspoon--paused-until nil
  "Time before which calls are skipped, or nil when they are not.")

(defconst hammerspoon--banner-regexp
  "\\`Connected to Hammerspoon 2\n?"
  "The line the client prints on standard output before any result.")

(defconst hammerspoon--colour-regexp "\e\\[[0-9;]*m"
  "A terminal colour code.  The client colours its banner and its errors.")

;;;; Sending JavaScript

(defun hammerspoon--js-string (text)
  "Return TEXT as a JavaScript string literal on a single line."
  (json-encode-string text))

(defun hammerspoon--spoon-call (form)
  "Return JavaScript calling FORM on the hs_emacs-gt Spoon."
  (format "hs.spoons[%s].%s" (hammerspoon--js-string hammerspoon-spoon) form))

(defun hammerspoon-available-p ()
  "Return non-nil unless calls are paused after repeated failures."
  (or (null hammerspoon--paused-until)
      (not (time-less-p (current-time) hammerspoon--paused-until))))

(defun hammerspoon--note-failure (command)
  "Record that COMMAND failed, and pause calls once the threshold is reached.
Warn only when the pause begins, not on every call after it."
  (setq hammerspoon--consecutive-failures (1+ hammerspoon--consecutive-failures))
  (when (>= hammerspoon--consecutive-failures hammerspoon-failure-threshold)
    (let ((was-paused hammerspoon--paused-until)
          (minutes (round (/ hammerspoon-cooldown 60))))
      (setq hammerspoon--paused-until (time-add (current-time) hammerspoon-cooldown))
      (unless was-paused
        (display-warning
         'hammerspoon
         (format "Hammerspoon 2 is not answering (%d failed calls in a row; the last was: %s).

Emacs will not call it for %d minutes, so that it cannot stall this
session.  Menu bar clock updates and alerts are off until then.

Check that Hammerspoon 2 is running and that its init.js calls
hs.ipc.start().  Then run `M-x hammerspoon-reset' to resume at once
instead of waiting."
                 hammerspoon--consecutive-failures command minutes)
         :warning)
        (message "[hammerspoon] not answering; calls paused for %d min (M-x hammerspoon-reset)"
                 minutes)))))

(defun hammerspoon--note-success ()
  "Record that a call succeeded, and resume calls if they were paused."
  (when hammerspoon--paused-until
    (message "[hammerspoon] answering again; calls resumed"))
  (setq hammerspoon--consecutive-failures 0)
  (setq hammerspoon--paused-until nil))

(defun hammerspoon-reset ()
  "Resume calls to Hammerspoon now, instead of waiting out the pause."
  (interactive)
  (setq hammerspoon--consecutive-failures 0)
  (setq hammerspoon--paused-until nil)
  (message "[hammerspoon] calls resumed"))

(defun hammerspoon--output (buffer)
  "Return what the client printed into BUFFER, without its banner line."
  (with-current-buffer buffer
    (let ((plain (replace-regexp-in-string hammerspoon--colour-regexp "" (buffer-string))))
      (string-trim (replace-regexp-in-string hammerspoon--banner-regexp "" plain)))))

(defun hammerspoon--start (command buffer sentinel)
  "Start the client, send it COMMAND, and return the process.
Its output goes to BUFFER and SENTINEL is called when it exits."
  (let ((proc (make-process :name "hammerspoon"
                            :buffer buffer
                            :command (list (executable-find hammerspoon-binary)
                                           "--no-prompt")
                            :connection-type 'pipe
                            :noquery t
                            :sentinel sentinel)))
    (process-send-string proc command)
    (process-send-eof proc)
    proc))

(defun hammerspoon--kill (proc)
  "Kill PROC and delete it, ignoring errors.  PROC may already have exited."
  (when (process-live-p proc)
    (ignore-errors (kill-process proc)))
  (ignore-errors (delete-process proc)))

(define-error 'hammerspoon-js-error "Hammerspoon")

(defun hammerspoon--finish (proc command)
  "Record the outcome of PROC, which ran COMMAND and has exited.
Return its output on success.  Signal an error when the JavaScript threw;
that is not counted as a failure to answer, because Hammerspoon did answer."
  (let ((status (process-exit-status proc))
        (output (hammerspoon--output (process-buffer proc))))
    (pcase status
      (0 (hammerspoon--note-success)
         output)
      ;; The data is the JavaScript message followed by the command.
      (65 (hammerspoon--note-success)
          (signal 'hammerspoon-js-error (list output command)))
      (_ (hammerspoon--note-failure command)
         (error "Hammerspoon client exited with status %d: %s" status output)))))

(defun hammerspoon--check-binary ()
  "Signal an error unless the client named by `hammerspoon-binary' exists."
  (unless (executable-find hammerspoon-binary)
    (error "Hammerspoon client %s not found. Run hs.ipc.installBinary() in Hammerspoon 2"
           hammerspoon-binary)))

(defun hammerspoon-do (command)
  "Send Hammerspoon the JavaScript COMMAND, without waiting for a result.
Does nothing while calls are paused.  When COMMAND throws, the error is
shown in the echo area."
  (interactive "sHammerspoon command: ")
  (condition-case err
      (progn
        (hammerspoon--check-binary)
        (when (hammerspoon-available-p)
          (let ((proc (hammerspoon--start
                       command
                       (generate-new-buffer " *hammerspoon*" t)
                       (lambda (proc _event)
                         (unless (process-live-p proc)
                           (unwind-protect
                               ;; A killed process was counted as a failure by
                               ;; the timer below, so it is not counted again.
                               (when (eq (process-status proc) 'exit)
                                 (condition-case err
                                     (hammerspoon--finish proc command)
                                   (error (message "%s" (error-message-string err)))))
                             (kill-buffer (process-buffer proc))))))))
            (run-at-time hammerspoon-async-timeout nil
                         (lambda ()
                           (when (process-live-p proc)
                             (hammerspoon--kill proc)
                             (hammerspoon--note-failure command)))))))
    (error (message "hammerspoon-do: %s" (error-message-string err)))))

(defun hammerspoon-execute (command &optional timeout)
  "Send Hammerspoon the JavaScript COMMAND and return its result as a string.
Return nil when Hammerspoon does not answer within TIMEOUT seconds, which
defaults to `hammerspoon-timeout', and at once while calls are paused.
Signal an error when the client is missing or COMMAND throws."
  (hammerspoon--check-binary)
  (when (hammerspoon-available-p)
    (with-temp-buffer
      (let ((proc (hammerspoon--start command (current-buffer) #'ignore))
            (deadline (time-add (current-time) (or timeout hammerspoon-timeout))))
        (while (and (process-live-p proc)
                    (time-less-p (current-time) deadline))
          (accept-process-output proc 0.05))
        (if (process-live-p proc)
            (progn
              (hammerspoon--kill proc)
              (hammerspoon--note-failure command)
              nil)
          (hammerspoon--finish proc command))))))

;;;; Showing things

(defun hammerspoon-alert (message &optional duration)
  "Show MESSAGE in the middle of the screen for DURATION seconds (default 5)."
  (hammerspoon-do
   (format "hs.ui.alert(%s).duration(%d).show()"
           (hammerspoon--js-string message) (or duration 5))))

(defun hammerspoon-window-alert (message &optional duration)
  "Show MESSAGE over the focused window for DURATION seconds (default 5)."
  (hammerspoon-do
   (hammerspoon--spoon-call
    (format "windowAlert(%s, %d)" (hammerspoon--js-string message) (or duration 5)))))

(defun hammerspoon-message (message &optional duration)
  "Show MESSAGE through the Spoon's own display for DURATION seconds.
Without DURATION, the Spoon's `config.message.duration' applies."
  (hammerspoon-do
   (hammerspoon--spoon-call
    (format "message(%s%s)" (hammerspoon--js-string message)
            (if duration (format ", %s" duration) "")))))

(defun hammerspoon-status (message)
  "Show MESSAGE in the Spoon's menu bar item until it is cleared."
  (hammerspoon-do
   (hammerspoon--spoon-call (format "setStatus(%s)" (hammerspoon--js-string message)))))

(defun hammerspoon-status-clear ()
  "Remove the text from the Spoon's menu bar item."
  (interactive)
  (hammerspoon-do (hammerspoon--spoon-call "clearStatus()")))

(defun hammerspoon-test ()
  "Show a test alert, to check that Emacs can reach Hammerspoon."
  (interactive)
  (hammerspoon-alert "Hammerspoon test message..."))

;;;; Asking things

(defun hammerspoon-application-focus (bundle-id)
  "Bring forward the application with BUNDLE-ID, launching it if it is not running.
Hammerspoon 2 finds applications by bundle ID, not by name: Anki is
\"net.ankiweb.anki\"."
  (hammerspoon-do
   (format "hs.application.launchOrFocus(%s)" (hammerspoon--js-string bundle-id))))

(defun hammerspoon-unlock-seconds ()
  "Return the seconds since the screen was last unlocked, or nil.
Return nil when Hammerspoon does not answer.  Until the first unlock is
seen, the Spoon counts from when it started."
  (let ((result (hammerspoon-execute (hammerspoon--spoon-call "unlockSeconds()"))))
    (and result
         (string-match-p "\\`[0-9.]+\\'" result)
         (string-to-number result))))

;;;; Org Babel

;; Source blocks in the language "hammerspoon" run in Hammerspoon 2:
;;
;;   #+begin_src hammerspoon
;;   hs.window.focusedWindow().title
;;   #+end_src
;;
;; ob-js cannot be pointed at hs2 for two reasons:
;;
;;   1. ob-js passes the block as a file name argument, and hs2 reads only
;;      standard input.
;;   2. For :results value, ob-js wraps the block in Node calls such as
;;      require('process'), which Hammerspoon 2 does not have.
;;
;; hs2 also evaluates one line at a time, so a block is sent as a single line:
;; its text, quoted as a JSON string, is passed to a global eval.  That eval
;; returns the value of the block's last expression.  While the block runs,
;; console.log is replaced so that what it prints can be returned for
;; :results output; it would otherwise go only to the Hammerspoon console.
;;
;; Because the eval is global, `var' and `function' definitions remain for later
;; blocks.  `const' and `let' do not: each block's eval gets its own scope for
;; them.  A Promise is returned as a Promise, not awaited.

(defcustom hammerspoon-babel-timeout 30.0
  "Seconds a \"hammerspoon\" source block may run before it is abandoned."
  :type 'number
  :group 'hammerspoon)

(defvar org-babel-default-header-args:hammerspoon '()
  "Default header arguments for \"hammerspoon\" source blocks.")

(declare-function org-babel--get-vars "ob-core" (params))

(defun hammerspoon--babel-command (body result-type)
  "Return a one-line JavaScript command that runs BODY.
The command returns the text of BODY's last value, or, when RESULT-TYPE
is `output', the lines BODY passed to console.log."
  (format "(() => {
  const text = v => typeof v === \"string\" ? v
    : v === undefined ? \"\"
    : (() => { try { return JSON.stringify(v, null, 2) ?? String(v) } catch (e) { return String(v) } })();
  const lines = [];
  const log = console.log;
  console.log = (...args) => { lines.push(args.map(text).join(\" \")) };
  try {
    const value = (0, eval)(%s);
    return %s ? lines.join(\"\\n\") : text(value);
  } finally {
    console.log = log;
  }
})()"
          (hammerspoon--js-string body)
          (if (eq result-type 'output) "true" "false")))

(defun org-babel-execute:hammerspoon (body params)
  "Run BODY, a \"hammerspoon\" source block, in Hammerspoon 2.
Each :var is defined as a global with `var' before BODY runs."
  (let* ((vars (mapconcat (lambda (pair)
                            (format "var %s = %s;\n" (car pair) (json-encode (cdr pair))))
                          (org-babel--get-vars params) ""))
         (command (hammerspoon--babel-command
                   (concat vars body)
                   (cdr (assq :result-type params))))
         ;; hs2 reads one line at a time, so the command must not contain a
         ;; line break.  `hammerspoon--js-string' has already escaped those in
         ;; BODY; these are the ones in the wrapper.
         (result (condition-case err
                     (hammerspoon-execute (replace-regexp-in-string "\n *" " " command)
                                          hammerspoon-babel-timeout)
                   ;; The command is the wrapper above, which tells the reader
                   ;; nothing, so report the JavaScript message alone.
                   (hammerspoon-js-error (error "Hammerspoon: %s" (cadr err))))))
    (or result
        (error "Hammerspoon did not answer within %s seconds" hammerspoon-babel-timeout))))

(defvar org-src-lang-modes)
(with-eval-after-load 'org-src
  (add-to-list 'org-src-lang-modes '("hammerspoon" . js)))

(provide 'hammerspoon)
;;; hammerspoon.el ends here
