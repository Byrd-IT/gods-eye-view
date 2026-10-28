- Map overlays panel: raise/lower buttons, the opacity slider and its value now
  use the shared chip and slider styling instead of browser-default controls,
  and the section is styled from CSS with the shared tokens (no inline styles).
  On phones an open Time travel card keeps its full height, so the CONTEXT card
  no longer covers the Map overlays section.
- Map basemap config: each block (terrain, imagery, buildings, NAIP, overlays)
  is cached on its own, so one failing block is retried alone.
