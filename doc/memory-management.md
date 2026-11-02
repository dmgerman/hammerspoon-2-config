# Memory management in configuration Spoons

How to avoid, find and fix memory leaks in the Spoons of this configuration. The figures
were measured in Hammerspoon 2, and each carries the date it was measured, because upstream
changes can make any of them out of date.

## What normal memory use looks like

A fresh launch of Hammerspoon 2 with this configuration has a footprint of 56–92 MB (Debug
build, measured 2026-10-28 to 2026-10-29). After 12 hours of use it is about 108 MB, with a
heap of 46.7 MB and 256 bytes reported by `leaks` (measured 2026-10-30). Use adds to the
launch figure, and some of the growth is not a leak.

After 21 hours, with the configuration reloaded about six times, the footprint was 123 MB
with a peak of 151 MB, and the heap 53.4 MB in 263,564 blocks (measured 2026-10-30). One
`JSContext` remained, so the reloads had freed their contexts. `leaks` reported 704 bytes:
22 `JSValue` objects of 32 bytes each, with nothing reachable from them. The 222
`HSAXWatcherObject`s matched what `hs_windowfilter-gt` was tracking exactly: 27 windows with
6 notifications each and 20 applications with 3 each.

The same process after 42¾ hours had a footprint of 136 MB with a peak of 192 MB, and a heap
of 54.3 MB in 275,877 blocks (measured 2026-10-31). The heap had grown by 0.9 MB in 21 hours.
Most of the difference from the footprint was fragmentation: the `malloc` zones held 52.2 MB
of allocations and 28.9 MB of freed space kept for reuse. Every object count was unchanged,
and the 168 watchers again matched 19 windows and 18 applications. `leaks` reported 36
`JSValue` objects of 32 bytes, 1,152 bytes in all, up from 22. That is about 14 a day, and
they do not come from `hs2` evaluations: 22 evaluations added none. Their origin needs a run
with allocation tracing, which this process did not have.

Some of the growth is not a leak:

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

Do not poll `hs.wifi.interfaceDetails()`. Every call leaks memory that is never freed, and
`hs.wifi.currentNetwork()` answers the usual question, whether Wi-Fi is associated, without
leaking. `currentNetwork()` needs Location access; without it, it returns `null`.
`hs_network-gt` uses `currentNetwork()` for this reason.

`interfaceDetails()` leaks two things:

1. **The Wi-Fi configuration, on every call.** CoreWLAN's `-[CWInterface configuration]`
   keeps a reference to the `CWConfiguration` it returns. An Objective-C program built
   without ARC, which never retains the result, leaks the same way, so the leak is in macOS.
   Most leaked configurations are 32 bytes. Some carry every known network with its access
   points, including each access point's router address and location, and those reach
   300 KB.
2. **The cached scan results, once for each time macOS refreshes them.** The
   `cachedScanResults` field comes from `-[CWInterface cachedScanResults]`, which returns
   an `NSSet` of every network in range, about 480 KB for 73 networks. Repeated calls between
   refreshes add nothing. Whether this leak is in CoreWLAN or in the conversion of the set to
   Swift has not been tested.

Measured on macOS 27.0.1 (2026-10-29), with `interfaceDetails()` called about once a minute:
`leaks <pid>` reported 28.8 MB leaked after 10½ hours, about 65 MB a day. Of that, 22.9 MB was
48 scan result sets and 4.6 MB was 614 configurations. The 515,669 leaked blocks were mostly
strings and dictionaries inside them. With `currentNetwork()` in its place, a 12-hour run
leaked 256 bytes in total and held no `CWConfiguration` or `CWNetwork` objects (measured
2026-10-30).

To check a newer macOS, run `leaks <pid>` on a process that has called `interfaceDetails()`
for some hours, and look for `ROOT LEAK` entries of type `CWConfiguration` and `NSSet`. To
count the configuration leak alone, count `CWConfiguration` with `heap` before and after
200 calls; on macOS 27.0.1, 200 calls add 200. The investigation of the configuration leak
is in `ai/not-a-hs2-issue_wifi-configuration-leak.md`, which is not checked in: `ai/` is
listed in `.gitignore`.
