console.log("Hey I'm an init.js");

hs.ipc.start();

// hs_interactive-gt provides use(), so it is loaded first and directly. Every Spoon after
// it is loaded by one use() call, which also applies its settings, defines its commands
// and binds its keys. Skip one with `disabled: true` and reload.
const interactive = hs.loadSpoon("hs_interactive-gt");

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
            doc: "Start a countdown ending at a time of day, as hh:mm.",
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
    //     keys: { "alt t": "clock-show" }
    config: {
        format: "Every second counts:\n%a %d %b %X",
        textSize: 75,
        showDuration: 3,
        width: "full"
    },
    commands: (interactive, clock) => {
        interactive.define({
            name: "clock-show",
            doc: "Show the clock for a few seconds.",
            fn: () => clock.toggleShow()
        });

        interactive.define({
            name: "clock-show-persistent",
            doc: "Show the clock until it is dismissed with Escape.",
            fn: () => clock.toggleShowPersistent()
        });

        interactive.define({
            name: "clock-hide",
            doc: "Hide the clock.",
            fn: () => clock.hide()
        });

        interactive.define({
            name: "clock-set-format",
            doc: "Change the clock's time format, in strftime terms such as %H:%M:%S.",
            interactive: [{ name: "format", reader: interactive.readers.string.prompted, default: "%H:%M" }],
            fn: (format) => {
                clock.config.format = format;
                return clock.formatTime(format);
            }
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

// Window commands. Built on the Swift-side API rather than the helpers in hs.window.js
// (hs.window.maximize and friends), which are erased by the first garbage collection and
// hardcode a 1920x1080 screen besides. Not a Spoon, so they are defined directly.
const place = (win, fraction) => {
    const screen = win.screen.frame;
    win.frame = new HSRect(
        screen.x + (fraction.x === undefined ? 0 : fraction.x) * screen.w,
        screen.y,
        fraction.w * screen.w,
        screen.h
    );
    return true;
};

interactive.define({
    name: "window-maximize",
    doc: "Fill the screen with a window.",
    interactive: [{ name: "window", reader: interactive.readers.window.auto }],
    fn: (win) => place(win, { x: 0, w: 1 })
});

interactive.define({
    name: "window-left-half",
    doc: "Move a window to the left half of its screen.",
    interactive: [{ name: "window", reader: interactive.readers.window.auto }],
    fn: (win) => place(win, { x: 0, w: 0.5 })
});

interactive.define({
    name: "window-right-half",
    doc: "Move a window to the right half of its screen.",
    interactive: [{ name: "window", reader: interactive.readers.window.auto }],
    fn: (win) => place(win, { x: 0.5, w: 0.5 })
});

interactive.define({
    name: "window-center",
    doc: "Centre a window on its screen, keeping its size.",
    interactive: [{ name: "window", reader: interactive.readers.window.auto }],
    fn: (win) => win.centerOnScreen()
});

interactive.define({
    name: "window-toggle-fullscreen",
    doc: "Enter or leave fullscreen for a window.",
    interactive: [{ name: "window", reader: interactive.readers.window.auto }],
    fn: (win) => win.toggleFullscreen()
});

interactive.define({
    name: "window-minimize",
    doc: "Minimize a window.",
    interactive: [{ name: "window", reader: interactive.readers.window.auto }],
    fn: (win) => win.minimize()
});

interactive.define({
    name: "window-focus",
    doc: "Choose a window by title and focus it.",
    interactive: [{ name: "window", reader: interactive.readers.window.prompted }],
    fn: (win) => win.focus()
});

interactive.define({
    name: "window-move-to-screen",
    doc: "Move a window to a chosen screen, keeping its relative position and size.",
    interactive: [
        { name: "window", reader: interactive.readers.window.auto },
        { name: "screen", reader: interactive.readers.screen.prompted }
    ],
    fn: (win, screen) => {
        const from = win.screen.frame;
        const to = screen.frame;
        const f = win.frame;
        win.frame = new HSRect(
            to.x + ((f.x - from.x) / from.w) * to.w,
            to.y + ((f.y - from.y) / from.h) * to.h,
            Math.min(f.w * (to.w / from.w), to.w),
            Math.min(f.h * (to.h / from.h), to.h)
        );
        return true;
    }
});

interactive.define({
    name: "paste",
    doc: "Send cmd-v to the focused application.",
    fn: () => hs.eventtap.keyStroke(["cmd"], "v")
});

interactive.define({
    name: "window-info",
    doc: "Show the title, application, screen and frame of a window.",
    interactive: [{ name: "window", reader: interactive.readers.window.auto }],
    fn: (win) => {
        const f = win.frame;
        const text = `${interactive.describe(win)}\n${win.screen.name}  ${f.w}×${f.h} at ${f.x},${f.y}`;
        hs.ui.alert(text).duration(4).show();
        console.log("[window-info] " + text.replace("\n", " · "));
        return text;
    }
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
