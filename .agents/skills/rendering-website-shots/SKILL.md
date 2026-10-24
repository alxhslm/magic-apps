---
name: rendering-website-shots
description: Render the website's native screenshots (Magical and Magimail) from the real SwiftUI views. Use when the project paints every pixel, such as a widget, menu bar popover or Focus Filter, or when a widget or menu bar layout changes.
---

# Rendering the website's shots

`tools/shots` draws the website's native screenshots from the views the apps themselves use, with
invented data. A shot can therefore never show a layout the app no longer draws, and nobody has to
arrange a convincing diary or inbox in their personal accounts before taking one.

The shots with Google's own page, the system Share sheet or a notification banner in the frame
cannot come from here and are captured from the running app;
[`capturing-website-shots`](../capturing-website-shots/SKILL.md) covers those.

```bash
swift run --package-path tools/shots shots website/src/assets   # writes the PNGs
cwebp -q 88 website/src/assets/shot-widgets-magical.png -o website/src/assets/shot-widgets-magical.webp
cwebp -q 88 website/src/assets/shot-popover-magical.png -o website/src/assets/shot-popover-magical.webp
cwebp -q 88 website/src/assets/shot-focus-magical.png -o website/src/assets/shot-focus-magical.webp
cwebp -q 88 website/src/assets/shot-widgets.png -o website/src/assets/shot-widgets.webp
cwebp -q 88 website/src/assets/shot-popover.png -o website/src/assets/shot-popover.webp
cwebp -q 88 website/src/assets/shot-focus.png -o website/src/assets/shot-focus.webp
cwebp -q 88 website/src/assets/shot-tasks-magical.png -o website/src/assets/shot-tasks-magical.webp
rm website/src/assets/shot-*.png
```

`cwebp` comes from `brew install webp`. `sips -s format webp` accepts the argument and writes
nothing, so do not reach for it.

## What it renders

| File                        | Shows                                                                   |
| :-------------------------- | :---------------------------------------------------------------------- |
| `shot-widgets-magical.webp` | Up next small, Agenda medium and Month large, on a desktop              |
| `shot-popover-magical.webp` | The Magical menu bar popover, expanded, with the day's agenda           |
| `shot-focus-magical.webp`   | The macOS Focus Filter pane for Magical: accounts, then their calendars |
| `shot-widgets.webp`         | All four Magimail widgets, on a desktop                                 |
| `shot-popover.webp`         | The Magimail menu bar popover with multi-account message feeds          |
| `shot-focus.webp`           | The macOS Focus Filter pane for Magimail: accounts                      |
| `shot-tasks-magical.webp`   | The agenda with two tasks open and one completed, dated today           |

The focus panes are stand-ins rather than captures. System Settings draws that pane from the app's
`SetFocusFilterIntent`, so the content is the project's and neither the app's own views nor
`ImageRenderer` can produce it; `FocusFilterPane` draws it from the copy that intent carries and the
accounts or calendars it offers, and keeps a real account list out of the shot. It is a likeness of
the pane, not a screenshot of it. `writeFitted` measures its height, so a change to the copy or to the
number of rows moves the pane rather than clipping its last card.

Everything comes from invented fixtures in `Fixtures.swift`, so the site shows consistent data rather
than unrelated accounts. Times are relative to the run, so a shot never dates itself: regenerate it next
month and the meetings and messages are still this afternoon.

## Three things that will bite

**It renders through `NSHostingView`, not `ImageRenderer`.** `ImageRenderer` paints a yellow
"unsupported" block over anything AppKit backs, which in the popovers is the search field, menus
and buttons, and it never realises a `LazyVStack`, so scrollable lists came out empty. AppKit's
`cacheDisplay` draws what the app draws. The window the hosting view sits in is never ordered front.

**A new dependency in a helper package needs `tools/shots/.build` deleted.** This package reaches
the two helpers through the `magical-helper` and `magimail-helper` symlinks, and SwiftPM keeps their
resolved manifests, so after the helper gains a package dependency the build reports `no such module`
for it until the directory is removed and the graph is resolved again.

**The popover counts its own density dots from the events it was given**, not from the snapshot's
`densityDots`. A handful of events makes a nearly empty month grid, so `Fixtures` fills three weeks
either side of today with a stand-up and the odd catch-up. Widgets read `densityDots` instead, which
is why `Fixtures` supplies both.

## Adding a view

The helper libraries `MagicalHelperLib` and `MagimailHelperLib` contain the widget views and models
alongside the popover views, and both expose library products. `tools/shots` depends on both packages
directly, eliminating per-file source symlinks.

To add a shot, build the view in `main.swift` and call `write(_:_:size:)` with the size the host
gives it: `TrayPopoverMetrics` has the popover's width, and a widget is 155×155, 324×155 or 324×324.

Update `website/src/magical.njk` or `website/src/magimail.njk` when a shot's dimensions change;
the `width` and `height` attributes are in point sizes, and the file is written at twice that in pixels.
