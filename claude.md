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
    const app = win.application.title;          // Application name
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
function eventHandler(eventName, appObject) {
    console.log(`App ${appObject.title}: ${eventName}`);
}

hs.application.addWatcher("willLaunch", eventHandler);
hs.application.addWatcher("didLaunch", eventHandler);
hs.application.addWatcher("didTerminate", eventHandler);
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
        const appName = win.application ? win.application.title : "(unknown app)";
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
