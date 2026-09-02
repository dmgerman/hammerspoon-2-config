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

;; The Hammerspoon 2 counterpart of the hs_emacs-gt Spoon.
;;
;; Two things differ from the Hammerspoon 1 version, and both follow from
;; Hammerspoon 2 rather than from choice:
;;
;;   - Commands are JavaScript, not Lua.
;;   - The command line client reads from standard input; it has no -c option.
;;
;; Hammerspoon must have run `hs.ipc.start()`, and the client must be installed:
;; `hs.ipc.installBinary("/usr/local/bin")` from the Hammerspoon console.

;;; Code:

(defcustom hammerspoon-binary-names '("hs2" "hs")
  "Names to look for, in order, when finding the Hammerspoon client."
  :type '(repeat string)
  :group 'hammerspoon)

(defcustom hammerspoon-spoon "hs_emacs-gt"
  "Name of the Spoon that answers these calls."
  :type 'string
  :group 'hammerspoon)

(defun hammerspoon-binary ()
  "Return the path of the Hammerspoon client, or nil when there is none."
  (seq-some #'executable-find hammerspoon-binary-names))

(defun hammerspoon-do (command)
  "Send Hammerspoon the JavaScript COMMAND, without waiting for a result."
  (interactive "sHammerspoon command: ")
  (let ((binary (hammerspoon-binary)))
    (if (not binary)
        (message "Hammerspoon client not found. Run hs.ipc.installBinary() in Hammerspoon")
      (condition-case err
          ;; The command goes on standard input: the Hammerspoon 2 client has no
          ;; -c option. 0 as DESTINATION runs it without waiting.
          (call-process-region command nil binary nil 0 nil "--no-prompt")
        (error (message "hammerspoon-do error: %s" (error-message-string err)))))))

(defun hammerspoon-do-capture (command)
  "Send Hammerspoon the JavaScript COMMAND and return its output as a string."
  (let ((binary (hammerspoon-binary)))
    (unless binary
      (error "Hammerspoon client not found"))
    (with-temp-buffer
      (call-process-region command nil binary nil t nil "--no-prompt")
      (string-trim (buffer-string)))))

(defun hammerspoon-spoon-call (form)
  "Return JavaScript calling FORM on the hs_emacs-gt Spoon."
  (format "hs.spoons[\"%s\"].%s" hammerspoon-spoon form))

(defun hammerspoon-alert (message &optional duration)
  "Show MESSAGE on screen through Hammerspoon for DURATION seconds (default 5)."
  (hammerspoon-do
   (format "hs.ui.alert(%S).duration(%d).show()" message (or duration 5))))

(defun hammerspoon-message (message &optional duration)
  "Show MESSAGE through the Spoon's own display for DURATION seconds."
  (hammerspoon-do
   (hammerspoon-spoon-call (format "message(%S, %s)" message (or duration "undefined")))))

(defun hammerspoon-status (message)
  "Show MESSAGE in the menu bar until it is cleared."
  (hammerspoon-do (hammerspoon-spoon-call (format "setStatus(%S)" message))))

(defun hammerspoon-status-clear ()
  "Return the menu bar to its resting state."
  (interactive)
  (hammerspoon-do (hammerspoon-spoon-call "clearStatus()")))

(defun hammerspoon-test ()
  "Show a test message, to check that Emacs can reach Hammerspoon."
  (interactive)
  (hammerspoon-alert "Hammerspoon test message..."))

(defun hammerspoon-emacs-everywhere-app-info ()
  "Return an `emacs-everywhere-app' built from the file Hammerspoon wrote."
  (let ((file "/tmp/emacs-everywhere.txt"))
    (unless (file-exists-p file)
      (error "emacs-everywhere: %s not found — Hammerspoon did not write window info" file))
    (let* ((raw (with-temp-buffer
                  (insert-file-contents file)
                  (string-trim (buffer-string))))
           (parts (split-string raw (regexp-quote "||") t)))
      (unless (>= (length parts) 6)
        (error "emacs-everywhere: malformed window info: %S" raw))
      (let ((win-id (nth 0 parts))
            (x      (string-to-number (nth 1 parts)))
            (y      (string-to-number (nth 2 parts)))
            (w      (string-to-number (nth 3 parts)))
            (h      (string-to-number (nth 4 parts)))
            (app    (nth 5 parts))
            (title  (string-join (nthcdr 6 parts) "||")))
        (message "emacs-everywhere: editing \"%s\" in %s (window %s)" title app win-id)
        (make-emacs-everywhere-app
         :id       win-id
         :class    app
         :title    title
         :geometry (list x y w h))))))

(defun hammerspoon-emacs-everywhere-finish ()
  "Send the buffer back to the window it came from and close the frame.
The text goes through the pasteboard; Hammerspoon pastes it."
  (interactive)
  (unless emacs-everywhere-mode
    (error "emacs-everywhere-mode is not active in this buffer"))
  (let* ((text (buffer-string))
         (window-id (emacs-everywhere-app-id emacs-everywhere-current-app)))
    (unless (equal text emacs-everywhere--contents)
      (kill-new text)
      (gui-select-text text)
      (hammerspoon-do
       (hammerspoon-spoon-call (format "endEditing(%s, false)" window-id))))
    (set-buffer-modified-p nil)
    (emacs-everywhere-mode -1)
    (server-buffer-done (current-buffer))))

(defun hammerspoon-emacs-everywhere-compositor (result)
  "Redirect emacs-everywhere's system detection, in RESULT, to Hammerspoon."
  (if (eq (car result) 'quartz)
      '(hammerspoon . nil)
    result))

(provide 'hammerspoon)
;;; hammerspoon.el ends here
