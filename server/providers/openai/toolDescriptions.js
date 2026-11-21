import {
  voiceLayerAliasHint,
  voiceQueryFieldHint,
} from '../../../src/voice/layerManifest.js';

export const ACTION_DESCRIPTIONS = {
  fly_to_location: {
    description:
      "Fly the God's Eye View camera to a known city, geocoded country/region/city/landmark, or explicit WGS84 coordinate.",
    $position: 1,
    parameters: {
      properties: {
        locationId: {
          description:
            'Known city preset ID. Use when the requested place matches one of these cities.',
          $position: 2,
        },
        query: {
          description:
            'Plain place search query, e.g. "London", "Eiffel Tower", or "Dubai Marina". "pointer" = the spot under the cursor.',
          $position: 1,
        },
        referent: {
          description: 'Numbered item n from the last result list.',
          $position: 1,
        },
        viewMode: {
          description: 'Usually omit: GEV infers whole-place or close framing.',
          $position: 2,
        },
        rangeM: {
          description:
            'Optional camera range in meters; only when the user explicitly requests a numeric height or distance.',
          $position: 3,
        },
        waitForArrival: {
          description:
            'Set true when a later tool depends on the destination viewport. The result then waits for the camera flight and returns arrived=true; cancellation returns ok=false.',
          $position: 1,
        },
      },
    },
  },
  select_nearest_aircraft: {
    description:
      'Atomically fly to a place, wait for arrival, enable and load Flights or Military Flights in that viewport, exclude on-ground records, and select/follow the nearest airborne aircraft. Healthy fallback feeds remain usable and are reported in the result.',
    $position: 1,
    parameters: {
      properties: {
        layerId: {
          description:
            'Aircraft layer to enable and search. Use flights unless the user explicitly asks for military aircraft.',
          $position: 2,
        },
        locationId: {
          description:
            'Known city preset ID when the place matches one of these cities.',
          $position: 2,
        },
        locationQuery: {
          description: 'Free-form destination when no locationId matches.',
          $position: 2,
        },
      },
    },
  },
  show_street_level: {
    description:
      'Fly to a place and open its nearest street-level photo; Street View switches to Google 3D (billed). No query: view centre.',
    $position: 1,
    parameters: {
      properties: {
        query: {
          description: 'Place or address; "pointer" = under the cursor.',
          $position: 1,
        },
        provider: {
          description:
            'google = Street View; others by name; omit: the lit source.',
          $position: 1,
        },
        referent: {
          description: 'Numbered item n from the last result list.',
          $position: 1,
        },
      },
    },
  },
  adjust_camera_zoom: {
    description:
      'Move the current Cesium camera closer to or farther from what it is presently looking at. Use for relative zoom requests without changing location.',
    $position: 1,
    parameters: {
      properties: {
        amount: {
          description:
            'Use little for phrases like "a bit" or "a little", medium for ordinary zoom requests, and lot for "way out/in".',
          $position: 2,
        },
      },
    },
  },
  zoom_to_globe: {
    description:
      'Pull the camera out to an ABSOLUTE full-Earth globe view (~18,000 km altitude, the whole planet in frame), keeping the current region centered. Use for "globe view", "whole earth", "see the planet", "zoom all the way out". Never use adjust_camera_zoom for these — its relative steps cannot reach the globe.',
    $position: 1,
  },
  set_layer_visibility: {
    description:
      "Enable or disable one God's Eye View data layer. Every shipped layer is in the enum; never tell the user a listed layer does not exist.",
    $position: 1,
    parameters: {
      properties: {
        layerId: {
          description: `Spoken names: ${voiceLayerAliasHint()}.`,
          $position: 1,
        },
      },
    },
  },
  show_data_layers_menu: {
    description:
      'Open the data layers dropdown/menu and optionally scroll to a specific layer row without toggling it.',
    $position: 1,
    parameters: {
      properties: {
        layerId: {
          description: 'Optional layer row to scroll into view and highlight.',
          $position: 2,
        },
      },
    },
  },
  set_panel_open: {
    description:
      'Visual Presets/styles/filters=control-panel; Scenes/saved scenes=scene-panel; Voice Settings=voice-settings; voice control/Preview=voice-preview; Provider Settings/API keys=provider-settings. Voice panels exit Cockpit directly.',
    $position: 1,
  },
  set_voice_inactivity_timeout: {
    description:
      'Set the requested exact inactivity duration directly: integer minutes 1–60, 0=None. Report applied/persisted truthfully; an unsaved live change is not saved.',
    $position: 1,
  },
  set_context_mode: {
    description:
      'Enter/exit Contacts or Space Missions only when explicitly requested; opening Context alone uses set_panel_open.',
    $position: 1,
    parameters: {
      properties: {
        mode: {
          description: 'Use off to exit context mode.',
          $position: 2,
        },
      },
    },
  },
  control_cockpit: {
    description:
      'Explicit Cockpit requests only: enter from a selected/tracked aircraft (needs only its own Flights/Military layer on, not Contacts; opens Contacts itself, no set_context_mode), exit, status, or next/previous. Explicit exit-and-show voice: voicePanel preview/settings (Voice Settings), no confirmation.',
    $position: 1,
    parameters: {
      properties: {
        action: {
          description:
            'previous/next (or prev) cycles nearby Cockpit contacts.',
          $position: 2,
        },
        targetLayer: {
          description:
            'Optional next/previous layer filter (e.g. military-only).',
          $position: 2,
        },
        aircraftClass: {
          description:
            'Optional next/previous aircraft class filter (e.g. helicopter).',
          $position: 1,
        },
      },
    },
  },
  set_visual_style: {
    description: "Set the active God's Eye View visual filter/style.",
    $position: 1,
  },
  get_entity_context: {
    description:
      'Get current GEV scene context, including basemap/3D-tile target context, selected entity metadata if active, and entities currently visible in the camera view.',
    $position: 1,
    parameters: {
      properties: {
        scope: {
          description:
            'Use auto by default. selected returns the clicked/selected entity; in_view returns visible entities near the screen center; pointer returns what the cursor is on.',
          $position: 2,
        },
        referent: {
          description: 'Numbered item n from the last result list.',
          $position: 1,
        },
        layerId: {
          description: 'Optional layer filter for visible entity context.',
          $position: 2,
        },
      },
    },
  },
  get_current_view_state: {
    description:
      'Read the current camera, style, Context, Cockpit, HUD, detection, map stack, post-processing, scene-playback, tracked-entity, layer state, layer opacity, Sky, History playback and Drone plan state before choosing another action. Tracked aircraft emergency status is a crowd-sourced transponder broadcast, not a confirmed incident: quote emergencyBroadcast and never infer a hijack or an incident ending from a code change.',
    $position: 1,
  },
  set_hud: {
    description:
      'Control the intelligence HUD overlay: visibility and/or layout variant.',
    $position: 1,
    parameters: {
      properties: {
        visible: {
          description: 'auto restores style-driven show/hide.',
          $position: 2,
        },
      },
    },
  },
  set_cyber_sonar: {
    description:
      'Adjust the Sonar visual style, which works over any HUD layout. Never switches layout or HUD visibility. Omitted fields stay unchanged. Returns actual settings and separate map/contact sweep activity. A saved setting does not mean the effect is active.',
    $position: 1,
    parameters: {
      properties: {
        enabled: { description: 'Explicitly turn sonar on or off.' },
        rings: { description: 'Number of decorative sonar rings, 3–12.' },
        rangePct: {
          description:
            'Visual ring range, 60–120 percent; not geographic distance.',
        },
        intensityPct: {
          description: 'Sonar Power slider, 0–100 percent. Zero is valid.',
        },
        opacityPct: {
          description:
            'Contact opacity floor between passes, 35–100 percent; labels have a derived floor. Not whole-scene dimming.',
        },
        sectorDeg: { description: 'Sonar sweep sector width, 8–60 degrees.' },
      },
    },
  },
  set_detection: {
    description:
      'Control the detection overlay: on/off, density-derived Sparse/Balanced/Dense profile, and Elastic/Weighted layer allocation.',
    $position: 1,
    parameters: {
      properties: {
        enabled: {
          description:
            'false turns detection OFF; true restores the current density-derived profile.',
          $position: 1,
        },
        densityPct: {
          description:
            'Density snaps to 0, 25, 50, 75, or 100 and derives the active profile.',
          $position: 1,
        },
        allocationStrategy: {
          description:
            'Elastic splits evenly then lends unused slots; Weighted follows demand and semantic weight.',
          $position: 2,
        },
      },
    },
  },
  set_map_stack: {
    description:
      'Switch the basemap/imagery stack (NOT the satellites data layer and NOT a visual style filter).',
    $position: 1,
    parameters: {
      properties: {
        stack: {
          description:
            'photoreal = Google 3D. Use bing-aerial only when the user explicitly says "Bing aerial" — "satellite(s)" never means a basemap; only the explicit phrase "Esri" / "Esri imagery" means esri-imagery. byrdit-open = "Byrd-IT map"; basemap-auto = "auto basemap".',
          $position: 2,
        },
      },
    },
  },
  set_post_processing: {
    description:
      'Control bloom and sharpen post-processing toggles and intensities.',
    $position: 1,
    parameters: {
      properties: {
        bloom: {
          properties: {
            intensityPct: {
              description: '0-200 (UI percent).',
              $position: 1,
            },
          },
        },
        sharpen: {
          properties: {
            intensityPct: {
              description: '0-100 (UI percent).',
              $position: 1,
            },
          },
        },
      },
    },
  },
  open_stories: {
    description:
      'Open the Stories Explore list on request ("open Stories", "show the story list"). Turns off voice.',
    $position: 1,
  },
  control_scene: {
    description:
      'Cinematic scene playback: list scenes, play one scene by name, stop, advance, or read status. Play starts a single named scene and returns immediately.',
    $position: 1,
    parameters: {
      properties: {
        sceneId: {
          description: 'Scene id or (partial) title for play.',
          $position: 1,
        },
      },
    },
  },
  control_cctv: {
    description:
      'CCTV camera operations: enable/disable the layer, select a camera by name, next/prev/nearest/focus, toggle coverage wedges / projection overlay / auto-hop, "viewshed" for color-coded per-camera coverage volumes, and "adjust" for the on-camera calibration gizmo.',
    $position: 1,
    parameters: {
      properties: {
        cameraQuery: {
          description: 'Camera name or id for select.',
          $position: 1,
        },
        enabled: {
          description:
            'Explicit on/off for coverage/viewshed/adjust/projection/autohop; omit to toggle.',
          $position: 1,
        },
      },
    },
  },
  control_radio: {
    description:
      'Control Internet Radio playback without moving the map. Use select whenever the request includes a station category, name, country, coordinates, or nearby place—even when the user says play. Use play only for an unqualified "turn on/start the radio" request so the current or nearest station begins. Enable only reveals the Radio layer/markers without audio. Also supports disable, resume, pause, stop, next/previous, volume, and status.',
    $position: 1,
    parameters: {
      properties: {
        action: {
          description:
            'Use select for any request qualified by category, station, country, coordinates, or place. Use play only for an unqualified turn on/start/listen request. Use enable only when the user explicitly asks to show or enable the Radio layer or its markers without requesting audio.',
          $position: 2,
        },
        volumePct: {
          description:
            'Required for volume; sets the persistent Radio playback volume.',
          $position: 3,
        },
        category: {
          description:
            'Station category for select/next/previous. When the user requests playback with a category, action must be select, not play.',
          $position: 2,
        },
        locationId: {
          description: 'Known nearby-city anchor for select.',
          $position: 2,
        },
        locationQuery: {
          description:
            'Place to search near, such as "Austin, Texas" or "Seattle". Selection does not fly the camera.',
          $position: 2,
        },
        country: {
          description:
            'Country code or name filter, for example US or United States.',
          $position: 2,
        },
        stationQuery: {
          description: 'Optional station name/tag substring.',
          $position: 2,
        },
      },
    },
  },
  track_entity: {
    description:
      'Find and follow a specific aircraft (callsign/ICAO hex), ship (name/MMSI), or satellite (name/NORAD id) on enabled layers. Camera follows the entity.',
    $position: 1,
    parameters: {
      properties: {
        query: {
          description:
            'Callsign, ship name, satellite name, ICAO hex, MMSI, or NORAD id. "pointer" = the contact under the cursor.',
          $position: 1,
        },
        referent: {
          description:
            'Numbered item n from the last result list (-1 = last); query may then be its label.',
          $position: 1,
        },
        layerId: {
          description:
            'Optional: flights, military, ais-live-vessels or satellites. Other layers are not trackable; for fires use query "biggest fire".',
          $position: 1,
        },
      },
    },
  },
  stop_tracking: {
    description:
      'Stop following the tracked aircraft/satellite and clear any selected vessel.',
    $position: 1,
  },
  frame_overhead: {
    description:
      'Cinematically frame entities near the current view: pulls the camera back and angles it so nearby aircraft, ships, or satellites are visible together.',
    $position: 1,
    parameters: {
      properties: {
        radiusKm: {
          description:
            'Search radius around the view target. Defaults: 150 aircraft, 120 ships, 3000 satellites.',
          $position: 1,
        },
      },
    },
  },
  annotate_map: {
    description:
      'Mark places on the 3D map as you talk about them (see WHITEBOARD): pins, highlights, footprints, arrows, routes and labels. Give place names (or explicit lat/lng); the app resolves real positions and outlines. Several places may go in one call.',
    $position: 1,
    parameters: {
      properties: {
        annotations: {
          description:
            'One or more things to mark. Mark multiple related places together when describing them as a group.',
          $position: 1,
          items: {
            properties: {
              type: {
                description:
                  'pin = planted marker at a spot; highlight = pulsing ring drawing the eye to a point; area = trace the outline of a building/campus/compound/district; arrow = a connector from one place to another (use target as the origin and toTarget as the destination); route = a path through several waypoints (use the points array); label = a floating text callout.',
                $position: 2,
              },
              target: {
                description:
                  'Place name to resolve ("Palace of Fine Arts, San Francisco"), or "pointer" for the spot under the cursor. A monument inside a larger landmark gets its own name + city ("Tejano Monument, Austin"), never "X at the Texas State Capitol" (that stacks them on one centroid).',
                $position: 2,
              },
              points: {
                description:
                  'For type=route: 2+ ordered waypoints the path passes through, each a place name (or coordinates / screen point).',
                $position: 1,
                items: {
                  properties: {
                    target: {
                      description: 'Waypoint place name.',
                      $position: 2,
                    },
                  },
                },
              },
              mode: {
                description:
                  'For type=route: travel mode for a real street-following route (the app returns distance + time). Pick from the verb the user used ("walk" → walking, "drive" → driving). Defaults to walking.',
                $position: 2,
              },
              latitude: {
                description:
                  'Explicit latitude (use only if no good place name exists).',
                $position: 3,
              },
              toTarget: {
                description: 'For type=arrow: the destination place name.',
                $position: 2,
              },
              label: {
                description:
                  'Short caption shown on the map (a few words). Optional.',
                $position: 2,
              },
              color: {
                description:
                  'Accent color. primary = neutral, amber = point of interest, cyan = infrastructure, green = confirmed/safe, red = alert.',
                $position: 2,
              },
              footprint: {
                description:
                  'For type=area/highlight: trace the real building or campus outline from map data. Defaults true for area.',
                $position: 1,
              },
              intent: {
                description:
                  'For type=area: "the_thing" (default) outlines the place itself (its footprint/boundary); "around_the_thing" highlights a surrounding zone (a buffered radius around it). Infer from phrasing: "the Capitol"/"show me X" → the_thing; "around/near/by X" or "the area around X" → around_the_thing.',
                $position: 2,
              },
              entityKind: {
                description:
                  'What the target IS (a fact, not a style): building = one structure; compound = campus/grounds/mall/park; district = neighborhood; street = a named road; point_feature = monument/statue/memorial/fountain, anchored as a precise point. Set it whenever you know it.',
                $position: 2,
              },
              screenX: {
                description:
                  'Fallback only, for a spot visible in the latest screenshot that you cannot name: normalized x (0=left, 1=right).',
                $position: 3,
              },
              screenY: {
                description: 'Fallback only: normalized y (0=top, 1=bottom).',
                $position: 3,
              },
              toScreenX: {
                description: 'For type=arrow: destination x (pixel fallback).',
                $position: 3,
              },
              toScreenY: {
                description: 'For type=arrow: destination y (pixel fallback).',
                $position: 3,
              },
            },
          },
        },
        flyTo: {
          description:
            'Also move the camera to frame the first annotation. Default false — leave false if the user is already looking at the spot.',
          $position: 1,
        },
        persist: {
          description:
            'Keep annotations until cleared (true, default) or let them auto-fade after ~20s (false).',
          $position: 1,
        },
      },
    },
  },
  clear_annotations: {
    description:
      'Erase ALL map annotations previously drawn with annotate_map. Call this ONLY when the user EXPLICITLY asks to clear or reset the map. Annotations accumulate and persist across navigation and topic changes by design — never clear on your own initiative.',
    $position: 1,
  },
  move_camera: {
    description:
      'Direct the camera like a drone operator: orbit the current view target, pan, tilt, or rotate — one bounded nudge (mode=once) or continuous motion until stopped (mode=continuous). Continuous motion also stops on any manual camera input or when a navigation tool runs. Say the RESULTING state when confirming ("Orbiting slowly"). Globe rotation (rotate_globe) spins Earth right continuously by default; explicit direction, mode and speed take precedence. It checks fit and may refuse.',
    $position: 1,
    parameters: {
      properties: {
        direction: {
          description:
            'Pan/rotate/tilt steps; orbit/rotate_globe default right.',
          $position: 2,
        },
        mode: {
          description:
            'once = bounded eased nudge; continuous = until stop/manual input. rotate_globe defaults continuous; other motions default once.',
          $position: 2,
        },
        pitchDeg: {
          description: 'Absolute; -45 default, -89 top-down.',
          $position: 1,
        },
      },
    },
  },
  fly_route: {
    description:
      'Cinematic dolly along an EXISTING route annotation (drawn earlier with annotate_map type=route) — flies the street-following path from start to end. Omit label for the newest route. If no route is drawn, this fails with guidance: draw the route first.',
    $position: 1,
    parameters: {
      properties: {
        label: {
          description: 'Match an existing route mark by (partial) label.',
          $position: 1,
        },
      },
    },
  },
  resolve_area: {
    description:
      'Named place → reusable areaId for analyst_query scope {kind:area} and other area tools. draw=true outlines it ("outline Bagmati province"); around=true is "an area around <landmark>": its enclosing mapped area, else a buffer marked approximate. needsClarification: ask which, then call again with its candidateId. AREA_TIMEOUT: retry once.',
    $position: 1,
    parameters: {
      properties: {
        query: {
          description: 'The place as said, with any kind word.',
          $position: 1,
        },
        level: {
          description: 'Only when the user names the kind.',
          $position: 1,
        },
        within: {
          description: 'Country or state the user added.',
          $position: 1,
        },
      },
    },
  },
  find_imagery: {
    description:
      'Recent satellite imagery (Sentinel-2/Landsat 30 m, VIIRS daily; last 30 days): pins the best acquisition in the Recent Imagery panel. areaId from resolve_area; area=pointer for "this spot"; omit for the view. BOX_REFUSED: offer to zoom in. DISPLACED: leave it.',
    $position: 1,
    parameters: {
      properties: {
        maxCloudPct: {
          description: '"cloud-free" → 10.',
          $position: 1,
        },
      },
    },
  },
  osm_query: {
    description:
      'OpenStreetMap places of one kind ("hospitals in Kathmandu"). areaId from resolve_area; omit for the view. Shows them in OSM Places with numbered referents; they become the last answer. countScope bounding-box means an approximate count. OSM_TIMEOUT: retry once.',
    $position: 1,
  },
  analyst_query: {
    description:
      'Query ENABLED layer records for counts, lists, rankings and filters. complete:false means at least count, ranking only examined records; partial names unanswered layers. Items have lat/lon. LAYER_OFF: offer enable; NOT_READY: loading; NEEDS_CLARIFICATION: ask; FOLLOW_UP_MISMATCH: retry without followUp; UNKNOWN_FIELD/UNKNOWN_SCOPE/BAD_VALUE: retry allowed values. Aircraft emergencies are broadcasts, not confirmed incidents: say emergencyBroadcast and emergencySource. emergencyKind: general, unlawful, nordo, downed, minfuel, lifeguard; last two are priorities (emergency:false). lastContactAtMs is last transponder contact, not status arrival.',
    $position: 1,
    parameters: {
      properties: {
        layers: {
          description:
            'Layers to query. fires → local-firms; ships → ais-live-vessels; buses/trains → transit; hurricanes → weather-cyclones; bases → military-installations; my receiver → local-adsb. Units differ per layer, so rank speed within one layer.',
          $position: 2,
        },
        scope: {
          description:
            'Always set (see WHERE). "in view" = view; "nearby" = view when Contacts is off. Active Contacts subject: radius with requested km, omit center, never view. While pointing, "around here/this" = pointer; "over Texas" = region; "near <place>" or coordinates = radius with center {lat,lon}; no place = anywhere; area uses resolve_area areaId; "the area I drew" = drawn; "the area you outlined" = annotation.',
          $position: 2,
          properties: {
            name: {
              description:
                'For kind=region: a state/country ("Texas", "France") or a named natural region ("the Alps", "Gulf of Mexico").',
              $position: 1,
            },
            km: {
              description:
                'For kind=radius or pointer: the actual requested kilometers.',
              $position: 1,
            },
            center: {
              description:
                'Omit for a radius around the active Contacts subject. Supply only an explicitly requested coordinate or a resolved named-place coordinate; never invent 0,0 or replace an explicit center with the subject.',
              $position: 1,
            },
          },
        },
        filters: {
          description: `ANDed; values keep their type (numbers, true/false). Altitude is meters (40,000 ft = 12192). Time fields take ISO; ageHours = hours ago. Every layer has id, lat, lon. Fields — ${voiceQueryFieldHint()}.`,
          $position: 1,
        },
        sortBy: {
          description:
            'Field to rank by, or "distance" (nearest first unless sortDir=desc).',
          $position: 1,
        },
        followUp: {
          description:
            'true = re-filter the last answer (its layers) instead of fresh data.',
          $position: 1,
        },
      },
    },
  },
  next_iss_pass: {
    description:
      'Next ISS pass over the camera location (or lat/lon): rise time, direction, peak elevation, duration and estimated visibility. Needs the satellites layer to have loaded once; if not, ask the user to enable it.',
    $position: 1,
    parameters: {
      properties: {
        latitude: {
          description:
            'Optional observer latitude. Omit to use the current camera position.',
          $position: 3,
        },
        longitude: {
          description:
            'Optional observer longitude. Omit to use the current camera position.',
          $position: 3,
        },
        minElevationDeg: {
          description:
            'Minimum peak elevation (deg) to count as a pass. Default 10.',
          $position: 3,
        },
      },
    },
  },
  next_satellite_pass: {
    description:
      'Predict the next pass in 24 hours for one satellite in the loaded catalog, identified by exact NORAD ID or name. Ambiguous names return candidates: ask for a choice rather than selecting one. Defaults to geometric passes; visibleOnly requires estimated illumination and a dark observer sky, which does not guarantee naked-eye visibility. Uses camera location unless coordinates are supplied.',
    $position: 1,
  },
  control_history: {
    description:
      'History: jump to the 1957-10-04 floor (coverage varies), play, pause, speed, live, feeds, preset, expand or lock rows. Say the resulting state.',
    $position: 1,
    parameters: {
      properties: {
        action: {
          description:
            'jump needs time or minutesAgo; speed needs rate; feeds needs feeds. preset needs preset; expand needs expanded; lock needs historyRow and locked. live leaves History; play and pause need History open.',
          $position: 2,
        },
        time: {
          description:
            'For jump: ISO 8601 date-time WITH a zone, e.g. 2026-03-04T15:30:00Z or 2026-03-04T09:30:00-06:00. Convert the spoken local time first; a date alone means 00:00 UTC.',
          $position: 1,
        },
        preset: { description: 'History window preset.', $position: 2 },
        expanded: { description: 'Whether History is expanded.', $position: 1 },
        locked: {
          description: 'Whether the row follows History.',
          $position: 1,
        },
        historyRow: {
          description: 'History row id, not feed id.',
          $position: 2,
        },
        minutesAgo: {
          description:
            'For jump: relative time instead of time (\"an hour ago\" = 60, \"yesterday\" = 1440).',
          $position: 2,
        },
        rate: {
          description:
            'For speed: history seconds per real second: 1, 10, 60 or 600.',
          $position: 2,
        },
        feeds: {
          description:
            'For feeds: layer ids that play from History. Flights, military and ships = flights, military, ais-live-vessels; fires = local-firms; quakes = earthquakes.',
          $position: 1,
        },
        feedMode: {
          description:
            'For feeds: only (default) plays just the listed feeds and turns the other History feeds off; add turns the listed feeds on; remove turns them off.',
          $position: 2,
        },
      },
    },
  },
  control_sky: {
    description:
      'Sky: open/close, look, time/live, lines, preset, playback, layers, magnitude, location, clear, status. Open uses map centre; ISS look differs from next-pass preset. Confirm state.',
    $position: 1,
    parameters: {
      properties: {
        action: {
          description:
            'open, close, look, time, lines, preset, status, play, pause, speed (rate), step (stepMs), reverse, layers (layer and enabled), magnitude, location (latitude and longitude), or clear (enabled).',
          $position: 2,
        },
        rate: { description: 'Sky playback seconds per second.', $position: 2 },
        stepMs: {
          description: 'Signed clock step in milliseconds.',
          $position: 2,
        },
        layer: { description: 'Sky layer switch.', $position: 2 },
        magnitude: {
          description: 'Faintest limit: stars 3-6.5; satellites 3-7.',
          $position: 3,
        },
        magnitudeTarget: {
          description: 'Stars (default) or satellites.',
          $position: 2,
        },
        latitude: {
          description: 'Observer latitude in degrees.',
          $position: 3,
        },
        longitude: {
          description: 'Observer longitude in degrees.',
          $position: 3,
        },
        target: {
          description:
            'For look: a planet (Jupiter), the ISS, or a constellation (Orion). One name.',
          $position: 1,
        },
        time: {
          description:
            'For time: ISO 8601 WITH a zone, e.g. 2026-03-04T02:00:00Z or 2026-03-03T20:00:00-06:00. Convert the spoken local time first; a date alone means 00:00 UTC.',
          $position: 1,
        },
        live: {
          description:
            'For time: true returns the sky clock to now. When true, live wins over time.',
          $position: 1,
        },
        enabled: {
          description: 'For lines, layers or clear: true on, false off.',
          $position: 1,
        },
        preset: {
          description:
            'sunset, dusk (end of astronomical twilight), midnight (solar midnight), moonrise, or iss (start of the next ISS pass, not a look-at).',
          $position: 2,
        },
      },
    },
  },
  control_imagery: {
    description:
      'Imagery: aerial year/compare/yearB, Wayback date and playback, latest/step, Recent Imagery mode/opacity/swap, off or status. Only claim imagery is visible when drawn or shown is true.',
    $position: 1,
    parameters: {
      properties: {
        action: {
          description:
            'year, wayback, off, status, compare (enabled, optional yearB), yearB, latest, step (delta), play, pause, speed (rate 1/2/4), mode (0 image, 1 basemap, 2 A/B), opacity (0-100), swap.',
          $position: 2,
        },
        yearB: { description: 'Aerial comparison year.', $position: 3 },
        enabled: {
          description: 'Turn aerial comparison on or off.',
          $position: 1,
        },
        delta: {
          description: 'Signed number of aerial or Wayback steps.',
          $position: 1,
        },
        rate: {
          description: 'Wayback playback speed 1, 2 or 4.',
          $position: 2,
        },
        mode: {
          description: 'Recent Imagery mode: 0 image, 1 basemap, 2 A/B.',
          $position: 2,
        },
        opacityPct: {
          description: 'Recent Imagery opacity percent.',
          $position: 3,
        },
        year: {
          description:
            'For year: the aerial year, such as 1940, 2018 or 2024. Not an enum; an unknown year returns the valid years from the live catalog.',
          $position: 1,
        },
        county: {
          description:
            'For year, optional: a county with a set that year (Titus, Camp, Franklin, Wood, Upshur). Frames that set. Omit to show every set of the year.',
          $position: 1,
        },
        date: {
          description:
            'For wayback: a year (2014) or YYYY-MM-DD. A year uses the latest release in that year. An unknown date returns the valid years.',
          $position: 1,
        },
        target: {
          description:
            'For off: aerial, wayback or both; for latest/step: aerial or wayback. Default aerial.',
          $position: 1,
        },
      },
    },
  },
  control_droneplan: {
    description:
      'Drone Flight Plan: open shows the rail; draw starts box or polygon (the person must draw); box/polygon set coordinates. recommend applies current-aircraft settings; options changes controls. takeoff: pick, clear (box centre) or point (lat/lon). suite plans recommended passes; download requires downloads=true. finish/undo/corner edit the polygon; edit drags a committed area; obstacle/target/path manage those lists; check and photoCheck read the 3D check and photo coverage; units switches feet and metres; library and loadPlan read and restore saved plans; preview draws a flight picture. close clears the globe plan. Report actual aircraft, mode and counts. NOT FLIGHT-TESTED: never claim a mission is safe.',
    $position: 1,
    parameters: {
      properties: {
        action: {
          description:
            'open, close, status, draw (kind box or polygon), box (west south east north), polygon (ring), recommend (mode optional), options, takeoff (pick, clear or point), remove (areaId), replan, suite, download (which mission, all or suite; index for one), edit (areaId or index), obstacle, target, path, preview (index), library, loadPlan (plan), photoCheck, check (index and the 3D switches or surface settings), units (ft or m), finish, undo, or corner.',
          $position: 2,
        },
        kind: {
          description: 'draw: box or polygon.',
          $position: 1,
        },
        west: {
          description: 'box: west longitude.',
          $position: 1,
        },
        south: {
          description: 'box: south latitude.',
          $position: 1,
        },
        east: {
          description: 'box: east longitude.',
          $position: 1,
        },
        north: {
          description: 'box: north latitude.',
          $position: 1,
        },
        ring: {
          description:
            'polygon: three or more corners as lon/lat, in order. For path: two or more camera aim points, in order.',
          $position: 1,
        },
        aircraft: {
          description:
            'options: a catalog aircraft name or preset id, such as Mini 5 Pro or dji-phantom-4. Unknown names return no match.',
          $position: 1,
        },
        mode: {
          description:
            'recommend/options: mapping-grid, mapping-grid-timed, splat-orbit or fast-survey; sets the pattern, photo mode and trigger it implies.',
          $position: 1,
        },
        pattern: {
          description:
            'options: grid (one grid), double (crossed) or orbit (rings round a target).',
          $position: 1,
        },
        direction: {
          description:
            'options: auto, ew (east-west lines) or ns (north-south lines).',
          $position: 1,
        },
        jobs: {
          description:
            'options: per-area (one mission per drawn area) or whole (one mission over all).',
          $position: 1,
        },
        photoMode: {
          description:
            'options: waypoint (stop at each waypoint to shoot) or interval (shoot along the leg).',
          $position: 1,
        },
        aglM: {
          description: 'options: height above ground, m, 10-457.2 (1500 ft).',
          $position: 1,
        },
        frontOverlap: {
          description: 'options: front overlap percent, 50-98.',
          $position: 1,
        },
        sideOverlap: {
          description: 'options: side overlap percent, 40-95.',
          $position: 1,
        },
        tiltPitchDeg: {
          description:
            'options: grid camera tilt from nadir, deg, -80 to -45 (-90 is straight down, not a survey tilt).',
          $position: 1,
        },
        orbitRadiusM: {
          description: 'options: orbit ring radius, m, 10-300.',
          $position: 1,
        },
        orbitHeightsM: {
          description:
            'options: up to 6 fixed ring heights above ground, m, 10-457.2; setting them switches the rings to heights.',
          $position: 1,
        },
        speedMs: {
          description: 'options: flight speed, m/s, 0.1-15.',
          $position: 1,
        },
        timedIntervalS: {
          description:
            'options: Timed-shot interval, seconds, as set in DJI Fly; any value above 0 up to 3600.',
          $position: 1,
        },
        shutterDenominator: {
          description:
            'options: shutter speed as a denominator: 250, 500, 1000, 2000 or 4000.',
          $position: 1,
        },
        batteryMin: {
          description:
            'options: usable minutes per battery for the pause estimate, 5-60.',
          $position: 1,
        },
        droneEnumValue: {
          description:
            'options: the DJI model code written into the KMZ, 0-999.',
          $position: 1,
        },
        clearDroneCode: {
          description:
            'options: true removes the model code, so DJI Fly asks for the model once.',
          $position: 1,
        },
        takeoff: {
          description: 'takeoff: pick, clear, or point.',
          $position: 1,
        },
        lat: {
          description:
            'takeoff point, target or obstacle: latitude. For path, put points in ring.',
          $position: 1,
        },
        lon: {
          description:
            'takeoff point, target or obstacle: longitude. For path, put points in ring.',
          $position: 1,
        },
        areaId: {
          description:
            'remove/edit: the area id (area-1, area-2 ...) as status reports it.',
          $position: 1,
        },
        which: {
          description: 'download: mission, all, or suite.',
          $position: 1,
        },
        index: {
          description:
            'A zero-based position in a list status reports: the mission for download/preview, the area for edit, the obstacle/target/path to remove, or the flight whose photos the 3D check shows.',
          $position: 1,
        },
        checkEnabled: {
          description: 'check: true shows the 3D check, false hides it.',
          $position: 1,
        },
        checkZone: {
          description:
            'check: true shows the safety zone along the route, false hides it.',
          $position: 1,
        },
        checkCurtain: {
          description: 'check: true shows the height curtain, false hides it.',
          $position: 1,
        },
        checkFootprints: {
          description:
            'check: photo footprints to draw: selected (the photo in view), all, or off.',
          $position: 1,
        },
        checkFrustum: {
          description:
            'check: camera view shape: one (the photo in view), thinned, neighbors (that photo and the ones beside it), or off.',
          $position: 1,
        },
        zoneHalfWidthM: {
          description:
            'check: safety zone half-width each side of the route, m, 2-30.',
          $position: 1,
        },
        surfaceEnabled: {
          description:
            'check: true checks the route against the photogrammetry surface model, false does not; warns only, never moves it.',
          $position: 1,
        },
        surfaceMinM: {
          description: 'check: surface model minimum clearance, m, 0-61.',
          $position: 1,
        },
        surfaceMarginM: {
          description:
            'check: position error margin added to the surface clearance, m, 0-61.',
          $position: 1,
        },
        captureMode: {
          description:
            'options: shot trigger: stop, distance, or timed (needs timedIntervalS).',
          $position: 1,
        },
        photoSpacingM: {
          description:
            'options: metres between photos on the distance (or timed-with-distance) trigger, above 0.',
          $position: 1,
        },
        orbitAnglesDeg: {
          description:
            'options: up to 6 viewing angles down from level, deg, each 10-80.',
          $position: 1,
        },
        orbitOutward: {
          description:
            'options: true takes a second, outward-facing photo at each orbit stop.',
          $position: 1,
        },
        orbitOutwardPitchDeg: {
          description:
            'options: outward photo tilt, deg down, -45 to 0 (0 is level).',
          $position: 1,
        },
        orbitTargetHeightM: {
          description:
            'options: height of the aim point above the target, m, 0-60.',
          $position: 1,
        },
        obstacleHeightM: {
          description:
            'options: default obstacle height, m, 0-60; for obstacle with an index, that obstacle new height.',
          $position: 1,
        },
        maxWaypoints: {
          description:
            'options: most waypoints per file, 20-200; larger plans split into more missions.',
          $position: 1,
        },
        usableBatteryMin: {
          description:
            'options: usable minutes per battery for the pause estimate, 5-60.',
          $position: 1,
        },
        continuousRoute: {
          description:
            'options: true keeps one continuous route; false breaks it between lines.',
          $position: 1,
        },
        cameraPresetId: {
          description:
            'options: a camera preset id from the panel list, such as mapping-50mp.',
          $position: 1,
        },
        minPhotoIntervalS: {
          description:
            'options: this plan camera minimum interval, seconds, 0.1-60, overriding the aircraft preset.',
          $position: 1,
        },
        exportCompact: {
          description:
            'options: true writes the compact KMZ, unverified on a controller.',
          $position: 1,
        },
        units: {
          description:
            'units: ft (feet) or m (metres); shown and typed lengths only.',
          $position: 1,
        },
        plan: {
          description:
            'loadPlan: a saved .gevplan document as an object; it replaces the panel plan and replans it.',
          $position: 1,
        },
      },
    },
  },
  set_clean_view: {
    description:
      'Clean view hides panels and controls without changing camera or layers. enabled true hides, false restores. Report the resulting state or unavailability.',
    $position: 1,
    parameters: {
      properties: {
        enabled: {
          description:
            'True for clean view (panels hidden), false to bring them back.',
          $position: 1,
        },
      },
    },
  },
  set_layer_opacity: {
    description:
      'Set layer opacityPct, 0 invisible to 100 solid; this does not toggle the layer or move the camera. Use set_layer_visibility to toggle. Recent imagery has its own opacity control. Report the resulting percent or refusal.',
    $position: 1,
    parameters: {
      properties: {
        layerId: {
          description:
            'Layer to fade; use the same IDs as set_layer_visibility.',
          $position: 1,
        },
        opacityPct: {
          description: 'Opacity percent: 0 invisible, 100 solid.',
          $position: 1,
        },
      },
    },
  },
  control_nav: {
    description:
      'Control map navigation: tilt, compass heading, zoom, top down, north up, look, or read status. Tilt is the slider angle 0 to 179 degrees from top-down. Report actual state or refusal.',
    $position: 1,
    parameters: {
      properties: {
        action: { description: 'Navigation operation.', $position: 1 },
        tilt: {
          description: 'Tilt slider degrees from top-down, 0 to 179.',
          $position: 1,
        },
        heading: {
          description: 'Compass bearing in degrees, 0 to 359.',
          $position: 1,
        },
        direction: {
          description: 'Zoom in or out; look up, down, left or right.',
          $position: 1,
        },
        steps: {
          description: 'Number of zoom or look steps, 1 to 10.',
          $position: 1,
        },
      },
    },
  },
  control_solunar: {
    description:
      'Open Solunar, select a spot or map center, set 12/24 hour clock, or report sun and moon times and ratings for the selected spot. Report actual state or refusal.',
    $position: 1,
    parameters: {
      properties: {
        action: { description: 'Solunar operation.', $position: 1 },
        latitude: { description: 'Spot latitude in degrees.', $position: 1 },
        longitude: { description: 'Spot longitude in degrees.', $position: 1 },
        hour12: {
          description: 'True for 12-hour, false for 24-hour clock.',
          $position: 1,
        },
      },
    },
  },
  control_ghostmaps: {
    description:
      'Control GhostMaps products and event age. Enable the layer first.',
    parameters: {
      properties: {
        product: { description: 'GhostMaps product ID. Pair with enabled.' },
        enabled: { description: 'Whether the selected product is enabled.' },
        ageDays: {
          description: 'Maximum event age in days, or all for every age.',
        },
      },
    },
  },
  control_overlays: {
    description:
      'Control map overlays, not data layers. Report state and refusals. Drawn means mounted, not necessarily visible.',
    $position: 1,
    parameters: {
      properties: {
        action: {
          description:
            'enable (overlayId, enabled), opacity (overlayId, opacityPct), raise/lower (overlayId), phone_mode (enabled), or status.',
          $position: 1,
        },
        overlayId: {
          description: 'Overlay ID from status, not a data-layer ID.',
          $position: 1,
        },
        enabled: {
          description: 'For enable or phone_mode: true on, false off.',
          $position: 1,
        },
        opacityPct: {
          description: 'Opacity percent, 0 to 100.',
          $position: 1,
        },
      },
    },
  },
};
