import { HUD_LAYOUTS } from '../hudLayoutPolicy.js';
import {
  AREA_CANDIDATE_ID_PATTERN,
  MAX_AREA_CANDIDATE_ID_LENGTH,
} from './areaCandidateContract.js';

// Canonical action arguments. Descriptive wording is supplied separately.
import {
  VOICE_CONTEXT_LAYER_IDS,
  VOICE_QUERY_LAYER_IDS,
  VOICE_TOGGLE_LAYER_IDS,
} from './layerManifest.js';

// Layer enums come from the voice layer manifest so every shipped layer is
// reachable; the manifest test keeps it in step with the layer catalog.
const toggleLayerIds = () => [...VOICE_TOGGLE_LAYER_IDS];

const schemas = [
  {
    name: 'fly_to_location',
    parameters: {
      type: 'object',
      additionalProperties: false,
      properties: {
        locationId: {
          type: 'string',
          enum: [
            'austin',
            'sf',
            'nyc',
            'tokyo',
            'london',
            'paris',
            'dubai',
            'dc',
          ],
        },
        query: {
          type: 'string',
        },
        latitude: {
          type: 'number',
          minimum: -90,
          maximum: 90,
        },
        longitude: {
          type: 'number',
          minimum: -180,
          maximum: 180,
        },
        viewMode: {
          type: 'string',
          enum: ['close', 'overview'],
        },
        rangeM: {
          type: 'number',
          minimum: 100,
          maximum: 20000000,
        },
        waitForArrival: {
          type: 'boolean',
        },
        referent: {
          type: 'integer',
        },
      },
    },
  },
  {
    name: 'select_nearest_aircraft',
    parameters: {
      type: 'object',
      additionalProperties: false,
      properties: {
        layerId: {
          type: 'string',
          enum: ['flights', 'military'],
        },
        locationId: {
          type: 'string',
          enum: [
            'austin',
            'sf',
            'nyc',
            'tokyo',
            'london',
            'paris',
            'dubai',
            'dc',
          ],
        },
        locationQuery: {
          type: 'string',
          maxLength: 160,
        },
        latitude: {
          type: 'number',
          minimum: -90,
          maximum: 90,
        },
        longitude: {
          type: 'number',
          minimum: -180,
          maximum: 180,
        },
      },
      required: ['layerId'],
    },
  },
  {
    name: 'show_street_level',
    parameters: {
      type: 'object',
      additionalProperties: false,
      properties: {
        query: {
          type: 'string',
          maxLength: 160,
        },
        latitude: {
          type: 'number',
          minimum: -90,
          maximum: 90,
        },
        longitude: {
          type: 'number',
          minimum: -180,
          maximum: 180,
        },
        provider: {
          type: 'string',
          enum: ['google', 'mapillary', 'kartaview', 'panoramax'],
        },
        referent: {
          type: 'integer',
        },
      },
    },
  },
  {
    name: 'adjust_camera_zoom',
    parameters: {
      type: 'object',
      additionalProperties: false,
      properties: {
        direction: {
          type: 'string',
          enum: ['in', 'out'],
        },
        amount: {
          type: 'string',
          enum: ['little', 'medium', 'lot'],
        },
      },
      required: ['direction', 'amount'],
    },
  },
  {
    name: 'zoom_to_globe',
    parameters: {
      type: 'object',
      additionalProperties: false,
      properties: {},
    },
  },
  {
    name: 'set_layer_visibility',
    parameters: {
      type: 'object',
      additionalProperties: false,
      properties: {
        layerId: {
          type: 'string',
          enum: toggleLayerIds(),
        },
        enabled: {
          type: 'boolean',
        },
      },
      required: ['layerId', 'enabled'],
    },
  },
  {
    name: 'show_data_layers_menu',
    parameters: {
      type: 'object',
      additionalProperties: false,
      properties: {
        layerId: {
          type: 'string',
          enum: toggleLayerIds(),
        },
      },
    },
  },
  {
    name: 'set_panel_open',
    parameters: {
      type: 'object',
      additionalProperties: false,
      properties: {
        panelId: {
          type: 'string',
          enum: [
            'data-panel',
            'location-bar',
            'control-panel',
            'cctv-panel',
            'radio-panel',
            'scene-panel',
            'utilities-panel',
            'pp-toggles',
            'global-context-panel',
            'space-missions-panel',
            'weather-panel',
            'recent-imagery-panel',
            'voice-settings',
            'voice-preview',
            'provider-settings',
            // The right-rail panels (Byrd-IT fork): Time Travel, Map Layers,
            // Solunar and Drone Flight Plan.
            'time-travel-panel',
            'map-layers-panel',
            'solunar-panel',
            'drone-plan-panel',
          ],
        },
        open: {
          type: 'boolean',
        },
      },
      required: ['panelId', 'open'],
    },
  },
  {
    name: 'set_voice_inactivity_timeout',
    parameters: {
      type: 'object',
      additionalProperties: false,
      properties: { minutes: { type: 'integer', minimum: 0, maximum: 60 } },
      required: ['minutes'],
    },
  },
  {
    name: 'set_context_mode',
    parameters: {
      type: 'object',
      additionalProperties: false,
      properties: {
        mode: {
          type: 'string',
          enum: ['off', 'contacts', 'flights', 'space-missions', 'missions'],
        },
      },
      required: ['mode'],
    },
  },
  {
    name: 'control_cockpit',
    parameters: {
      type: 'object',
      additionalProperties: false,
      properties: {
        action: {
          type: 'string',
          enum: ['enter', 'exit', 'previous', 'next', 'prev', 'status'],
        },
        targetLayer: {
          type: 'string',
          enum: [
            'flights',
            'military',
            'ais-live-vessels',
            'military-installations',
          ],
        },
        aircraftClass: {
          type: 'string',
        },
        voicePanel: { type: 'string', enum: ['preview', 'settings'] },
      },
      required: ['action'],
    },
  },
  {
    name: 'set_visual_style',
    parameters: {
      type: 'object',
      additionalProperties: false,
      properties: {
        style: {
          type: 'string',
          enum: ['normal', 'retro', 'surveillance', 'thermal', 'anime', 'noir'],
        },
      },
      required: ['style'],
    },
  },
  {
    name: 'get_entity_context',
    parameters: {
      type: 'object',
      additionalProperties: false,
      properties: {
        scope: {
          type: 'string',
          enum: ['auto', 'selected', 'in_view', 'pointer'],
        },
        referent: {
          type: 'integer',
        },
        layerId: {
          type: 'string',
          enum: [...VOICE_CONTEXT_LAYER_IDS],
        },
        limit: {
          type: 'number',
          minimum: 1,
          maximum: 12,
        },
      },
    },
  },
  {
    name: 'get_current_view_state',
    parameters: {
      type: 'object',
      additionalProperties: false,
      properties: {},
    },
  },
  {
    name: 'set_hud',
    parameters: {
      type: 'object',
      additionalProperties: false,
      properties: {
        visible: {
          type: 'string',
          enum: ['on', 'off', 'auto'],
        },
        layout: {
          type: 'string',
          enum: [...HUD_LAYOUTS],
        },
      },
    },
  },
  {
    name: 'set_cyber_sonar',
    parameters: {
      type: 'object',
      additionalProperties: false,
      properties: {
        enabled: { type: 'boolean' },
        rings: { type: 'integer', minimum: 3, maximum: 12 },
        rangePct: { type: 'integer', minimum: 60, maximum: 120 },
        intensityPct: { type: 'integer', minimum: 0, maximum: 100 },
        opacityPct: { type: 'integer', minimum: 35, maximum: 100 },
        sectorDeg: { type: 'integer', minimum: 8, maximum: 60 },
      },
    },
  },
  {
    name: 'set_detection',
    parameters: {
      type: 'object',
      additionalProperties: false,
      properties: {
        enabled: {
          type: 'boolean',
        },
        mode: {
          type: 'string',
          enum: ['sparse', 'balanced', 'dense'],
        },
        densityPct: {
          type: 'number',
        },
        allocationStrategy: {
          type: 'string',
          enum: ['elastic', 'weighted'],
        },
      },
    },
  },
  {
    name: 'set_map_stack',
    parameters: {
      type: 'object',
      additionalProperties: false,
      properties: {
        stack: {
          type: 'string',
          enum: [
            'photoreal',
            'bing-aerial',
            'bing-labels',
            'esri-imagery',
            'osm',
            'byrdit-open',
            'basemap-auto',
          ],
        },
      },
      required: ['stack'],
    },
  },
  {
    name: 'set_post_processing',
    parameters: {
      type: 'object',
      additionalProperties: false,
      properties: {
        bloom: {
          type: 'object',
          additionalProperties: false,
          properties: {
            enabled: {
              type: 'boolean',
            },
            intensityPct: {
              type: 'number',
            },
          },
        },
        sharpen: {
          type: 'object',
          additionalProperties: false,
          properties: {
            enabled: {
              type: 'boolean',
            },
            intensityPct: {
              type: 'number',
            },
          },
        },
      },
    },
  },
  {
    name: 'open_stories',
    parameters: {
      type: 'object',
      additionalProperties: false,
      properties: {},
    },
  },
  {
    name: 'control_scene',
    parameters: {
      type: 'object',
      additionalProperties: false,
      properties: {
        action: {
          type: 'string',
          enum: ['list', 'play', 'stop', 'next', 'status'],
        },
        sceneId: {
          type: 'string',
        },
      },
      required: ['action'],
    },
  },
  {
    name: 'control_cctv',
    parameters: {
      type: 'object',
      additionalProperties: false,
      properties: {
        action: {
          type: 'string',
          enum: [
            'enable',
            'disable',
            'select',
            'next',
            'prev',
            'nearest',
            'focus',
            'coverage',
            'viewshed',
            'adjust',
            'projection',
            'autohop',
          ],
        },
        cameraQuery: {
          type: 'string',
        },
        enabled: {
          type: 'boolean',
        },
      },
      required: ['action'],
    },
  },
  {
    name: 'control_radio',
    parameters: {
      type: 'object',
      additionalProperties: false,
      properties: {
        action: {
          type: 'string',
          enum: [
            'enable',
            'disable',
            'play',
            'resume',
            'pause',
            'stop',
            'next',
            'previous',
            'volume',
            'select',
            'status',
          ],
        },
        volumePct: {
          type: 'number',
          minimum: 0,
          maximum: 100,
        },
        category: {
          type: 'string',
          enum: [
            'all',
            'news',
            'talk',
            'weather',
            'public-safety',
            'aviation-marine',
            'traffic-transit',
            'music',
          ],
        },
        locationId: {
          type: 'string',
          enum: [
            'austin',
            'sf',
            'nyc',
            'tokyo',
            'london',
            'paris',
            'dubai',
            'dc',
          ],
        },
        locationQuery: {
          type: 'string',
          maxLength: 120,
        },
        latitude: {
          type: 'number',
          minimum: -90,
          maximum: 90,
        },
        longitude: {
          type: 'number',
          minimum: -180,
          maximum: 180,
        },
        country: {
          type: 'string',
          maxLength: 80,
        },
        stationQuery: {
          type: 'string',
          maxLength: 120,
        },
      },
      required: ['action'],
    },
  },
  {
    name: 'track_entity',
    parameters: {
      type: 'object',
      additionalProperties: false,
      properties: {
        query: {
          type: 'string',
          minLength: 1,
          pattern: '\\S',
        },
        layerId: {
          type: 'string',
        },
        referent: {
          type: 'integer',
          enum: [-1, 1, 2, 3, 4, 5],
        },
      },
      anyOf: [
        { type: 'object', required: ['query'] },
        { type: 'object', required: ['referent'] },
      ],
    },
  },
  {
    name: 'stop_tracking',
    parameters: {
      type: 'object',
      additionalProperties: false,
      properties: {},
    },
  },
  {
    name: 'frame_overhead',
    parameters: {
      type: 'object',
      additionalProperties: false,
      properties: {
        target: {
          type: 'string',
          enum: ['flights', 'military', 'satellites', 'vessels'],
        },
        radiusKm: {
          type: 'number',
        },
      },
      required: ['target'],
    },
  },
  {
    name: 'annotate_map',
    parameters: {
      type: 'object',
      additionalProperties: false,
      properties: {
        annotations: {
          type: 'array',
          minItems: 1,
          maxItems: 24,
          items: {
            type: 'object',
            additionalProperties: false,
            properties: {
              type: {
                type: 'string',
                enum: ['pin', 'highlight', 'area', 'arrow', 'route', 'label'],
              },
              target: {
                type: 'string',
                maxLength: 200,
              },
              points: {
                type: 'array',
                minItems: 2,
                maxItems: 12,
                items: {
                  type: 'object',
                  additionalProperties: false,
                  properties: {
                    target: {
                      type: 'string',
                      maxLength: 200,
                    },
                    latitude: {
                      type: 'number',
                      minimum: -90,
                      maximum: 90,
                    },
                    longitude: {
                      type: 'number',
                      minimum: -180,
                      maximum: 180,
                    },
                    screenX: {
                      type: 'number',
                      minimum: 0,
                      maximum: 1,
                    },
                    screenY: {
                      type: 'number',
                      minimum: 0,
                      maximum: 1,
                    },
                  },
                },
              },
              mode: {
                type: 'string',
                enum: ['walking', 'driving', 'cycling'],
              },
              latitude: {
                type: 'number',
                minimum: -90,
                maximum: 90,
              },
              longitude: {
                type: 'number',
                minimum: -180,
                maximum: 180,
              },
              toTarget: {
                type: 'string',
                maxLength: 200,
              },
              toLatitude: {
                type: 'number',
                minimum: -90,
                maximum: 90,
              },
              toLongitude: {
                type: 'number',
                minimum: -180,
                maximum: 180,
              },
              label: {
                type: 'string',
                maxLength: 120,
              },
              color: {
                type: 'string',
                enum: ['primary', 'amber', 'cyan', 'green', 'red'],
              },
              footprint: {
                type: 'boolean',
              },
              intent: {
                type: 'string',
                enum: ['the_thing', 'around_the_thing'],
              },
              entityKind: {
                type: 'string',
                enum: [
                  'building',
                  'compound',
                  'district',
                  'street',
                  'point_feature',
                ],
              },
              screenX: {
                type: 'number',
                minimum: 0,
                maximum: 1,
              },
              screenY: {
                type: 'number',
                minimum: 0,
                maximum: 1,
              },
              toScreenX: {
                type: 'number',
                minimum: 0,
                maximum: 1,
              },
              toScreenY: {
                type: 'number',
                minimum: 0,
                maximum: 1,
              },
            },
            required: ['type'],
          },
        },
        flyTo: {
          type: 'boolean',
        },
        persist: {
          type: 'boolean',
        },
      },
      required: ['annotations'],
    },
  },
  {
    name: 'clear_annotations',
    parameters: {
      type: 'object',
      additionalProperties: false,
      properties: {},
    },
  },
  {
    name: 'move_camera',
    parameters: {
      type: 'object',
      additionalProperties: false,
      properties: {
        motion: {
          type: 'string',
          enum: ['orbit', 'pan', 'tilt', 'rotate', 'rotate_globe', 'stop'],
        },
        direction: {
          type: 'string',
          enum: ['left', 'right', 'up', 'down'],
        },
        speed: {
          type: 'string',
          enum: ['slow', 'normal', 'fast'],
        },
        mode: {
          type: 'string',
          enum: ['once', 'continuous'],
        },
        pitchDeg: { type: 'number' },
      },
      required: ['motion'],
    },
  },
  {
    name: 'fly_route',
    parameters: {
      type: 'object',
      additionalProperties: false,
      properties: {
        label: {
          type: 'string',
        },
        speed: {
          type: 'string',
          enum: ['slow', 'normal', 'fast'],
        },
      },
    },
  },
  {
    name: 'analyst_query',
    parameters: {
      type: 'object',
      additionalProperties: false,
      properties: {
        layers: {
          type: 'array',
          items: {
            type: 'string',
            enum: [...VOICE_QUERY_LAYER_IDS],
          },
        },
        scope: {
          type: 'object',
          additionalProperties: false,
          properties: {
            kind: {
              type: 'string',
              enum: [
                'view',
                'region',
                'radius',
                'anywhere',
                'pointer',
                'area',
                'drawn',
                'annotation',
              ],
            },
            name: {
              type: 'string',
            },
            areaId: {
              type: 'string',
              maxLength: 120,
            },
            id: {
              type: 'string',
              maxLength: 60,
            },
            km: {
              type: 'number',
            },
            center: {
              type: 'object',
              additionalProperties: false,
              properties: {
                lat: {
                  type: 'number',
                  minimum: -90,
                  maximum: 90,
                },
                lon: {
                  type: 'number',
                  minimum: -180,
                  maximum: 180,
                },
              },
              required: ['lat', 'lon'],
            },
          },
        },
        filters: {
          type: 'array',
          items: {
            type: 'object',
            additionalProperties: false,
            properties: {
              field: {
                type: 'string',
              },
              op: {
                type: 'string',
                enum: ['gt', 'gte', 'lt', 'lte', 'eq', 'neq', 'contains'],
              },
              value: {},
            },
            required: ['field', 'op', 'value'],
          },
        },
        sortBy: {
          type: 'string',
        },
        sortDir: {
          type: 'string',
          enum: ['asc', 'desc'],
        },
        limit: {
          type: 'number',
        },
        followUp: {
          type: 'boolean',
        },
      },
    },
  },
  {
    name: 'resolve_area',
    parameters: {
      type: 'object',
      additionalProperties: false,
      properties: {
        query: { type: 'string', minLength: 1, maxLength: 200 },
        level: {
          type: 'string',
          enum: [
            'country',
            'admin1',
            'admin2',
            'city',
            'district',
            'natural',
            'site',
          ],
        },
        within: { type: 'string', maxLength: 120 },
        candidateId: {
          type: 'string',
          minLength: 1,
          maxLength: MAX_AREA_CANDIDATE_ID_LENGTH,
          pattern: AREA_CANDIDATE_ID_PATTERN,
        },
        draw: { type: 'boolean' },
        around: { type: 'boolean' },
        radiusM: { type: 'number', minimum: 50, maximum: 20000 },
        flyTo: { type: 'boolean' },
      },
    },
  },
  {
    name: 'find_imagery',
    parameters: {
      type: 'object',
      additionalProperties: false,
      properties: {
        areaId: { type: 'string', maxLength: 120 },
        area: { type: 'string', enum: ['view', 'pointer'] },
        dateRange: {
          type: 'object',
          additionalProperties: false,
          properties: {
            from: { type: 'string', maxLength: 30 },
            to: { type: 'string', maxLength: 30 },
            days: { type: 'number', minimum: 1, maximum: 30 },
          },
        },
        maxCloudPct: { type: 'number', minimum: 0, maximum: 100 },
        source: { type: 'string', enum: ['hls', 'viirs', 'any'] },
      },
    },
  },
  {
    name: 'osm_query',
    parameters: {
      type: 'object',
      additionalProperties: false,
      required: ['what'],
      properties: {
        what: { type: 'string', minLength: 1, maxLength: 80 },
        areaId: { type: 'string', maxLength: 120 },
        countOnly: { type: 'boolean' },
        limit: { type: 'number', minimum: 1, maximum: 1000 },
      },
    },
  },
  {
    name: 'next_iss_pass',
    parameters: {
      type: 'object',
      additionalProperties: false,
      properties: {
        latitude: {
          type: 'number',
          minimum: -90,
          maximum: 90,
        },
        longitude: {
          type: 'number',
          minimum: -180,
          maximum: 180,
        },
        minElevationDeg: {
          type: 'number',
          minimum: 5,
          maximum: 60,
        },
      },
    },
  },
  {
    name: 'next_satellite_pass',
    parameters: {
      type: 'object',
      additionalProperties: false,
      required: ['target'],
      properties: {
        target: { type: 'string', minLength: 1, maxLength: 120 },
        latitude: { type: 'number', minimum: -90, maximum: 90 },
        longitude: { type: 'number', minimum: -180, maximum: 180 },
        minElevationDeg: { type: 'number', minimum: 5, maximum: 60 },
        visibleOnly: { type: 'boolean' },
      },
    },
  },
  {
    name: 'control_history',
    parameters: {
      type: 'object',
      additionalProperties: false,
      properties: {
        action: {
          type: 'string',
          enum: [
            'jump',
            'play',
            'pause',
            'speed',
            'live',
            'status',
            'feeds',
            'preset',
            'expand',
            'lock',
          ],
        },
        time: {
          type: 'string',
          maxLength: 40,
        },
        minutesAgo: {
          type: 'number',
          minimum: 0,
        },
        preset: {
          type: 'string',
          enum: ['1h', '24h', '7d', '30d', '90d', 'all'],
        },
        expanded: { type: 'boolean' },
        locked: { type: 'boolean' },
        historyRow: {
          type: 'string',
          enum: [
            'flights',
            'military',
            'vessels',
            'quakes',
            'firms',
            'fire-perimeters',
            'cyclones',
            'launches',
            'transit',
            'bikeshare',
            'wind',
            'aqhi',
            'gnss',
            'water',
            'satellites',
            'weather',
            'ghostmaps',
            'wayback',
            'naip',
          ],
        },
        rate: {
          type: 'integer',
          enum: [1, 10, 60, 600],
        },
        feeds: {
          type: 'array',
          minItems: 1,
          maxItems: 14,
          items: {
            type: 'string',
            enum: [
              'flights',
              'military',
              'ais-live-vessels',
              'local-firms',
              'fire-perimeters',
              'weather-cyclones',
              'rocket-launches',
              'transit',
              'bikeshare',
              'earthquakes',
              'wind',
              'air-quality',
              'gnss-integrity',
              'local-usgs-water',
            ],
          },
        },
        feedMode: {
          type: 'string',
          enum: ['only', 'add', 'remove'],
        },
      },
      required: ['action'],
    },
  },
  {
    name: 'control_sky',
    parameters: {
      type: 'object',
      additionalProperties: false,
      properties: {
        action: {
          type: 'string',
          enum: [
            'open',
            'close',
            'look',
            'time',
            'lines',
            'preset',
            'status',
            'play',
            'pause',
            'speed',
            'step',
            'reverse',
            'layers',
            'magnitude',
            'location',
            'clear',
          ],
        },
        rate: {
          type: 'number',
          enum: [-3600, -600, -60, -10, -1, 1, 10, 60, 600, 3600],
        },
        stepMs: { type: 'integer', enum: [-3600000, -60000, 60000, 3600000] },
        layer: {
          type: 'string',
          enum: [
            'stars',
            'lines',
            'names',
            'boundaries',
            'starNames',
            'planets',
            'telescopic',
            'grid',
          ],
        },
        magnitude: { type: 'number', minimum: 3, maximum: 7 },
        magnitudeTarget: { type: 'string', enum: ['stars', 'satellites'] },
        latitude: { type: 'number', minimum: -90, maximum: 90 },
        longitude: { type: 'number', minimum: -180, maximum: 180 },
        target: {
          type: 'string',
          minLength: 1,
          maxLength: 80,
        },
        time: {
          type: 'string',
          maxLength: 40,
        },
        live: {
          type: 'boolean',
        },
        enabled: {
          type: 'boolean',
        },
        preset: {
          type: 'string',
          enum: ['sunset', 'dusk', 'midnight', 'moonrise', 'iss'],
        },
      },
      required: ['action'],
    },
  },
  {
    name: 'control_imagery',
    parameters: {
      type: 'object',
      additionalProperties: false,
      properties: {
        action: {
          type: 'string',
          enum: [
            'year',
            'wayback',
            'off',
            'status',
            'compare',
            'yearB',
            'latest',
            'step',
            'play',
            'pause',
            'speed',
            'mode',
            'opacity',
            'swap',
          ],
        },
        yearB: { type: 'integer', minimum: 1800, maximum: 2999 },
        enabled: { type: 'boolean' },
        delta: { type: 'integer' },
        rate: { type: 'integer', enum: [1, 2, 4] },
        mode: { type: 'integer', enum: [0, 1, 2] },
        opacityPct: { type: 'integer', minimum: 0, maximum: 100 },
        year: {
          type: 'integer',
          minimum: 1800,
          maximum: 2999,
        },
        county: {
          type: 'string',
          minLength: 1,
          maxLength: 40,
        },
        date: {
          type: 'string',
          minLength: 4,
          maxLength: 10,
        },
        target: {
          type: 'string',
          enum: ['aerial', 'wayback', 'both'],
        },
      },
      required: ['action'],
    },
  },
  {
    name: 'control_droneplan',
    parameters: {
      type: 'object',
      additionalProperties: false,
      properties: {
        action: {
          type: 'string',
          enum: [
            'open',
            'close',
            'status',
            'draw',
            'box',
            'polygon',
            'recommend',
            'options',
            'takeoff',
            'remove',
            'replan',
            'suite',
            'download',
            'edit',
            'obstacle',
            'target',
            'path',
            'preview',
            'library',
            'loadPlan',
            'photoCheck',
            'check',
            'units',
            'finish',
            'undo',
            'corner',
          ],
        },
        kind: { type: 'string', enum: ['box', 'polygon'] },
        west: { type: 'number', minimum: -180, maximum: 180 },
        south: { type: 'number', minimum: -90, maximum: 90 },
        east: { type: 'number', minimum: -180, maximum: 180 },
        north: { type: 'number', minimum: -90, maximum: 90 },
        // Polygon and path share this array. A path needs two points; a
        // polygon needs three, and the adapter enforces that itself (the
        // panel's own drawing tool has no upper corner count either, so no
        // maxItems is stated here).
        ring: {
          type: 'array',
          minItems: 2,
          items: {
            type: 'object',
            additionalProperties: false,
            properties: {
              lon: { type: 'number', minimum: -180, maximum: 180 },
              lat: { type: 'number', minimum: -90, maximum: 90 },
            },
            required: ['lon', 'lat'],
          },
        },
        aircraft: { type: 'string', minLength: 1, maxLength: 40 },
        mode: {
          type: 'string',
          enum: [
            'mapping-grid',
            'mapping-grid-timed',
            'splat-orbit',
            'fast-survey',
          ],
        },
        pattern: { type: 'string', enum: ['grid', 'double', 'orbit'] },
        direction: { type: 'string', enum: ['auto', 'ew', 'ns'] },
        jobs: { type: 'string', enum: ['per-area', 'whole'] },
        photoMode: { type: 'string', enum: ['waypoint', 'interval'] },
        aglM: { type: 'number', minimum: 10, maximum: 457.2 },
        // The panel's Front overlap slider runs 50-98 (panel.js).
        frontOverlap: { type: 'number', minimum: 50, maximum: 98 },
        sideOverlap: { type: 'number', minimum: 40, maximum: 95 },
        tiltPitchDeg: { type: 'number', minimum: -80, maximum: -45 },
        orbitRadiusM: { type: 'number', minimum: 10, maximum: 300 },
        orbitHeightsM: {
          type: 'array',
          minItems: 1,
          maxItems: 6,
          items: { type: 'number', minimum: 10, maximum: 457.2 },
        },
        speedMs: { type: 'number', minimum: 0.1, maximum: 15 },
        // The adapter takes any number above 0 up to 3600 (dronePlanVoice.js).
        timedIntervalS: { type: 'number', minimum: 0.1, maximum: 3600 },
        shutterDenominator: {
          type: 'integer',
          enum: [250, 500, 1000, 2000, 4000],
        },
        batteryMin: { type: 'integer', minimum: 5, maximum: 60 },
        droneEnumValue: { type: 'integer', minimum: 0, maximum: 999 },
        clearDroneCode: { type: 'boolean' },
        takeoff: { type: 'string', enum: ['pick', 'clear', 'point'] },
        lat: { type: 'number', minimum: -90, maximum: 90 },
        lon: { type: 'number', minimum: -180, maximum: 180 },
        areaId: { type: 'string', minLength: 1, maxLength: 20 },
        which: { type: 'string', enum: ['mission', 'all', 'suite'] },
        // A zero-based list position. The list's own length decides the
        // largest valid index (areas, missions, obstacles, targets, paths,
        // and the photos of the 3D check), so no fixed ceiling is stated.
        index: { type: 'integer', minimum: 0 },
        // The 3D check switches the panel's own checkboxes drive (panel.js
        // setCheck, state.check). Omitted: the check is only read.
        checkEnabled: { type: 'boolean' },
        checkZone: { type: 'boolean' },
        checkCurtain: { type: 'boolean' },
        // The Photo footprints select (checkLayer.js FOOTPRINT_MODES).
        checkFootprints: { type: 'string', enum: ['selected', 'all', 'off'] },
        // The Camera view select (checkLayer.js FRUSTUM_MODES).
        checkFrustum: {
          type: 'string',
          enum: ['one', 'thinned', 'neighbors', 'off'],
        },
        // The Zone half-width slider: checkGeometry.js 2 to 30 m.
        zoneHalfWidthM: { type: 'number', minimum: 2, maximum: 30 },
        // The surface model select and its two sliders (panel.js setSurface;
        // prefs.js CLEARANCE_MAX_M is 61).
        surfaceEnabled: { type: 'boolean' },
        surfaceMinM: { type: 'number', minimum: 0, maximum: 61 },
        surfaceMarginM: { type: 'number', minimum: 0, maximum: 61 },
        // The shot trigger, as the panel's select offers it (panel.js).
        captureMode: { type: 'string', enum: ['stop', 'distance', 'timed'] },
        // Metres between photos on the Distance trigger. The panel keeps any
        // positive number (cleanPhotoSpacingM); zero clears the value, so it
        // is the only number refused here.
        photoSpacingM: { type: 'number', exclusiveMinimum: 0 },
        // Viewing angles for the orbit rings (orbitRings.js: 10-80, up to 6).
        orbitAnglesDeg: {
          type: 'array',
          minItems: 1,
          maxItems: 6,
          items: { type: 'number', minimum: 10, maximum: 80 },
        },
        orbitOutward: { type: 'boolean' },
        // The outward photo of a building stop: level to 45 degrees down.
        orbitOutwardPitchDeg: { type: 'number', minimum: -45, maximum: 0 },
        // Height of the aim point above the target, metres (panel.js).
        orbitTargetHeightM: { type: 'number', minimum: 0, maximum: 60 },
        obstacleHeightM: { type: 'number', minimum: 0, maximum: 60 },
        // The panel's waypoint field accepts 20-200 (planner.js).
        maxWaypoints: { type: 'integer', minimum: 20, maximum: 200 },
        usableBatteryMin: { type: 'integer', minimum: 5, maximum: 60 },
        continuousRoute: { type: 'boolean' },
        // One id from listCameraPresets() (cameraSettings.js).
        cameraPresetId: { type: 'string', minLength: 1, maxLength: 40 },
        // This plan's camera interval, overriding the aircraft's (0.1-60 s).
        minPhotoIntervalS: { type: 'number', minimum: 0.1, maximum: 60 },
        // The opt-in compact export: unverified on a controller.
        exportCompact: { type: 'boolean' },
        // The unit the panel shows and accepts lengths in (chooseUnits).
        units: { type: 'string', enum: ['ft', 'm'] },
        // A saved .gevplan document, for loadPlan (readPlan validates it).
        plan: { type: 'object' },
      },
      required: ['action'],
    },
  },
  {
    name: 'set_clean_view',
    parameters: {
      type: 'object',
      additionalProperties: false,
      properties: {
        enabled: {
          type: 'boolean',
        },
      },
      required: ['enabled'],
    },
  },
  {
    name: 'set_layer_opacity',
    parameters: {
      type: 'object',
      additionalProperties: false,
      properties: {
        layerId: {
          type: 'string',
          enum: toggleLayerIds(),
        },
        // The app stores opacity as a 0..1 fraction; the tool speaks percent.
        opacityPct: {
          type: 'integer',
          minimum: 0,
          maximum: 100,
        },
      },
      required: ['layerId', 'opacityPct'],
    },
  },
  {
    name: 'control_nav',
    parameters: {
      type: 'object',
      additionalProperties: false,
      properties: {
        action: {
          type: 'string',
          enum: [
            'tilt',
            'heading',
            'zoom',
            'top_down',
            'north',
            'look',
            'status',
          ],
        },
        tilt: { type: 'integer', minimum: 0, maximum: 79 },
        heading: { type: 'integer', minimum: 0, maximum: 359 },
        direction: {
          type: 'string',
          enum: ['in', 'out', 'up', 'down', 'left', 'right'],
        },
        steps: { type: 'integer', minimum: 1, maximum: 10 },
      },
      required: ['action'],
    },
  },
  {
    name: 'control_solunar',
    parameters: {
      type: 'object',
      additionalProperties: false,
      properties: {
        action: {
          type: 'string',
          enum: ['open', 'spot', 'center', 'clock', 'status'],
        },
        latitude: { type: 'number', minimum: -90, maximum: 90 },
        longitude: { type: 'number', minimum: -180, maximum: 180 },
        hour12: { type: 'boolean' },
      },
      required: ['action'],
    },
  },
  {
    name: 'control_overlays',
    parameters: {
      type: 'object',
      additionalProperties: false,
      properties: {
        action: {
          type: 'string',
          enum: ['enable', 'opacity', 'raise', 'lower', 'phone_mode', 'status'],
        },
        // Overlay ids come from the live overlay manifest, so this is a free
        // string rather than an enum: the model reads the id from the status
        // result and echoes it back. The bound is the manifest's own name
        // length, so an id or a name always fits.
        overlayId: {
          type: 'string',
          maxLength: 80,
        },
        enabled: {
          type: 'boolean',
        },
        opacityPct: {
          type: 'integer',
          minimum: 0,
          maximum: 100,
        },
      },
      required: ['action'],
    },
  },
  {
    name: 'control_ghostmaps',
    parameters: {
      type: 'object',
      additionalProperties: false,
      properties: {
        product: {
          type: 'string',
          enum: [
            'cip',
            'kinetic-30d',
            'border-crisis',
            'iran-cip',
            'iran-kinetic',
            'yemen-flot',
            'latest-drop',
          ],
        },
        enabled: { type: 'boolean' },
        ageDays: { type: 'string', enum: ['1', '3', '7', '14', '30', 'all'] },
      },
      required: [],
    },
  },
];

function freeze(value) {
  if (value && typeof value === 'object') {
    Object.values(value).forEach(freeze);
    Object.freeze(value);
  }
  return value;
}

/** Immutable action names and argument schemas, without model-facing wording. */
export const GEV_ACTION_SCHEMAS = freeze(schemas);

/** Build independent function-tool records with description-only metadata. */
export function createActionTools(descriptions = {}) {
  for (const name of Object.keys(descriptions)) {
    if (!schemas.some((schema) => schema.name === name))
      throw new TypeError('Unknown action description: ' + name);
  }
  return schemas.map((schema) => {
    const tool = {
      type: 'function',
      ...describe(schema, descriptions[schema.name] || {}),
    };
    // Function-calling APIs reject anyOf/oneOf/allOf at the top level of
    // parameters; the runner and benchmark validate those rules themselves.
    for (const key of TOP_LEVEL_COMBINATORS) delete tool.parameters?.[key];
    return tool;
  });
}

const TOP_LEVEL_COMBINATORS = ['anyOf', 'oneOf', 'allOf'];

function describe(schema, metadata, allowDescription = true) {
  if (!metadata || typeof metadata !== 'object' || Array.isArray(metadata))
    throw new TypeError('Descriptions must be an object');
  const result = structuredClone(schema);
  for (const [key, value] of Object.entries(metadata)) {
    if (key === '$position' && allowDescription) continue;
    if (key === 'description' && allowDescription) {
      if (typeof value !== 'string')
        throw new TypeError('Description must be text');
      Object.defineProperty(result, key, {
        value,
        enumerable: true,
        writable: true,
        configurable: true,
      });
    } else {
      if (
        !Object.hasOwn(schema, key) ||
        !schema[key] ||
        typeof schema[key] !== 'object'
      )
        throw new TypeError(
          'Descriptions cannot change action arguments: ' + key,
        );
      Object.defineProperty(result, key, {
        value: describe(
          schema[key],
          value,
          !Array.isArray(schema[key]) &&
            (!allowDescription || key !== 'properties'),
        ),
        enumerable: true,
        writable: true,
        configurable: true,
      });
    }
  }
  if (
    Object.hasOwn(metadata, '$position') &&
    (!Object.hasOwn(metadata, 'description') ||
      !Number.isInteger(metadata.$position) ||
      metadata.$position < 0 ||
      metadata.$position > Object.keys(schema).length)
  )
    throw new TypeError('Invalid description position');
  if (allowDescription && Object.hasOwn(metadata, 'description')) {
    const entries = Object.entries(result).filter(
      ([key]) => key !== 'description',
    );
    entries.splice(metadata.$position ?? entries.length, 0, [
      'description',
      metadata.description,
    ]);
    return Object.fromEntries(entries);
  }
  return result;
}
