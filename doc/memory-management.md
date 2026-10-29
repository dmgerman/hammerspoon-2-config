# Memory management in configuration Spoons

How to avoid, find and fix memory leaks in the Spoons of this configuration. The figures
were measured in Hammerspoon 2, and each carries the date it was measured, because upstream
changes can make any of them out of date.

## What normal memory use looks like

A fresh launch of Hammerspoon 2 with this configuration has a footprint of 66–92 MB (Debug
build, measured 2026-10-28 and 2026-10-29). Use adds to that, and some of the growth is not a
leak:

| Growth | Why it is not a leak |
|--------|----------------------|
| Menu tiles | `hs_menu-gt` keeps one image per button in `tileCache`, loaded the first time its menu opens. It stops growing once every menu has been opened. |
| AppKit menu bar views | AppKit builds the application's menu bar once per display: 28 views each. Connecting a display such as Sidecar adds a set; disconnecting it removes the set. |
| Display mode lists | AppKit keeps the list of modes for each display, about 2,000 dictionaries for 4 displays, and rebuilds it when the display configuration changes. |
| Canvas elements | A canvas keeps its elements as dictionaries for as long as it exists. A canvas can hold hundreds. |
| Allocated malloc pages | `malloc` keeps pages after the objects in them are freed. The footprint can rise when the live objects do not. |
| Temporary garbage | 1,000 calls in a loop can add 47 MB in one run and nothing in the next, depending on when the collector runs. |

Compare live objects, not the footprint. The footprint mixes the categories above with real
leaks, and it moves by tens of megabytes for no lasting reason.

## Avoiding leaks in a Spoon

### A repeating timer keeps alive everything it refers to

A timer started with `hs.timer.doEvery()` runs until it is stopped. Its callback is a
closure, and everything that closure can reach stays alive with it. So a timer that is never
stopped also keeps every object behind it, however large.

Every `doEvery` therefore needs a place where it is stopped. That place has to run on every
path that ends what the timer serves: the user closing something, a device going away, and
the Spoon's `stop()`.

### Teardown must not start new work

Code that runs when something closes is often written for one reason to close, and then
called for another. A function called during teardown must not open, show or start anything.
When one function serves both a user action and teardown, it must check which case it is in.
Checking that the object is still registered is enough: by the time a deferred callback
runs, teardown has removed it.

For example, the Stream Deck presenter in `hs_streamdeck-gt` returns to the root menu when a
menu button with `dismiss` closes the session. The same `close` also runs when `detach()` or
`stop()` closes the session. Written like this, it reopens the root menu on a deck that has
been unplugged:

```javascript
close: function () {
    hs.timer.doAfter(0, () => openRoot(record))
}
```

Nothing closes that new session, because the record is no longer in `decks`. The root menu's
self-drawing buttons each run a `doEvery` timer, and those timers keep the session, the
record and the device alive: about 120 KB at every unplug. The presenter therefore reopens
the root only while the record is still attached:

```javascript
close: function () {
    hs.timer.doAfter(0, () => {
        if (decks.get(record.device.serialNumber) === record) openRoot(record)
    })
}
```

### Remove what you registered

A Spoon that adds a record to a `Map` on connect must delete it on disconnect, and must
remove its watchers and stop its timers in `stop()`. `hs_streamdeck-gt` does this in
`detach()` and `stop()`.

### Destroy canvases

A canvas that is replaced must be destroyed with `destroy()`, not only hidden.
`hs_network-gt` creates a banner canvas every minute and destroys the previous one, so its
canvas count goes up and down without climbing.

### Callbacks passed to Hammerspoon 2 do not cause cycles

Hammerspoon 2 stores a callback such as `device.onButton(fn)` as a `JSManagedValue`
(`JSCallback.swift`). A closure that refers back to the object it was registered on is
therefore not a leak by itself, and does not need special handling in a Spoon.

### Reloading the configuration

`hs.reload()` frees the previous JavaScript context, together with everything the
configuration created in it, in builds that include upstream PR #366. In a build that does
not, every reload keeps the previous context alive, about 15 MB or more each time, and
restarting Hammerspoon 2 is the only way to free it.

A build that includes #366 logs an error in the console if a deleted context is still alive
10 seconds after a reload. To check by counting, reload, wait 30 seconds, run
`hs.collectGarbage()`, and then run `heap <pid> -s | grep -E "JSVirtualMachine|JSContext"`.
There should be one of each. A build of #366 gave one of each after a reload that followed
no `fetch()`, a refused `fetch()`, and a `fetch()` that downloaded a response (measured
2026-10-29).

## Running Hammerspoon 2 with allocation tracing

`heap` and `leaks` work on any running Hammerspoon 2. `malloc_history`, which says where an
object was created, also needs the process to have been started with malloc stack logging.
No recompile is needed: `MallocStackLogging` is an environment variable that macOS's `malloc`
reads when the process starts.

Quit Hammerspoon 2 and start it again with the variable set:

```sh
pkill -x "Hammerspoon 2"
open --env MallocStackLogging=lite \
    "/Users/dmg/git.w/Hammerspoon2/Build/Products/Debug/Hammerspoon 2.app"
```

`open --env` passes the variable to the application, which still starts through Launch
Services as it normally does. `lite` records a stack for each allocation that is still alive.

To check that it took effect:

```sh
P=$(pgrep -x "Hammerspoon 2")
ps eww -p $P | tr ' ' '\n' | grep MallocStackLogging    # prints MallocStackLogging=lite
malloc_history $P -allBySize | head -3                  # prints stacks, not an error
```

Then `malloc_history $P <address>` gives the stack that allocated any object.

Three things to know (measured 2026-10-28 on the Debug build):

1. **The build must allow inspection.** The Debug build is signed with the
   `get-task-allow` entitlement, which lets `heap`, `leaks` and `malloc_history` read it.
   It also uses the hardened runtime, which strips `DYLD_*` variables but keeps
   `MallocStackLogging`. A Release build may not allow either; one has not been tested.
2. **It changes what the footprint reports.** With stack logging on, JavaScriptCore
   allocates through ordinary `malloc`, so the JavaScript heap moves from "WebKit Malloc" to
   "Malloc Small" in `footprint`. Do not compare footprint categories between a run with
   logging and one without.
3. **It costs memory.** The records themselves appear as "Untagged" in `footprint` and grow
   by about 10 MB a day. To turn logging off, restart Hammerspoon 2 normally.

`malloc_history` shows who created an object, not who keeps it. For that, use
`leaks --traceTree` (step 3 below). When an object is kept by a retain that nothing points
to, neither tool can name the owner. Instruments' Allocations instrument with "Record
reference counts" turned on records every retain and release with its stack.

## Finding a leak

1. **Count objects by type and compare with what should exist.** Run
   `heap <pid> -s | grep -E "HSStreamDeckDevice|HSTimer|HSCanvas|JSContext"`. One Stream
   Deck should give one `HSStreamDeckDevice`; more than one is a leak. Run
   `hs.collectGarbage()` first, so that objects waiting to be collected are not counted.
2. **Repeat the event you suspect and count again.** Leaks hide on paths that run a few
   times a day: unplugging a device, sleep and wake, display changes and reloads. A count
   that rises by the same amount each cycle and survives `hs.collectGarbage()` is a leak.
3. **Find what holds a leaked object.** Run `leaks <pid> --traceTree=<address>`, taking the
   address from `heap <pid> -addresses=<type>`. If the holder is a
   `JSCallbackObject<JSAPIWrapperObject>` in the "JS VM Reservations" region, JavaScript
   holds the object, and the bug is in a Spoon rather than in Hammerspoon 2. Branches
   through Swift Metadata or `__DATA` regions are noise: `leaks` reports anything that
   looks like a pointer.
4. **See which JavaScript runs.** Replace a function on the live Spoon object over `hs2`,
   keeping the original on `globalThis`. Record each call, cycle the event, read the record
   back, and restore the original. This needs no reload and no file changes. For example:

   ```javascript
   const m = hs.spoons["hs_menu-gt"]
   globalThis.__orig = m.openSession
   globalThis.__calls = []
   m.openSession = function (menu, presenter, options) {
       globalThis.__calls.push({ t: new Date().toISOString(), name: options && options.name })
       return globalThis.__orig.apply(this, arguments)
   }
   ```

   Restore it with `m.openSession = globalThis.__orig`.
5. **Find where objects were created.** With Hammerspoon 2 running with allocation tracing
   (see the section above), `malloc_history <pid> <address>` gives the stack that allocated
   an object. To see where a whole type comes from, sample its addresses and count the
   Hammerspoon 2 frames in their stacks. The stacks show Swift and Objective-C frames but no
   JavaScript frames, so step 4 is still needed to see which JavaScript ran.

## The macOS Wi-Fi leak

Each call to `hs.wifi.interfaceDetails()` leaves one `CWConfiguration` object alive for the
rest of the process. The leak is in macOS: CoreWLAN's `-[CWInterface configuration]` keeps a
reference to the object it returns. An Objective-C program built without ARC, which never
retains the result, leaks the same way. Hammerspoon 2 only triggers it, because
`interfaceDetails()` calls `configuration()` every time. `hs.wifi.currentNetwork()` does not
leak. The full investigation is in `ai/not-a-hs2-issue_wifi-configuration-leak.md`, which is
not checked in: `ai/` is listed in `.gitignore`.

It is present on macOS 27.0.1: 200 calls add 201 objects, and 200 calls to
`currentNetwork()` add none (measured 2026-10-28). To check a newer macOS, count
`CWConfiguration` with `heap` before and after such a loop.

The cost per call depends on what CoreWLAN attaches to the leaked object:

| Measured in | Per call | At one call a minute |
|-------------|----------|----------------------|
| A standalone test program | about 92 bytes | about 130 KB a day |
| A Hammerspoon 2 process whose leaked objects keep their network profiles | about 290 bytes | about 420 KB a day |

In this configuration, `interfaceWifi()` in `hs_network-gt` is the only caller. It runs
about once a minute, when the banner is shown and on each idle poll. Calling
`hs.wifi.currentNetwork()` there instead avoids the leak, provided Hammerspoon 2 has
Location access. Without it, `currentNetwork()` returns `null`.
