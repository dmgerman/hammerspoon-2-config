console.log("Hey I'm an init.js");

hs.ipc.start();

// hs_interactive-gt provides use(), so it is loaded first and directly, by hs.loadSpoon(),
// which reads only from Spoons/. Every Spoon after it is loaded by one use() call, which
// searches the directories in interactive.searchPath and also applies the Spoon's
// settings, defines its commands and binds its keys. Skip one with `disabled: true` and
// reload.
const interactive = hs.loadSpoon("hs_interactive-gt");

// Two directories hold Spoons, and which one a Spoon is in records who it is for:
//
//   Spoons/     general use: written to be useful to anyone, and publishable as they are.
//   dmgSpoons/  this machine only: naming particular devices, accounts and files.
//
// hs_interactive-gt searches Spoons/ on its own, that being where Hammerspoon 2 looks.
// Which further directories exist is this configuration's business, so they are added here.
interactive.searchPath.push("dmgSpoons");

interactive.use("hs_countdown-gt", {
    config: {
        defaultLenMinutes: 25,
        alertSound: "Sonar"
    },
    commands: (interactive, countDown) => {
        interactive.define({
            name: "countdown-start",
            doc: "Start a countdown for the default number of minutes.",
            fn: () => countDown.startFor()
        });

        interactive.define({
            name: "countdown-start-for",
            doc: "Start a countdown for a given number of minutes.",
            interactive: [{ name: "minutes", reader: interactive.readers.number.prompted, default: 25 }],
            fn: (minutes) => countDown.startFor(minutes)
        });

        interactive.define({
            name: "countdown-start-until",
            doc: "Start a countdown ending at a time of day, as hh:mm on a 24-hour clock, or h:mm am / pm.",
            interactive: [{ name: "time", reader: interactive.readers.string.prompted, default: "10:30" }],
            fn: (time) => countDown.startUntil(time)
        });

        interactive.define({
            name: "countdown-pause-or-resume",
            doc: "Pause a running countdown, or resume a paused one.",
            fn: () => countDown.pauseOrResume()
        });

        interactive.define({
            name: "countdown-cancel",
            doc: "Cancel the running countdown.",
            fn: () => countDown.cancel()
        });

        interactive.define({
            name: "countdown-set-progress",
            doc: "Move the running countdown to a point in its progress, 0.0 to 1.0.",
            interactive: [{ name: "progress", reader: interactive.readers.number.prompted, default: 0.5 }],
            fn: (progress) => countDown.setProgress(progress)
        });
    }
});

interactive.use("hs_time-gt", {
    // Carried over from dmg_load_spoon_hs_time() in ~/.hammerspoon/dmg-functions.lua.
    // width was 1000 there to fit this format; "full" spans the screen instead, so it
    // cannot be truncated. In v1 this was on alt-t:
    //     keys: { "alt t": "time-show" }
    config: {
        format: "Every second counts:\n%a %d %b %X",
        textSize: 75,
        showDuration: 3,
        width: "full"
    },
    commands: (interactive, clock) => {
        interactive.define({
            name: "time-show",
            doc: "Show the clock for a few seconds.",
            fn: () => clock.toggleShow()
        });

        interactive.define({
            name: "time-show-persistent",
            doc: "Show the clock until it is dismissed with Escape.",
            fn: () => clock.toggleShowPersistent()
        });

        interactive.define({
            name: "time-hide",
            doc: "Hide the clock.",
            fn: () => clock.hide()
        });

        interactive.define({
            name: "time-set-format",
            doc: "Change the clock's time format, in strftime terms such as %H:%M:%S.",
            interactive: [{ name: "format", reader: interactive.readers.string.prompted, default: "%H:%M" }],
            fn: (format) => {
                clock.config.format = format;
                return clock.formatTime(format);
            }
        });
    }
});

// Collects what ~/.hammerspoon did in hs_network.spoon and the network_* functions of
// hs_annoyances.spoon. config.ignoredNetworks names the networks whose name is not worth
// announcing — home and the office; it is left empty until the announcements have been
// watched for a while.
interactive.use("hs_network-gt", {
    commands: (interactive, network) => {
        // Every threshold is per network, and the one to act on is the one in use. Reading
        // its name means running a Shortcut, so these commands return that promise.
        const forCurrentNetwork = (fn) => () =>
            network.networkName().then((name) => name ? fn(name) : "no network");

        interactive.define({
            name: "network-show-name",
            doc: "Show the name of the current network, whether or not it is ignored.",
            fn: () => network.networkNameShow(true)
        });

        interactive.define({
            name: "network-mute",
            doc: "Stop alerting about traffic on the current network. Its traffic is still counted.",
            fn: forCurrentNetwork((name) => network.networkMute(name))
        });

        interactive.define({
            name: "network-unmute",
            doc: "Alert about traffic on the current network again.",
            fn: forCurrentNetwork((name) => network.networkUnmute(name))
        });

        interactive.define({
            name: "network-set-delta",
            doc: "Alert every this many MB consumed on the current network, replacing its other thresholds. 0 stops the alerts.",
            interactive: [{ name: "megabytes", reader: interactive.readers.number.prompted, default: 100 }],
            fn: (megabytes) => network.networkName().then((name) => name
                ? network.thresholdsSet(name, { delta: megabytes > 0 ? megabytes * 1024 ** 2 : null })
                : "no network")
        });

        interactive.define({
            name: "network-set-cap",
            doc: "Alert once when this many MB have been consumed on the current network this session, replacing its other thresholds. 0 removes the cap.",
            interactive: [{ name: "megabytes", reader: interactive.readers.number.prompted, default: 1024 }],
            fn: (megabytes) => network.networkName().then((name) => name
                ? network.thresholdsSet(name, { absolute: megabytes > 0 ? [megabytes * 1024 ** 2] : [] })
                : "no network")
        });

        interactive.define({
            name: "network-alerts-pause-or-resume",
            doc: "Silence every traffic alert, or allow them again. Counting continues either way.",
            fn: () => network.alertsToggle()
        });

        interactive.define({
            name: "network-tracking-pause-or-resume",
            doc: "Freeze the traffic counters, or start counting again.",
            fn: () => network.trackingToggle()
        });

        interactive.define({
            name: "network-session-reset",
            doc: "Zero the counters for this connection. Cumulative totals are kept.",
            fn: () => network.sessionReset()
        });

        interactive.define({
            name: "network-cumulative-reset",
            doc: "Zero the cumulative total for a network, or for every network when left blank.",
            interactive: [{ name: "network", reader: interactive.readers.string.prompted, default: "" }],
            fn: (name) => network.cumulativeReset(name === "" ? null : name)
        });
    }
});

// Menus are defined once and displayed on any device: on screen by hs_menu-gt, and on the
// Stream Deck by hs_streamdeck-gt. Editing menus.js takes effect on the next reload.
const menus = require(hs.appinfo.configDir + "/menus.js");

// Switch to a Chrome tab rather than to Chrome. focusTabChrome.py lists Chrome's tabs,
// focuses the first whose URL or title contains what was asked for, and opens the address
// when none does. Chrome is raised afterwards, on a delay so it does not beat the script:
// focusing a tab selects it within Chrome without bringing Chrome forward, and macOS does
// not let an application that is not frontmost activate another one.
//
// PATH is set because the script runs under `env python3` and calls terminal-notifier,
// and Hammerspoon's shell does not read the profile that puts either on PATH.
const chromeTab = (() => {
    const script = "/Users/dmg/bin/focusTabChrome.py";
    const path = "/Users/dmg/.config/dmg/python/bin:/opt/homebrew/bin";
    const quote = (s) => "'" + String(s).replace(/'/g, "'\\''") + "'";
    let raiseTimer = null;

    return (field, match, fallback) => {
        const command = `PATH=${quote(path)}:"$PATH" ${quote(script)} ` +
            `${quote(field)} ${quote(match)} ${quote(fallback)}`;

        // Held: a timer with no reference left is garbage collected before it fires.
        raiseTimer = hs.timer.doAfter(0.4, () => {
            hs.application.launchOrFocus("com.google.Chrome");
        });

        return hs.task.shell(command).catch((e) => {
            console.error(`[chrome] ${field} ${match} failed: ${e && e.stderr ? e.stderr : e}`);
        });
    };
})();

interactive.define({
    name: "chrome-focus-url",
    doc: "Switch to the Chrome tab whose URL contains this, opening it if none does.",
    interactive: [{ name: "url", reader: interactive.readers.string.prompted, default: "https://" }],
    fn: (url) => chromeTab("url", url, "force")
});

interactive.define({
    name: "chrome-focus-title",
    doc: "Switch to the Chrome tab whose title contains this, opening a URL if none does.",
    interactive: [
        { name: "title", reader: interactive.readers.string.prompted },
        { name: "url", reader: interactive.readers.string.prompted, default: "https://" }
    ],
    fn: (title, url) => chromeTab("title", title, url)
});

// The Spoon runs elisp; which elisp is this configuration's business, so these commands
// live here rather than in a Spoon that is meant to be publishable.
interactive.use("hs_emacs-gt", {
    commands: (interactive, emacs) => {
        const elispCommand = (name, doc, elisp) => interactive.define({
            name: name,
            doc: doc,
            fn: () => emacs.executeAndRaise(elisp)
        });

        elispCommand("emacs-bookmarks", "Show the Emacs bookmarks.", "(bookmark-gt-list)");
        elispCommand("emacs-agenda", "Show the org agenda.", "(dmg-agenda)");
        elispCommand("emacs-daily", "Go to today's daily note.", "(dmg-goto-daily-today)");
        elispCommand("emacs-habits", "Show habits.", "(dmg-habits)");
        elispCommand("emacs-capture", "Capture an org-roam note.", "(org-roam-capture)");
        elispCommand("emacs-progress", "Record progress, without a link.",
                     "(call-interactively #'dmg-progress-no-link)");
        elispCommand("emacs-quick-todo", "Add a quick todo.", "(dmg-quick-todo)");

        interactive.define({
            name: "emacs-execute",
            doc: "Run elisp in Emacs and bring it forward.",
            interactive: [{ name: "elisp", reader: interactive.readers.string.prompted, default: "(message \"hello\")" }],
            fn: (elisp) => emacs.executeAndRaise(elisp)
        });

        interactive.define({
            name: "emacs-toggle-keys",
            doc: "Turn the keys forwarded to Emacs on or off.",
            fn: () => emacs.toggleAllKeys()
        });

        interactive.define({
            name: "emacs-edit-selection",
            doc: "Edit the selected text in Emacs, and paste the result back.",
            fn: () => emacs.editSelection()
        });

        interactive.define({
            name: "emacs-edit-all",
            doc: "Edit the whole of the focused text field in Emacs.",
            fn: () => emacs.editAll()
        });
    }
});

interactive.use("hs_appleMusic-gt", {
    commands: (interactive, music) => {
        const command = (name, doc, fn) => interactive.define({ name: name, doc: doc, fn: fn });

        command("appleMusic-play-pause", "Play or pause Apple Music.", () => music.togglePlayPause());
        command("appleMusic-next-track", "Skip to the next track.", () => music.nextTrack());
        command("appleMusic-previous-track", "Go back to the previous track.", () => music.previousTrack());
        command("appleMusic-next-album", "Skip forward to the next album.", () => music.nextAlbum());
        command("appleMusic-previous-album", "Skip back to the previous album.", () => music.previousAlbum());
        command("appleMusic-now-playing", "Show the track playing, and copy it.", () => music.showCurrentTrack());
        command("appleMusic-volume", "Show Apple Music's volume.", () => music.showVolume());
        command("appleMusic-focus", "Bring Apple Music forward.", () => music.focus());
        command("appleMusic-random-album", "Play a random album from the list.", () => music.playRandomAlbum());
        command("appleMusic-choose-album", "Choose an album from the list and play it.", () => music.chooseAlbum());
        command("appleMusic-add-current-album", "Add the album playing to the list.", () => music.addCurrentAlbum());
        command("appleMusic-toggle-auto-play", "Turn auto-play on or off.", () => music.toggleAutoPlay());

        interactive.define({
            name: "appleMusic-adjust-volume",
            doc: "Change Apple Music's volume by an amount, which may be negative.",
            interactive: [{ name: "delta", reader: interactive.readers.number.prompted, default: 10 }],
            fn: (delta) => music.adjustVolume(delta)
        });

        interactive.define({
            name: "appleMusic-set-volume",
            doc: "Set Apple Music's volume, 0 to 100.",
            interactive: [{ name: "level", reader: interactive.readers.number.prompted, default: 50 }],
            fn: (level) => music.setVolume(level)
        });

        interactive.define({
            name: "appleMusic-play-album",
            doc: "Play an album, given the band and the album.",
            interactive: [
                { name: "band", reader: interactive.readers.string.prompted },
                { name: "album", reader: interactive.readers.string.prompted }
            ],
            fn: (band, album) => music.playAlbum(band, album)
        });
    }
});

// Ported from dmg-url.lua. Loaded after hs_emacs-gt, which it reaches through hs.spoons
// for the "emacs" route and for add-video. Its start() claims http and https, so loading
// it is what puts Hammerspoon 2 in charge of links; url-restore-default-browser gives
// them back.
interactive.use("hs_url-gt", {
    commands: (interactive, url) => {
        interactive.define({
            name: "url-route-switch",
            doc: "Choose how URLs are routed, or stop handling them.",
            fn: () => url.switchRoute()
        });

        interactive.define({
            name: "url-route-emacs",
            doc: "Route URLs through Emacs browse-url, when Emacs is running.",
            fn: () => url.useEmacs()
        });

        interactive.define({
            name: "url-route-patterns",
            doc: "Route URLs by the pattern table.",
            fn: () => url.usePatterns()
        });

        interactive.define({
            name: "url-route-show",
            doc: "Report which route URLs are taking.",
            fn: () => {
                const state = url.route();
                const message = state.configured === state.effective
                    ? `URLs routed by ${state.effective}`
                    : `URLs routed by ${state.effective}, ${state.configured} is configured`;
                hs.ui.alert(message).duration(3).show();
                return state;
            }
        });

        interactive.define({
            name: "url-become-default-browser",
            doc: "Make Hammerspoon 2 the system handler for http and https.",
            fn: () => url.setAsDefaultBrowser()
        });

        interactive.define({
            name: "url-restore-default-browser",
            doc: "Give http and https back to the handler displaced earlier.",
            interactive: [{ name: "bundleID", reader: interactive.readers.string.prompted, optional: true, default: "org.hammerspoon.Hammerspoon" }],
            fn: (bundleID) => url.restoreDefaultBrowser(bundleID)
        });
    }
});

interactive.use("hs_hass-gt", {
    commands: (interactive, hass) => {
        interactive.define({
            name: "hass-office-brightness",
            doc: "Set the office dimmer to a brightness, 1 to 255.",
            interactive: [{ name: "brightness", reader: interactive.readers.number.prompted, default: 128 }],
            fn: (brightness) => hass.officeDimmerOn(brightness)
        });

        interactive.define({
            name: "hass-office-on",
            doc: "Switch the office dimmer on at its last brightness.",
            fn: () => hass.officeLightOn()
        });

        interactive.define({
            name: "hass-office-off",
            doc: "Switch the office dimmer off.",
            fn: () => hass.officeLightOff()
        });

        interactive.define({
            name: "hass-office-toggle",
            doc: "Toggle the office dimmer.",
            fn: () => hass.officeLightToggle()
        });

        interactive.define({
            name: "hass-teac-toggle",
            doc: "Toggle the Teac amplifier.",
            fn: () => hass.teacToggle()
        });

        interactive.define({
            name: "hass-teac-volume-up",
            doc: "Raise the Teac's volume by one step.",
            fn: () => hass.teacVolumeUp()
        });

        interactive.define({
            name: "hass-teac-volume-down",
            doc: "Lower the Teac's volume by one step.",
            fn: () => hass.teacVolumeDown()
        });

        interactive.define({
            name: "hass-marantz-toggle",
            doc: "Switch the Marantz on if it is off, and off if it is on.",
            fn: () => hass.marantzToggle()
        });

        interactive.define({
            name: "hass-marantz-select",
            doc: "Make the Marantz the default audio output, if it is on.",
            fn: () => hass.selectMarantz()
        });

        interactive.define({
            name: "hass-desk-amps-toggle",
            doc: "Toggle both desk amplifiers, the Marantz and the Teac.",
            fn: () => hass.deskAmpToggle()
        });
    }
});

interactive.use("hs_menu-gt", {
    commands: (interactive, menu) => {
        interactive.define({
            name: "menu-show",
            doc: "Show the main menu on screen, and dismiss it if it is showing.",
            fn: () => menu.toggleOnScreen(menus.rootMenu, { name: "Root" })
        });

        interactive.define({
            name: "menu-show-buses",
            doc: "Show the bus menu on screen.",
            fn: () => menu.toggleOnScreen(menus.busMenu, { name: "Buses" })
        });

        interactive.define({
            name: "menu-hide",
            doc: "Dismiss the on-screen menu.",
            fn: () => menu.hideScreen()
        });
    },

    // The same chord shows the menu and dismisses it, since menu-show toggles.
    keys: {
        "cmd-ctrl-alt z": "menu-show"
    }
});

// setMenu runs through `after`, which use() calls before the Spoon's start(), so every
// deck already has its menu by the time start() attaches to the hardware.
interactive.use("hs_streamdeck-gt", {
    after: (deck) => {
        deck.setMenu("A00NA33332Q8DH", menus.rootMenu, "Root");
        deck.setDefaultMenu(menus.rootMenu, "Root");
    }
});

// Every window operation lives in the Spoon, so that its undo history has one place
// through which all of them pass. A command here is a name and a docstring over it.
interactive.use("hs_window-gt", {
    commands: (interactive, win) => {
        // Most take the focused window, prompting only when there is none.
        const onWindow = (name, doc, fn) => interactive.define({
            name: name,
            doc: doc,
            interactive: [{ name: "window", reader: interactive.readers.window.auto }],
            fn: fn
        });

        onWindow("window-maximize", "Fill the screen with a window.", (w) => win.maximize(w));
        onWindow("window-left-half", "Move a window to the left half of its screen.", (w) => win.leftHalf(w));
        onWindow("window-right-half", "Move a window to the right half of its screen.", (w) => win.rightHalf(w));
        onWindow("window-top-half", "Move a window to the top half of its screen.", (w) => win.topHalf(w));
        onWindow("window-bottom-half", "Move a window to the bottom half of its screen.", (w) => win.bottomHalf(w));
        onWindow("window-left-third", "Move a window to the left third of its screen.", (w) => win.leftThird(w));
        onWindow("window-center-third", "Move a window to the middle third of its screen.", (w) => win.centerThird(w));
        onWindow("window-right-third", "Move a window to the right third of its screen.", (w) => win.rightThird(w));
        onWindow("window-left-two-thirds", "Move a window to the left two thirds of its screen.", (w) => win.leftTwoThirds(w));
        onWindow("window-right-two-thirds", "Move a window to the right two thirds of its screen.", (w) => win.rightTwoThirds(w));
        onWindow("window-top-left", "Move a window to the top left quarter of its screen.", (w) => win.topLeft(w));
        onWindow("window-top-right", "Move a window to the top right quarter of its screen.", (w) => win.topRight(w));
        onWindow("window-bottom-left", "Move a window to the bottom left quarter of its screen.", (w) => win.bottomLeft(w));
        onWindow("window-bottom-right", "Move a window to the bottom right quarter of its screen.", (w) => win.bottomRight(w));
        onWindow("window-center", "Centre a window on its screen, keeping its size.", (w) => win.center(w));

        onWindow("window-vertical-maximize", "Fill the screen's height, keeping the width.", (w) => win.verticalMaximize(w));
        onWindow("window-horizontal-maximize", "Fill the screen's width, keeping the height.", (w) => win.horizontalMaximize(w));
        onWindow("window-half-height", "Halve a window's height, keeping the top edge.", (w) => win.halfHeight(w));
        onWindow("window-half-width", "Halve a window's width, keeping the left edge.", (w) => win.halfWidth(w));

        onWindow("window-move-left", "Move a window left by its own width.", (w) => win.moveByOwnSize("left", w));
        onWindow("window-move-right", "Move a window right by its own width.", (w) => win.moveByOwnSize("right", w));
        onWindow("window-move-up", "Move a window up by its own height.", (w) => win.moveByOwnSize("up", w));
        onWindow("window-move-down", "Move a window down by its own height.", (w) => win.moveByOwnSize("down", w));

        onWindow("window-next-screen", "Move a window to the next screen.", (w) => win.moveToScreen("next", w));
        onWindow("window-previous-screen", "Move a window to the previous screen.", (w) => win.moveToScreen("previous", w));
        onWindow("window-swap", "Swap a window's position with the window behind it.", (w) => win.swapWithPrevious(w));
        onWindow("window-send-to-back", "Put a window behind all the others.", (w) => win.sendToBack(w));
        onWindow("window-center-mouse", "Put the pointer in the middle of a window.", (w) => win.centerMouse(w));
        onWindow("window-info", "Show the application, title, screen and frame of a window.", (w) => win.info(w));

        onWindow("window-toggle-fullscreen", "Enter or leave fullscreen for a window.", (w) => w.toggleFullscreen());
        onWindow("window-minimize", "Minimize a window.", (w) => w.minimize());

        interactive.define({
            name: "window-undo",
            doc: "Put a window back where it was. Again to go further back.",
            fn: () => win.undo()
        });

        interactive.define({
            name: "window-redo",
            doc: "Cancel a run of window-undo.",
            fn: () => win.redo()
        });

        interactive.define({
            name: "window-previous",
            doc: "Focus the window that had focus before this one.",
            fn: () => win.previousWindow()
        });

        interactive.define({
            name: "window-center-mouse-next",
            doc: "Put the pointer in the middle of the next window.",
            fn: () => win.centerMouseNext()
        });

        interactive.define({
            name: "window-toggle-isolation",
            doc: "Dim everything except the focused window, or stop dimming.",
            fn: () => win.toggleIsolation()
        });

        interactive.define({
            name: "window-fraction-width",
            doc: "Set a window's width to a fraction of the screen: 2 is half, 3 a third.",
            interactive: [
                { name: "denominator", reader: interactive.readers.number.prompted, default: 2 },
                { name: "window", reader: interactive.readers.window.auto }
            ],
            fn: (denominator, w) => win.fractionWidth(denominator, w)
        });

        interactive.define({
            name: "window-focus",
            doc: "Choose a window by title and focus it.",
            interactive: [{ name: "window", reader: interactive.readers.window.prompted }],
            fn: (w) => w.focus()
        });

        interactive.define({
            name: "window-move-to-screen",
            doc: "Move a window to a chosen screen, keeping its relative position and size.",
            interactive: [
                { name: "window", reader: interactive.readers.window.auto },
                // Moving to the screen it is already on is not a move, and a screen showing
                // a fullscreen window has no room for it.
                {
                    name: "screen",
                    reader: interactive.readers.screen.prompted,
                    includeCurrent: false,
                    includeFullscreen: false
                }
            ],
            fn: (w, screen) => {
                const from = w.screen.frame;
                const to = screen.frame;
                const f = w.frame;
                w.frame = new HSRect(
                    to.x + ((f.x - from.x) / from.w) * to.w,
                    to.y + ((f.y - from.y) / from.h) * to.h,
                    Math.min(f.w * (to.w / from.w), to.w),
                    Math.min(f.h * (to.h / from.h), to.h)
                );
                return true;
            }
        });
    }
});

interactive.define({
    name: "paste",
    doc: "Send cmd-v to the focused application.",
    fn: () => hs.eventtap.keyStroke(["cmd"], "v")
});

// Starting the screensaver locks the screen because this machine's screen-lock delay is
// immediate (`sysadminctl -screenLock status`); with a delay set it would only blank the
// screen. Hammerspoon 2 has no hs.caffeinate, and macOS 26 no longer ships the CGSession
// binary the older recipes used.
interactive.define({
    name: "screen-lock",
    doc: "Lock the screen.",
    fn: () => hs.task.shell("/usr/bin/open -a ScreenSaverEngine").catch((e) => {
        console.error(`[screen-lock] failed: ${e && e.stderr ? e.stderr : e}`);
    })
});


// Only the chooser gets a key while Hammerspoon 1 is still running: its hotkeys are
// registered system-wide and the two would fight over any chord bound in both.
interactive.setKeys({ "cmd-ctrl-alt x": "commands-execute" });

interactive.use.report();

console.log("Finished loading-------------------------");

// const hyper = ["⌘", "⌥", "⌃", "⇧"];

// function eventHandler(eventName, appObject) {
//     console.log("INIT.JS appWatcher eventHandler: " + eventName + " " + appObject.title);
// }

// hs.application.addWatcher("willLaunch", eventHandler);
// hs.application.addWatcher("didLaunch", eventHandler);
// hs.application.addWatcher("didTerminate", eventHandler);

// const safari = hs.application.matchingBundleID("com.apple.Safari");
// function handler(notification, element) {
//     console.log("AX event: " + notification + " on: " + element.title);
// }

// if (safari != null) {
//     hs.ax.addWatcher(safari, hs.ax.notificationTypes["windowCreated"], handler);
// }

// hs.hotkey.bind(hyper, "4", () => { console.log("HYPER 4"); }, null);
// hs.hotkey.bind(hyper, "5",
//                () => { console.log("HYPER 5 DOWN"); },
//                () => { console.log("HYPER 5 UP");   });
