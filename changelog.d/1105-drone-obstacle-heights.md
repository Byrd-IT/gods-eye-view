- Drone Flight Plan has per-obstacle heights. Each obstacle is a see-through
  column on the globe, from the ground to its height, labelled "tree 18 m" and
  so on, with a yellow dot on top you can drag, or type the height in the
  OBSTACLE HEIGHTS list. The first guess comes from open data only: FAA
  obstacle file for towers, the Meta and WRI tree canopy height model
  (CC BY 4.0) for tree patches, and OpenStreetMap building heights. RESET goes
  back to the estimate, ADD puts one on the map, the x removes one. The plan
  keeps every leg and orbit point near a column at least its height plus 5 m
  above the ground, raises the route where needed, and draws a leg red with a
  warning where the 120 m limit cannot clear it. The numbers are estimates or
  your own values, not a survey. Trees grow, power lines are in none of these
  sources, and this is a visual check, not flight-tested. Google 3D is only
  the picture you compare the columns with by eye; no code reads heights from
  it.
