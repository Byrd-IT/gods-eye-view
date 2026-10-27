# Sky view P4: "Point at the sky" device test script

What this checks on REAL phones (the synthetic part is in
`orientationMath.test.mjs`, `orientation.test.mjs`, `declination.test.mjs`,
`skyView.test.mjs` and the headless harness `scripts/qa-sky-p4.mjs`):

1. pointing at the Moon, the Sun (never look at it directly, see below) or a
   bright planet lines up within 5 degrees on iOS and on Android after
   calibration;
2. the permission-denied path shows the message and dragging still works;
3. the LAN http address explains that the https address is needed.

None of these real-device checks has been done yet: they are the device
card (t_d0655670), after the deploy. Clear view (step 14, t_aaae5ed7) has
only been checked in headless Chromium (`scripts/qa-sky-p4.mjs`, cases I-L).

Record a screenshot for every numbered step marked SHOT and attach them to the
kanban card with the phone model, OS version and browser version.

## Which way the view looks (authoritative for P4 acceptance)

The view follows the BACK of the phone, like its camera: you look at the
screen and the sky behind it is what is drawn.

- Upright in portrait, back facing east: azimuth 90, elevation 0.
- Flat, SCREEN DOWN / back up (phone held overhead, you look up at the
  screen from below): the zenith, elevation +90.
- Flat, SCREEN UP / back down (lying on a table): the back points at the
  ground, the nadir (elevation -90). The sky view does not draw below its
  existing -10 degree floor (unchanged, the same as when dragging), so a
  phone lying screen-up shows the view held at -10 degrees, not the sky
  overhead. That is expected, not a fault.

The synthetic tests check these poses; whether real phones report them this
way is what the steps below check (not yet done: see the device card).

## Before you start

- Use the public HTTPS address: https://godseyeview.byrd-it.com (Basic Auth).
  Sensors need a secure context; the LAN http://10.10.99.104:4173 address
  cannot read them (that is step 12).
- Stand outside, away from cars, steel railings and buildings' steel frames
  (they bend the compass by tens of degrees). Take the phone out of a
  magnetic case or mount.
- Pick a target that is up and at least 10 degrees above the horizon and
  below 75 degrees: the Moon is best. A bright planet (Venus, Jupiter) works
  at night. The SUN: do NOT look at it or through the phone at it. Point the
  phone so the phone's shadow is smallest (back of the phone square to the
  Sun) and judge by the shadow, or skip the Sun and use the Moon.
- In GEV: tap Sky, then "Use my location" (allow location). Your own GPS
  position matters: the compass correction (magnetic declination) is taken
  for the sky point, and the status line says so if it is not your location.
- Clear view: once the view follows the phone, every menu and panel hides
  by itself so only the sky is left (the first time it says "Double-tap to
  show controls"). For the steps that tap Align or "Point at the sky",
  double-tap the sky (or tap the round eye button: bottom-right corner in
  portrait, top-right in landscape) to bring the controls back first. Step 14 tests Clear view itself.

## iPhone (Safari)

1. Tap "Point at the sky". iOS asks "godseyeview.byrd-it.com would like to
   access motion and orientation": tap Allow. SHOT of the prompt.
2. Hold the phone upright in portrait for 2-3 seconds (the compass heading is
   read in that pose). If the status says "Compass needs calibrating" and
   shows the moving figure-8 sign, wave the phone in a figure 8 a few times
   until it goes away.
3. Hold the phone up at the target so it sits in the white centre circle.
   Read the drawn target's position against the real one. The screen's
   long side spans 70 degrees at the default zoom, so on a typical phone the
   34 px centre circle is about 2.5-3 degrees across: a miss of two circle
   widths is about 5 degrees (pinch to zoom in for finer reading). SHOT with the real
   Moon visible on the screen edge if the camera angle allows, otherwise a
   SHOT of the screen plus a note of the estimated miss.
   PASS: within 5 degrees.
4. Turn to landscape (both ways) and repeat 3: the view must not roll by 90
   degrees and the target stays put. SHOT.
5. Raise the phone overhead, screen down / back up, to look at the zenith,
   then lower it back to the horizon: the view follows smoothly, without
   jumps of 180 degrees. Note any jump. (Screen up would point the back at
   the ground: see "Which way the view looks".)
6. If 3 failed by more than 5 degrees: with the Moon in the circle tap
   "Align centre on: Moon"; the status shows the change. Then point away
   and back: the Moon should now line up. Record the offset shown.
   The Align buttons appear only once the compass has given a reading
   (step 2: upright in portrait). Before that the view is in iOS's free
   yaw frame and an offset would be wrong, so Align is not offered. Check
   that: right after "Point at the sky", look straight up at the Moon
   without holding the phone upright first. Expected: no Align buttons and
   "Reading the compass" in the status. Then hold it upright: the Align
   buttons appear. Note it on the card.
7. Drag with one finger: the status says "Drag took over", the view stops
   following the phone and the drag works. Tap "Point at the sky" again: it
   follows again without a new prompt.

### iPhone denied path

8. Settings > Safari > Advanced > Website Data: remove godseyeview.byrd-it.com
   (or use a fresh Private tab), open the page, Sky, "Point at the sky", tap
   "Don't Allow". The status must say "Motion access is blocked..." and
   dragging must still work. SHOT.

## Android (Chrome)

9. Tap "Point at the sky". Chrome normally does not prompt (motion sensors
   are allowed by default). The status shows the declination. SHOT.
10. Repeat steps 3, 4, 5, 6 and 7 above. If the view is clearly off, do the
    figure 8 (Android gives the page no accuracy value, so the hint is only
    in the text) and/or Align. SHOT for step 3.

### Android denied path

11. Chrome: lock icon > Permissions (or Site settings) > Motion sensors >
    Block, reload, Sky, "Point at the sky". Expected: "Motion access is
    blocked..." after about 3 seconds (up to about 6 if the sensor
    stays silent instead of reporting the block: the events then get their
    own 3 seconds) (or "No orientation sensor found" on
    Chrome versions that report a block as no data), and drag works. SHOT.
    Reset the permission afterwards.

## Both

12. LAN address: open http://10.10.99.104:4173 on the phone (on the Wi-Fi),
    Sky, "Point at the sky": the status says pointing needs
    https://godseyeview.byrd-it.com and drag works. SHOT.
13. Battery sanity (optional): leave pointing on, phone still on a table for
    5 minutes; the view must not keep redrawing (no visible shimmer) and the
    phone must not get warm.
14. Clear view (only the sky):
    a. In Sky with the controls shown, tap the round eye button
    (bottom-right corner in portrait, top-right in landscape). Everything except the sky disappears: the Sky
    toolbar, time row, satellite panel, Find/Layers, the Sky button, the
    app's top icons, the HUD text, the voice/command dock and the key
    chip. Stars, lines, names, planets, satellites, the horizon and its
    compass scale stay exactly where they were (no jump, no reload). SHOT
    in portrait and in landscape.
    The map credits stay, small and dim, in the bottom-left corner while
    the ground (map tiles) is drawn, and they stay complete: long credits
    wrap onto more lines, nothing ends in "..." or runs off the screen.
    Read the credits to the end (the last item is the "Data attribution"
    link) and SHOT them. They do not cover the centre circle or the eye,
    and a tap on the credit text reaches the sky. Tap "Data attribution":
    the full list of data sources opens over the sky; close it (x) and the
    clear sky is back, still in Clear view. With the flat horizon (no map
    tiles) the credits go away (t_37cf1f79, t_c0f1e535).
    b. The eye fades after about 3 seconds; touching the screen anywhere
    brings it back. The notch and the bottom gesture bar do not cover it.
    c. Double-tap the sky: the controls come back. Double-tap again: clear.
    A single tap on a satellite still selects it, a drag still turns the
    view and a pinch still zooms; none of them toggles Clear view.
    d. Tap "Point at the sky" (controls shown): once the view follows the
    phone, Clear view turns on by itself and says "Double-tap to show
    controls" (only the first time in a browser session). The centre
    circle stays. Bring the controls back with a double-tap: for the rest
    of the session pointing no longer clears the screen by itself.
    e. Messages stay visible in Clear view as one line at the top: the
    denied path (8 or 11), the LAN address (12) and the compass figure 8
    (step 2). Check at least one of them with Clear view on. SHOT.
    f. Leave the sky (double-tap, Back to map) and come back: Clear view is
    remembered until the browser tab is closed.
    Desktop: H toggles Clear view in the sky (outside the sky H stays the
    HUD key), Escape brings the controls back, and a double-click on the sky
    toggles it as well.

## What to write on the card

For each phone: model, OS, browser + version, target used, miss before and
after Align (degrees), the Align offset, which steps passed, every SHOT.

## Known limits (stated, not hidden)

- iOS reports orientation in a free yaw frame plus a compass heading. Which
  phone direction iOS ties that heading to is only certain upright in
  portrait and flat screen-up, so the correction is taken in those poses and
  kept while you look up. If an iPhone is off by a constant amount, Align
  fixes it; if it is off by ~180 degrees only when looking up, report it
  (that would mean iOS uses a different reference vector: step 5). Align is
  offered only after that first compass reading (see step 6). An offset
  taken before it would be counted twice later.
- Firefox for Android gives no absolute heading: pointing starts in
  "calibrating" and needs one Align on the Moon/Sun/selected object.
- In-app browsers (Instagram, Facebook...) often block motion sensors:
  expect "unsupported"; open the page in Safari/Chrome.
