# Hammerspoon2 Development Guide

## Overview

Hammerspoon2 is a replacement for Hammerspoon that uses **JavaScript instead of Lua**. It provides automation and window management capabilities for macOS.

## Documentation

**Main Documentation:** https://cmsj.github.io/Hammerspoon2/index.html

### Key API Pages

- **Module Index:** https://cmsj.github.io/Hammerspoon2/index.html
- **Window API:** https://cmsj.github.io/Hammerspoon2/hs.window.html
- **HSWindow Type:** https://cmsj.github.io/Hammerspoon2/HSWindow.html
- **Application API:** https://cmsj.github.io/Hammerspoon2/hs.application.html
- **HSApplication Type:** https://cmsj.github.io/Hammerspoon2/HSApplication.html
- **Hotkey API:** https://cmsj.github.io/Hammerspoon2/hs.hotkey.html
- **Accessibility API:** https://cmsj.github.io/Hammerspoon2/hs.ax.html

## Key Differences from Hammerspoon

1. **Language:** JavaScript (ES6+) instead of Lua
2. **Syntax:** Use modern JavaScript features (arrow functions, const/let, template literals)
3. **API Structure:** Similar to original Hammerspoon but adapted for JavaScript

## API changes to remember

Upstream renames do not throw: an old property name reads as `undefined`, so code that
uses one keeps running and quietly does the wrong thing. Use the current names:

| Old                          | Current                                        | Since      |
|------------------------------|------------------------------------------------|------------|
| `HSApplication.title`        | `HSApplication.name`                           | 2026-10-23 |
| `HSFont.customSize(name, n)` | `HSFont.custom(name, n)`                       | 2026-10-21 |
| `HSImage.copyImage()`        | `HSImage.duplicate()`                          | 2026-10-17 |

Behaviour that changed:

- `setAttributeValue()` and `performAction()` on an `hs.ax` element throw an `Error` when
  the Accessibility API refuses, with the AX error name in `err.code`. They used to return
  `false`. A value of the wrong type (a plain `{x, y}` for `AXPosition` instead of
  `new HSPoint(x, y)`) throws too.
- `hs.window.allWindows()`, `windowsForApp()` and `app.allWindows` include windows in native
  fullscreen and on other Spaces. Reading `AXMainWindow` directly is no longer needed.
- `hs.eventtap.keyStroke(mods, key, app)` sends a keystroke, modifiers included, to one
  application without activating it. Prefer it to activating the app and sending a global
  keystroke.
- Functions that return nothing give `null`, not `undefined`.
- `JSON.stringify()` shows the values of windows, applications, screens, colours and
  geometry objects, where it used to give `{}`.
- `hs.osascript` async scripts run in parallel and resolve in completion order; chain them
  when the order matters.

Newer capabilities worth knowing: `hs.canvas` with `imageFromCanvas()` for drawing images
offscreen, `HSWindow.snapshot()`, `hs.eventtap.systemKeyStroke()` for media keys,
`require('node:sqlite')`, `hs.dockicon.setMenu()` and `hs.onOpenFile`.

## Naming

Two conventions, and they do not mix. Ported Hammerspoon 1 code is renamed to match these
rather than keeping its Lua spelling.

| What | Style | Examples |
|------|-------|----------|
| Functions and variables | `camelCase` | `keyToWindowAttach`, `mouseScreenCenterNext`, `closedWindowsForget` |
| Spoon `config` keys | `camelCase` | `attachModifiers`, `screenshotDir`, `historySize` |
| Module-level constants | `UPPER_SNAKE` | `CANCEL`, `MUSIC_BUNDLE_ID`, `DELTA_PRESETS` |
| Command names | `hyphenated`, Emacs Lisp style | `window-attach-to-key`, `mouse-screen-center-next` |
| Spoon directories | `hs_<name>-gt` | `hs_window-gt` |

No underscores in function names.

### Subject first, action last

This governs every identifier, not just commands. The subject leads and the action follows:
`windowPrevious`, not `previousWindow`; `applicationWindowSelect`, not
`selectApplicationWindow`. Related names then sort together wherever they are listed — in the
chooser, in an editor's symbol list, in a file.

| Wrong                      | Right                      |
|----------------------------|----------------------------|
| `previousWindow()`         | `windowPrevious()`         |
| `selectApplicationWindow()`| `applicationWindowSelect()`|
| `attachKeyToWindow()`      | `keyToWindowAttach()`      |
| `forgetClosedWindows()`    | `closedWindowsForget()`    |
| `toggleOnScreen()`         | `onScreenToggle()`         |
| `newTab()`                 | `tabNew()`                 |

A preposition stays with the subject it belongs to rather than being moved to the end:
`keyToWindowAttach`, not `keyWindowToAttach` or `windowKeyAttach`. The whole subject phrase
comes first and the action closes the name.

### A command is named after the function it calls

Because both follow the same order, a command name is just its function's name in hyphenated
words, prefixed with the subject when the function name does not already carry it — the
Spoon's own name usually supplies it.

| Function          | Command                    |
|-------------------|----------------------------|
| `peek()`          | `menubar-peek`             |
| `peekHide()`      | `menubar-peek-hide`        |
| `windowPrevious()`| `window-previous`          |
| `historyShow()`   | `clipboard-show`           |

Dropping a word the Spoon's name already supplies is fine: `historyShow()` in
`hs_clipboard-gt` is `clipboard-show`, not `clipboard-history-show`.

**What may not change is the action.** A command may not claim to do something its function
does not, and a name may not claim behaviour the code does not have. Both of these were
wrong, for the same reason:

| Wrong                 | Was bound to    | Actually did                  |
|-----------------------|-----------------|-------------------------------|
| `menubar-peek`        | `peekToggle()`  | toggled, while the name said show |
| `menubar-peek-toggle` | `peekToggle()`  | hid itself after 4s, so not a toggle at all |

Rename the function and the command together when either changes.

## Writing

Comments, docstrings, readmes, issue drafts and conversation are all held to this.

**No metaphor or figurative framing.** Describe what the code or the system actually does.

**Plain is not the same as abstract.** The failure to watch for is removing a metaphor and
leaving vagueness behind. An abstraction reads as evasive in a way the metaphor did not, so
the text gets worse rather than better:

| Figurative                     | Abstract, and worse                                     | Right                                    |
|--------------------------------|---------------------------------------------------------|------------------------------------------|
| only one click gets through     | `can be clicked in one way that reaches JavaScript`     | `only a left click reaches the Spoon`    |
| the chunk that most wants showing | `the chunk whose display is most warranted`           | `the chunk that most needs to be shown`  |
| every audio application hiccups | `audio clients experience discontinuity`                | `every application using audio is interrupted briefly` |

**One thing per sentence.** Convoluted text is usually a single sentence in which every
clause qualifies the one before it, often ending in a counterfactual inside a counterfactual
(`there would be no menu to show if it were`). Split it. When there is more than one reason
for something, number them:

> A left click to start dictating, with a right click for everything else, would be better.
> It cannot be built in Hammerspoon 2, for three reasons:
>
> 1. A right click on a menu bar item never reaches the Spoon.
> 2. A left click cannot say which button it was.
> 3. Attaching a menu replaces the click action instead of adding to it.

**Lead with the fact, then the qualification.** Not the other way round, and not both woven
together.

**Write full sentences, not notes.** Brevity is not the goal; a human is going to read this.
Give each sentence its subject and verb rather than compressing it into a label and a colon,
and spell out what was done rather than leaving the reader to reconstruct it:

| Too compressed | Right |
|----------------|-------|
| `Clicked by hand: two left clicks, then one right click. Three clicks produced two callbacks:` | `I then clicked that menu bar item by hand three times: two left clicks, followed by one right click. Those three clicks produced only two callbacks, and both recorded exactly the same thing:` |
| `Not a defect, but it rules out keeping the callback and adding a menu.` | `This is simply how NSStatusItem works, so I am not reporting it as a defect. It does, however, rule out the obvious alternative, which would have been to keep the click callback and attach a menu alongside it.` |

This matters most in issue drafts and readmes, where the reader has none of the context that
made the short version legible to whoever wrote it.

## Common Patterns

### Hotkey Binding

```javascript
// Define modifier key combination
const hyper = ["⌘", "⌥", "⌃", "⇧"];

// Simple hotkey (press only)
hs.hotkey.bind(hyper, "4", () => {
    console.log("Key pressed");
}, null);

// Hotkey with press and release handlers
hs.hotkey.bind(hyper, "5",
    () => { console.log("Key down"); },
    () => { console.log("Key up"); });
```

### Window Management

```javascript
// Get all windows
const windows = hs.window.allWindows();

// Window properties
windows.forEach(win => {
    const title = win.title;                    // Window title
    const app = win.application.name;           // Application name
    const frame = win.frame;                    // {x, y, w, h}
    const position = win.position;              // {x, y}
    const size = win.size;                      // {w, h}
});

// Window methods
win.focus();
win.minimize();
win.centerOnScreen();
win.close();
```

### Application Watchers

```javascript
// One handler receives every application event; select the ones of interest in it.
// addWatcher takes the handler alone — passing an event name as a first argument throws
// "The provided handler must be a function".
function eventHandler(eventName, appObject) {
    if (eventName !== "didLaunch") return;
    console.log(`App ${appObject.name}: ${eventName}`);
}

hs.application.addWatcher(eventHandler);
hs.application.removeWatcher(eventHandler);
```

### Accessibility (AX) Watchers

```javascript
// Get application by bundle ID
const app = hs.application.matchingBundleID("com.apple.Safari");

// Add accessibility watcher
if (app != null) {
    function handler(notification, element) {
        console.log(`AX event: ${notification} on: ${element.title}`);
    }

    hs.ax.addWatcher(app, hs.ax.notificationTypes["windowCreated"], handler);
}
```

### Alerts

```javascript
// Show on-screen alert
hs.alert.show("Configuration loaded!");
```

## Available Modules

From the API index, key modules include:

- `hs.window` - Window management
- `hs.application` - Application control
- `hs.hotkey` - Keyboard shortcuts
- `hs.ax` - Accessibility API
- `hs.alert` - On-screen notifications
- `hs.screen` - Screen/display management
- `hs.timer` - Timers and scheduling
- `hs.eventtap` - Low-level event monitoring
- `hs.fs` - File system operations
- `hs.http` - HTTP requests
- `hs.json` - JSON parsing
- `hs.geometry` - Geometric operations

## Permissions

Several APIs return nothing rather than failing when macOS has not authorized Hammerspoon 2.
A silent `null` reads like "there is none of that" and sends you looking for a bug in the
wrong place, so check the permission before concluding the API is broken.

`hs.permissions` has a `check` and a `request` for each:

| Permission      | Check                 | Needed for                                           |
|-----------------|-----------------------|------------------------------------------------------|
| Accessibility   | `checkAccessibility()`| `hs.ax`, `hs.window`, menu bar items, window control |
| Location        | `checkLocation()`     | `ssid`, `bssid`, `countryCode`, `wlanChannel` in `hs.wifi` |
| Screen Recording| `checkScreenRecording()` | `hs.screen.snapshot()`, window snapshots          |
| Microphone      | `checkMicrophone()`   | audio input                                          |
| Camera          | `checkCamera()`       | `hs.camera`                                          |
| Notifications   | `checkNotifications()`| `hs.notify`                                          |

macOS prompts only once per application. When a `request…()` shows nothing, the answer was
given before and has to be changed by hand in **System Settings → Privacy & Security**.

Two worth knowing:

**Location.** macOS treats an SSID as location data. Without it `hs.wifi.currentNetwork()`
returns `null`, which looks exactly like not being on a network. `hs_network-gt` documents
both ways round this — granting the permission, or running a Shortcut instead.

**Prefer the permission to a workaround that runs a Shortcut.** macOS shows the Shortcuts
icon in the menu bar for as long as any Shortcut runs, so polling one makes that icon flash
all day, and each run spawns a process. Measured: an SSID read once a minute put the
indicator in 4 of 60 two-second scans.

A Spoon depending on a permission should say so in its readme, next to the setting that needs
it, and should still do something sensible without it. `hs_network-gt` falls back from the
SSID to naming the interface.

## Memory

`doc/memory-management.md` records how to avoid, find and fix memory leaks in the Spoons,
including how to run Hammerspoon 2 with allocation tracing. Read it before investigating
memory, and update it when a leak is found, fixed or re-measured.

Two rules prevent the leaks found so far:

1. Every `hs.timer.doEvery()` needs a place where it is stopped, on every path that ends
   what it serves: a user closing something, a device going away, and the Spoon's `stop()`.
   A timer that is never stopped keeps alive everything its callback refers to.
2. Code that runs during teardown must not open, show or start anything. A deferred
   callback must check that its object is still registered before acting.

`hs.reload()` leaves the previous JavaScript context alive, about 15 MB each time (#365).
Restart Hammerspoon 2 instead when memory matters, and avoid reloading in tests.

## Workarounds, and when to ask upstream

When something cannot be done the obvious way, say so in the code rather than quietly routing
around it, and then decide where the limitation actually lives. That decision is the useful
one, because only one kind of limitation can be fixed by someone else.

**Ask first: is this macOS or is this Hammerspoon 2?**

| The limitation is in | Then | Example |
|----------------------|------|---------|
| macOS | No upstream fix exists. Document the workaround and why it is needed. | An SSID needs Location Services; `AXPress` on your own process deadlocks |
| Hammerspoon 2's API | Candidate for an upstream issue. Work around it locally *and* raise it. | `hs.canvas` reports no right-click, because mouse delivery is a SwiftUI `DragGesture` |

A macOS limitation is permanent and the workaround is the answer. A Hammerspoon 2 limitation
is someone's backlog item, and the workaround is a cost being paid until it is fixed — worth
raising even if the local workaround is fine, because the next person pays it too.

Signs the thing you just wrote is a workaround worth recording:

- it reimplements something the API looks like it should already do
- it reaches outside the process — a shell command, a Shortcut, a screen capture — for
  information the process could hold
- it depends on a coordinate, a title, or a delay, instead of an identifier
- its comment begins by explaining why the obvious call does not work

**Before filing anything upstream, read `AI_POLICY.md` in the Hammerspoon 2 repository.** It
is strict and it binds outside contributors:

- all AI usage must be disclosed, naming the tool and the extent
- the human must fully understand the code, unaided, before contributing
- AI-drafted issues must be reviewed *and edited* by a human; the policy calls out verbosity
  and noise specifically

So an issue may be drafted here, but it is not ready to file until it has been cut down and
understood. Check for an existing issue first, and state only what has been verified — do not
claim a behaviour is a regression from Hammerspoon 1 without having checked Hammerspoon 1.

**Every draft ends with an `## AI disclosure` section.** It is the first requirement in the
policy, and a draft without one is not ready to file. Name the tool and the model, say what
the AI actually did, and say that a human reviewed and edited it. The extent has to be
accurate: if a measurement needed a hand on the mouse or the keyboard, say so, and do not
claim work that was not done. The format follows the issues already filed from here —
`resolved_issue_267_task-gc.md` and `resolved_issue_258_canvas-right-click.md`:

```markdown
## AI disclosure

Drafted with Claude Code (Claude Opus 5), which read the `hs.menubar` source for the file and
line references cited above, set up the click test, and read its results back over `hs.ipc`.
The three clicks themselves were made by hand. I reviewed and edited this before filing, as
`AI_POLICY.md` requires.
```

The body of a draft is written in the voice of whoever files it, so "I" there is the human,
not the AI. The disclosure is where the AI's part is stated.

## Development Tips

1. **Console Logging:** Use `console.log()` for debugging
2. **Null Checks:** Always check if applications/windows exist before accessing properties
3. **Error Handling:** The API may return `null` for missing resources
4. **Configuration File:** `~/.config/Hammerspoon2/init.js` is the main entry point
5. **Reload Config:** Reload configuration after making changes to see updates

## Example: Complete Window Listing Function

```javascript
function list_windows() {
    const windows = hs.window.allWindows();
    console.log(`\n=== Window List (${windows.length} windows) ===`);

    windows.forEach((win, index) => {
        const title = win.title || "(no title)";
        const appName = win.application ? win.application.name : "(unknown app)";
        const frame = win.frame;

        console.log(`\n[${index}] ${appName}: ${title}`);
        console.log(`    Position: (${frame.x}, ${frame.y})`);
        console.log(`    Size: ${frame.w} x ${frame.h}`);
    });

    console.log("\n=================================\n");
}

// Bind to hotkey
hs.hotkey.bind(hyper, "w", list_windows, null);
```

## Finding More Information

1. Start at the main index: https://cmsj.github.io/Hammerspoon2/index.html
2. Navigate to specific module documentation (e.g., hs.window.html)
3. Check type documentation for object properties (e.g., HSWindow.html)
4. The API is similar to original Hammerspoon - Lua examples can be adapted to JavaScript
