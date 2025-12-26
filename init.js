console.log("Hey I'm an init.js");
const hyper = ["⌘", "⌥", "⌃", "⇧"];

function eventHandler(eventName, appObject) {
    console.log("INIT.JS appWatcher eventHandler: " + eventName + " " + appObject.title);
}

hs.application.addWatcher("willLaunch", eventHandler);
hs.application.addWatcher("didLaunch", eventHandler);
hs.application.addWatcher("didTerminate", eventHandler);

const safari = hs.application.matchingBundleID("com.apple.Safari");
function handler(notification, element) {
    console.log("AX event: " + notification + " on: " + element.title);
}

if (safari != null) {
    hs.ax.addWatcher(safari, hs.ax.notificationTypes["windowCreated"], handler);
}

hs.hotkey.bind(hyper, "4", () => { console.log("HYPER 4"); }, null);
hs.hotkey.bind(hyper, "5",
               () => { console.log("HYPER 5 DOWN"); },
               () => { console.log("HYPER 5 UP");   });

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
}

function next_screen() {
    const win = hs.window.focusedWindow();

    if (!win) {
        console.log("No focused window");
        return;
    }

    try {
        // Get current screen and all screens
        const currentScreen = win.screen;
        const allScreens = hs.screen.allScreens();

        if (!allScreens || allScreens.length <= 1) {
            console.log("Only one screen available");
            return;
        }

        // Find current screen index
        let currentIndex = -1;
        for (let i = 0; i < allScreens.length; i++) {
            if (allScreens[i] === currentScreen) {
                currentIndex = i;
                break;
            }
        }

        // Get next screen (wrap around)
        const nextIndex = (currentIndex + 1) % allScreens.length;
        const targetScreen = allScreens[nextIndex];
        const targetFrame = targetScreen.frame;

        // Get current window frame
        const winFrame = win.frame;

        // Calculate new dimensions
        let newW = winFrame.w;
        let newH = winFrame.h;

        // Resize if window is larger than target screen
        if (newW > targetFrame.w) {
            newW = targetFrame.w;
        }
        if (newH > targetFrame.h) {
            newH = targetFrame.h;
        }

        // Move window to new screen (top-left of target screen)
        const newFrame = new HSRect(targetFrame.x, targetFrame.y, newW, newH);
        win.frame = newFrame;

        console.log(`Moved window to screen ${nextIndex + 1}/${allScreens.length}`);
    } catch (error) {
        console.log("Error moving window: " + error.message);
        console.log("The screen API may not be available in this version");
    }
}

function window_hor_half() {
    const win = hs.window.focusedWindow();

    if (!win) {
        console.log("No focused window");
        return;
    }

    // Get current window frame
    const frame = win.frame;

    // Reduce width to 50%, keep left edge fixed
    const newFrame = new HSRect(frame.x, frame.y, frame.w / 2, frame.h);

    win.frame = newFrame;
    console.log(`Reduced window width from ${frame.w} to ${newFrame.w}`);
}

hs.hotkey.bind(hyper, "6", list_windows, null);
hs.hotkey.bind(hyper, "8", next_screen, null);
hs.hotkey.bind(hyper, "7", window_hor_half, null);


hs.alert.show("Hammerspoon 2 Config loaded\nAll systems operational.");


console.log("Finished loading-------------------------");
