import { realtimeInstructions } from '../../server/providers/openai/instructions.js';
import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { GEV_ACTION_SCHEMAS, createActionTools } from './actionSchemas.js';
import { TILT_SPAN_DEG } from '../byrdit/navControl/navMath.js';
import { VOICE_TOGGLE_LAYER_IDS } from './layerManifest.js';
import { GEV_REALTIME_TOOLS } from '../../server/providers/openai/tools.js';
import { createAreaStore } from '../data/areaStore.js';
import { createAreaResolver } from '../data/areaResolver.js';
import { findAdminCandidates } from '../data/adminBoundaries.js';
import {
  validateArgs,
  validateCall,
} from '../../scripts/voice-bench/grade.mjs';

const stable = (value) =>
  Array.isArray(value)
    ? value.map(stable)
    : value && typeof value === 'object'
      ? Object.fromEntries(
          Object.entries(value)
            .sort(([a], [b]) => a.localeCompare(b))
            .map(([key, child]) => [key, stable(child)]),
        )
      : value;

// The tools this release adds, and the panel targets it adds to
// set_panel_open. Both are deliberate additions: the digest below keeps
// covering every tool before them, and the additions are pinned by their own
// assertions.
const NEW_TOOLS = ['set_clean_view', 'set_layer_opacity'];
// The navigation and solunar voice tools this release appends after them,
// and the map overlay tool after those. These are omitted where the existing
// inventory is checked separately; prompt-budget description changes also
// require the legacy digest to change.
const APPENDED_TOOLS = [
  'control_nav',
  'control_solunar',
  'control_overlays',
  'control_ghostmaps',
];
const NEW_PANEL_TARGETS = [
  'time-travel-panel',
  'map-layers-panel',
  'solunar-panel',
  'drone-plan-panel',
];
// The live S4 merge adds the Space Missions panel target. It is upstream's
// deliberate set_panel_open addition, so it is removed from the legacy payload
// too, but it does not sit at the tail like the fork's four right-rail panels.
const UPSTREAM_PANEL_TARGETS = ['space-missions-panel'];
// The view-state description before it started naming layer opacity.
const LEGACY_VIEW_STATE_DESCRIPTION =
  'Read the current camera, style, Context, Cockpit, HUD, detection, map stack, post-processing, scene-playback, tracked-entity, and layer state before choosing another action. Tracked aircraft emergency status is a crowd-sourced transponder broadcast, not a confirmed incident: quote emergencyBroadcast and never infer a hijack or an incident ending from a code change.';

test('the complete Realtime tool payload pins the manifest-generated layer release', () => {
  // Remove separately pinned additions before checking the remaining payload.
  // Description shortening changes its digest, which is deliberately re-pinned.
  const tools = structuredClone(
    GEV_REALTIME_TOOLS.filter(
      (tool) =>
        tool.name !== 'set_cyber_sonar' &&
        !NEW_TOOLS.includes(tool.name) &&
        !APPENDED_TOOLS.includes(tool.name),
    ),
  );
  const panel = tools.find((tool) => tool.name === 'set_panel_open');
  panel.parameters.properties.panelId.enum =
    panel.parameters.properties.panelId.enum.filter(
      (id) =>
        !NEW_PANEL_TARGETS.includes(id) && !UPSTREAM_PANEL_TARGETS.includes(id),
    );
  const viewState = tools.find(
    (tool) => tool.name === 'get_current_view_state',
  );
  viewState.description = LEGACY_VIEW_STATE_DESCRIPTION;
  const digest = createHash('sha256')
    .update(JSON.stringify(stable(tools)))
    .digest('hex');
  assert.equal(
    digest,
    // Re-derived for Provider Settings and explicit Visual Presets/Scenes routing,
    // plus the deliberate direct Panel tool/target additions and voice layer manifest (generated layer enums and
    // aliases), point-and-ask (pointer sentinels, referent args) and the
    // consolidated tool wording (each policy stated once); model-facing tools
    // omit top-level anyOf (OpenAI rejects it). Contacts list routing preserves
    // requested radius and center authority in descriptions only.
    // Street Level and GNSS extend the manifest; tracked and analyst aircraft describe broadcasts.
    // Air quality (ECCC AQHI) extends the manifest.
    // Byrd-IT fork: + the four USGS water layers in src/voice/layerManifest.js
    // (upstream 1c234ce0 pin without them: 967b5a04...99cf6). Re-pinned at the
    // 0e27d69f merge: the only drift from upstream is fork-only (control_sky,
    // control_history, control_imagery, control_droneplan, byrdit-open and
    // basemap-auto in set_map_stack, the four USGS water layers).
    // Globe rotation adds one motion; visual keyhole fit and explicit
    // reset guidance/defaults update only move_camera and mode descriptions.
    // S2 GhostMaps extends the generated layer enums.
    // The Utilities panel (Directions, Draw, Import) adds one panel target.
    // Panel adds named voice targets and timeout; shared Panel/Cockpit guidance
    // is consolidated without changing either feature's arguments.
    // History playback voice adds the control_history tool (last).
    // Sky view voice adds the control_sky tool (last).
    // Imagery-by-year voice adds the control_imagery tool (last).
    // Drone Flight Plan voice adds the control_droneplan tool (last).
    // Drone Flight Plan height limits (aglM, orbitHeightsM) rise from 120 m to
    // the 1500 ft planning maximum, 457.2 m (see dronePlan/heightLimits.js).
    // drawn/compare/waybackOff speaking rule, description only.
    // waybackStillOn and starting speaking rule, description only.
    // Snow leaves the set_visual_style enum.
    // The Operator HUD layout leaves set_hud's layout enum.
    // The layer alias hint leaves out aliases the layer id already spells.
    // Voice geometry adds resolve_area, find_imagery, osm_query, the analyst
    // area scopes and the osm-places layer; natural-region candidates and the
    // tightened area tool wording follow review.
    // control_cockpit states the own-layer entry rule (Contacts not required).
    // move_camera tilt takes an optional pitchDeg angle, described as
    // absolute with its -45 default, with steps sent as a direction.
    // Byrd-IT fork: re-pinned at the 6e4da23c upstream merge. Upstream's pin
    // 6a0d154e...c3c reproduces from origin/main; the only drift is fork-only
    // (control_history/sky/imagery/droneplan, byrdit-open and basemap-auto in
    // set_map_stack, the four USGS water layers in the layer enums and the
    // water alias hint, and control_droneplan aglM/orbitHeightsM maximum 457.2).
    // Drone Flight Plan voice: options accepts timedIntervalS (seconds, the
    // Timed-shot interval, any number above 0 up to 3600, no floor in the
    // schema beyond the handler's rule); status reports speedMph, captureMode
    // and the same.
    // aa95c2c2: show_street_level (query, latitude, longitude, provider, referent;
    // no pattern or other Unicode-property construct) adds exactly one tool; the
    // pin before it, 194f9966..., is reproduced when that tool is left out.
    // Upstream merge fa6d9547 (2026-11-17): upstream's open_stories joins the
    // fork's 39 tools (40); upstream's own pin moved 0c27f620... -> 5a2deb65...
    // over its renderer-seam work. The fork pin before the merge was bec0ddca....
    // This release adds set_clean_view and set_layer_opacity (last) and four
    // set_panel_open targets, and the view-state description now names layer
    // opacity. The digest removes those additions and navigation/solunar tools,
    // but changes for the shortened drone description; re-pinned accordingly.
    // Imagery/Sky/History extensions and prompt compaction re-pin this payload.
    // The live S4 merge adds the Space Missions panel target (upstream's
    // deliberate set_panel_open addition), also removed before hashing.
    // The Drone Flight Plan voice surface grows to the panel's own controls:
    // twelve more control_droneplan actions (edit/obstacle/target/path/preview/
    // library/loadPlan/photoCheck/check/units/finish/undo/corner), the 3D check,
    // surface, orbit, waypoint and camera-interval options, photoSpacingM,
    // captureMode, frontOverlap maximum 98 and timedIntervalS minimum 0.1.
    // Re-pinned for the control_droneplan prompt compaction: the same actions
    // and arguments, with each description cut to its concise meaning so the
    // Realtime prompt grows as little as the tool allows.
    // Re-pinned for the drone plan bound repair: ring minItems 2 with no
    // maxItems (a path is two points, a polygon any count from three up, and
    // the panel's drawing tool has no corner ceiling), index with no maximum
    // (the list's own length bounds it), and the ring description reworded.
    // Re-pinned for the photoSpacingM schema repair: exclusiveMinimum: 0 (which
    // this subset cannot check) becomes minimum: 0 (-9 characters).
    'c4586a6433472d9b63d9da986bd6a5f2f0a6fa2216a282326246e1b2b1e68f58',
  );
});

test('descriptions customize wording without changing immutable shared arguments', () => {
  const descriptions = {
    fly_to_location: {
      description: 'Navigate',
      parameters: { properties: { query: { description: 'A place' } } },
    },
  };
  const tools = createActionTools(descriptions);
  const tool = tools.find((tool) => tool.name === 'fly_to_location');
  assert.equal(tool.description, 'Navigate');
  assert.equal(tool.parameters.properties.query.description, 'A place');
  assert.equal(tool.parameters.properties.query.type, 'string');
  tool.parameters.properties.query.type = 'number';
  assert.equal(
    createActionTools()[0].parameters.properties.query.type,
    'string',
  );
  assert.throws(() => {
    GEV_ACTION_SCHEMAS[0].parameters.properties.query.type = 'number';
  }, TypeError);
  assert.equal(
    JSON.stringify(GEV_ACTION_SCHEMAS).includes('"description"'),
    false,
  );
});

test('every emitted area candidate round-trips through the production schema', async () => {
  const candidateSchema = GEV_ACTION_SCHEMAS.find(
    (tool) => tool.name === 'resolve_area',
  ).parameters.properties.candidateId;
  const resolver = createAreaResolver({
    store: createAreaStore(),
    findAdminCandidates,
  });
  const ambiguous = await resolver.resolve({ query: 'Georgia' });
  assert.equal(ambiguous.needsClarification, true);
  for (const choice of ambiguous.candidates) {
    assert.ok(choice.candidateId.length >= candidateSchema.minLength);
    assert.ok(choice.candidateId.length <= candidateSchema.maxLength);
    assert.match(choice.candidateId, new RegExp(candidateSchema.pattern, 'u'));
    assert.equal(
      (await resolver.resolve({ candidateId: choice.candidateId })).ok,
      true,
    );
  }
  assert.equal(ambiguous.candidates[0].candidateId.length, 44);
  const grammar = new RegExp(candidateSchema.pattern, 'u');
  for (const malformed of [
    'ne:state:bad slug',
    'ne:state:../../etc',
    'ne:state:!!!',
    'ne:state:a_b',
  ])
    assert.doesNotMatch(malformed, grammar);
  assert.ok(`ne:state:${'x'.repeat(80)}`.length > candidateSchema.maxLength);
});

test('metadata cannot add tools, fields, types or enum values', () => {
  for (const descriptions of [
    { execute_shell: { description: 'not an action' } },
    {
      fly_to_location: {
        parameters: { properties: { description: 'new field' } },
      },
    },
    { fly_to_location: { $position: -1, description: 'invalid position' } },
    { fly_to_location: { name: 'other' } },
    {
      fly_to_location: {
        parameters: { properties: { arbitrary: { description: 'new field' } } },
      },
    },
    {
      fly_to_location: {
        parameters: { properties: { query: { type: 'number' } } },
      },
    },
    { fly_to_location: { parameters: { required: { 0: 'another' } } } },
    { fly_to_location: { description: { nested: 'invalid' } } },
  ])
    assert.throws(() => createActionTools(descriptions), TypeError);
});

test('all legacy action arguments are byte-identical after removing the deliberate additions', () => {
  const legacy = structuredClone(GEV_ACTION_SCHEMAS).filter(
    (tool) =>
      ![
        'next_satellite_pass',
        'set_cyber_sonar',
        'set_voice_inactivity_timeout',
        'control_history',
        'control_sky',
        'control_imagery',
        'control_droneplan',
        'set_clean_view',
        'set_layer_opacity',
        'resolve_area',
        'find_imagery',
        'osm_query',
        'show_street_level',
        'open_stories',
        'control_nav',
        'control_solunar',
        'control_overlays',
        'control_ghostmaps',
      ].includes(tool.name),
  );
  // Layer enums are generated from the voice layer manifest and pinned by
  // layerManifest.test.mjs; the two shipped right-rail panels are additive.
  const property = (name) =>
    legacy.find((tool) => tool.name === name).parameters.properties;
  delete property('control_cockpit').voicePanel;
  delete property('set_layer_visibility').layerId.enum;
  delete property('show_data_layers_menu').layerId.enum;
  delete property('get_entity_context').layerId.enum;
  delete property('analyst_query').layers.items.enum;
  // Earth-centered rotation is additive; local camera yaw keeps its contract.
  const motion = property('move_camera').motion;
  assert.deepEqual(motion.enum, [
    'orbit',
    'pan',
    'tilt',
    'rotate',
    'rotate_globe',
    'stop',
  ]);
  motion.enum = motion.enum.filter((value) => value !== 'rotate_globe');
  // Byrd-IT Open and Auto are additive set_map_stack values.
  const stackEnum = property('set_map_stack').stack.enum;
  assert.deepEqual(stackEnum.slice(-2), ['byrdit-open', 'basemap-auto']);
  property('set_map_stack').stack.enum = stackEnum.slice(0, -2);
  // Tilt to an angle is additive.
  delete property('move_camera').pitchDeg;
  const panels = property('set_panel_open').panelId;
  panels.enum = panels.enum.filter(
    (id) =>
      ![
        'weather-panel',
        'recent-imagery-panel',
        'voice-settings',
        'voice-preview',
        'provider-settings',
        'utilities-panel',
        'time-travel-panel',
        'map-layers-panel',
        'solunar-panel',
        'drone-plan-panel',
        'space-missions-panel',
      ].includes(id),
  );
  for (const tool of legacy) {
    // Point-and-ask adds `referent` arguments and 'pointer' enum values.
    delete tool.parameters.properties.referent;
    for (const value of Object.values(tool.parameters.properties)) {
      if (value.enum)
        value.enum = value.enum.filter((key) => key !== 'pointer');
    }
  }
  const track = legacy.find((tool) => tool.name === 'track_entity').parameters;
  delete track.anyOf;
  delete track.properties.query.minLength;
  delete track.properties.query.pattern;
  track.required = ['query'];
  const analystScopeKind = legacy.find((tool) => tool.name === 'analyst_query')
    .parameters.properties.scope.properties.kind;
  analystScopeKind.enum = analystScopeKind.enum.filter(
    (key) => key !== 'pointer',
  );
  // Area handles add three scope kinds and their two identifiers.
  const scope = property('analyst_query').scope;
  scope.properties.kind.enum = scope.properties.kind.enum.filter(
    (kind) => !['area', 'drawn', 'annotation'].includes(kind),
  );
  delete scope.properties.areaId;
  delete scope.properties.id;
  // The analyst centre now requires a real coordinate.
  const center = property('analyst_query').scope.properties.center;
  delete center.required;
  for (const axis of ['lat', 'lon']) {
    delete center.properties[axis].minimum;
    delete center.properties[axis].maximum;
  }
  // Operator and then Cyber were retired.
  const hud = property('set_hud').layout;
  assert.deepEqual(hud.enum, ['tactical', 'minimal']);
  hud.enum = ['tactical', 'operator', 'minimal'];
  // Snow is retired from set_visual_style; restore it to keep the legacy pin.
  const visualStyle = legacy.find((tool) => tool.name === 'set_visual_style')
    .parameters.properties.style;
  assert.deepEqual(visualStyle.enum, [
    'normal',
    'retro',
    'surveillance',
    'thermal',
    'anime',
    'noir',
  ]);
  visualStyle.enum = [...visualStyle.enum, 'snow'];
  // Derived by applying the same removals to the 4b56d0e9 actionSchemas.
  assert.equal(
    createHash('sha256').update(JSON.stringify(legacy)).digest('hex'),
    '01f14fdb1523eebfcbff8b115e48e6ab99e36fa06f55a3bb13c65e198f79d758',
  );
});

test('globe rotation is an additive camera motion with the existing control arguments', () => {
  const schema = GEV_ACTION_SCHEMAS.find(
    (tool) => tool.name === 'move_camera',
  ).parameters;
  for (const motion of ['rotate_globe', 'rotate', 'orbit', 'pan', 'tilt']) {
    assert.deepEqual(
      validateArgs(schema, {
        motion,
        direction: 'right',
        speed: 'slow',
        mode: 'continuous',
      }),
      [],
    );
  }
  assert.ok(validateArgs(schema, { motion: 'spin_camera' }).length > 0);
});

test('track_entity accepts a referent alone but rejects an empty target', () => {
  const schema = GEV_ACTION_SCHEMAS.find(
    (tool) => tool.name === 'track_entity',
  ).parameters;
  assert.deepEqual(validateArgs(schema, { referent: 2 }), []);
  assert.deepEqual(validateArgs(schema, { referent: -1 }), []);
  assert.deepEqual(validateArgs(schema, { query: 'UPS793' }), []);
  assert.ok(validateArgs(schema, {}).length > 0);
  assert.ok(validateArgs(schema, { query: '' }).length > 0);
  assert.ok(validateArgs(schema, { query: '   ' }).length > 0);
  assert.ok(validateArgs(schema, { referent: 0 }).length > 0);
  assert.ok(validateArgs(schema, { referent: 6 }).length > 0);
});

test('tools sent to the model never carry a top-level schema combinator', () => {
  for (const tool of createActionTools()) {
    assert.equal(tool.parameters.type, 'object', tool.name);
    for (const key of ['anyOf', 'oneOf', 'allOf', 'enum', 'not'])
      assert.equal(tool.parameters[key], undefined, `${tool.name}.${key}`);
  }
  // The runner still knows track_entity needs a query or a referent.
  const track = GEV_ACTION_SCHEMAS.find((s) => s.name === 'track_entity');
  assert.ok(track.parameters.anyOf);
});

test('the benchmark still rejects an empty track_entity although the model-facing tool omits anyOf', () => {
  assert.ok(
    validateCall(GEV_REALTIME_TOOLS, { name: 'track_entity', args: {} })
      .length > 0,
  );
  assert.deepEqual(
    validateCall(GEV_REALTIME_TOOLS, {
      name: 'track_entity',
      args: { referent: 2 },
    }),
    [],
  );
});

test('globe reset guidance requires a separate explicit command after refusal', () => {
  const paragraph = realtimeInstructions()
    .split('\n')
    .find((line) => line.includes('globe-view-required'));
  assert.ok(paragraph);
  assert.match(paragraph, /calls only move_camera motion rotate_globe/);
  assert.match(paragraph, /explicit user Reset\/Show Globe View/);
  assert.match(paragraph, /never from your own plan/);
  assert.match(paragraph, /bare yes\/ok/);
  assert.match(paragraph, /Do not ask a question/);
});

test('direct voice timeout schema accepts None and exact integers, rejects malformed duration', () => {
  const tool = GEV_REALTIME_TOOLS.find(
    (tool) => tool.name === 'set_voice_inactivity_timeout',
  );
  for (const minutes of [0, 1, 5, 60])
    assert.equal(validateArgs(tool.parameters, { minutes }).length, 0);
  for (const minutes of [-1, 61, 1.5, '5'])
    assert.ok(validateArgs(tool.parameters, { minutes }).length > 0);
});

test('the control_droneplan height limits are the planner planning maximum (1500 ft)', async () => {
  const { AGL_CAP_M, MIN_AGL_M } =
    await import('../byrdit/dronePlan/planner.js');
  const schema = GEV_ACTION_SCHEMAS.find((s) => s.name === 'control_droneplan');
  const props = schema.parameters.properties;
  assert.equal(props.aglM.maximum, AGL_CAP_M);
  assert.equal(props.aglM.minimum, MIN_AGL_M);
  assert.equal(props.orbitHeightsM.items.maximum, AGL_CAP_M);
  assert.equal(props.orbitHeightsM.items.minimum, MIN_AGL_M);
  assert.equal(AGL_CAP_M, 457.2);
});

test('tilt accepts an angle with no direction', () => {
  const schema = GEV_ACTION_SCHEMAS.find(
    (tool) => tool.name === 'move_camera',
  ).parameters;
  assert.deepEqual(validateArgs(schema, { motion: 'tilt', pitchDeg: -45 }), []);
  assert.deepEqual(validateArgs(schema, { motion: 'tilt' }), []);
  // No range in the schema (prompt budget): the runner clamps to -89..-5.
  assert.ok(
    validateArgs(schema, { motion: 'tilt', pitchDeg: 'steep' }).length > 0,
  );
});

test('control_droneplan timedIntervalS has the same rule as the panel field and the voice handler', () => {
  const schema = GEV_ACTION_SCHEMAS.find((s) => s.name === 'control_droneplan');
  const prop = schema.parameters.properties.timedIntervalS;
  assert.equal(prop.type, 'number');
  assert.equal(prop.maximum, 3600);
  // The schema states the DJI Fly floor of 0.1 s. The panel field and the
  // adapter still take any positive number, so a lower value is refused here
  // before it can reach them.
  assert.equal(prop.minimum, 0.1);
  assert.deepEqual(
    validateArgs(schema.parameters, { action: 'options', timedIntervalS: 0.1 }),
    [],
  );
  assert.ok(
    validateArgs(schema.parameters, {
      action: 'options',
      timedIntervalS: 0.05,
    }).length > 0,
  );
});

test('the complete current Realtime tool inventory is pinned', () => {
  // The map overlay tool this release appends is pinned by its own
  // assertions; the digest keeps covering every tool before it.
  const tools = GEV_REALTIME_TOOLS;
  assert.equal(
    createHash('sha256')
      .update(JSON.stringify(stable(tools)))
      .digest('hex'),
    // Re-pinned for navigation and solunar voice and the deliberately
    // shortened descriptions needed to keep the prompt within budget.
    // Re-pinned again for Imagery/Sky/History and prompt compaction.
    // Re-pinned for the Drone Flight Plan voice surface (twelve more actions,
    // the 3D check/surface/orbit/waypoint options, frontOverlap 98,
    // timedIntervalS minimum 0.1).
    // Re-pinned for the control_droneplan prompt compaction (descriptions only,
    // no tool, argument or enum change).
    // Re-pinned for the drone plan bound repair (ring minItems 2, no maxItems;
    // index maximum removed; ring description reworded).
    // Re-pinned for the photoSpacingM schema repair (exclusiveMinimum: 0 ->
    // minimum: 0, -9 characters; no tool, argument or enum change).
    // Re-pinned for the merged navigation voice: control_nav tilt's maximum is
    // the live tilt slider's span (TILT_SPAN_DEG, 179 = straight up) instead of
    // the pre-merge 79, so voice can ask for the raised gaze the slider reaches.
    'b70fcc800b884f2cfa3dd1f8b2a17183c19b942315fb92323ad50a353ad06b4d',
  );
});

test('the clean view and layer opacity tools are appended after control_droneplan', () => {
  const names = GEV_REALTIME_TOOLS.map((tool) => tool.name);
  // The navigation, solunar and map overlay voice tools this release appends
  // land after the clean-view and opacity pair, so the pair is no longer the
  // tail.
  assert.equal(names.at(-1), 'control_ghostmaps');
  assert.equal(names.at(-2), 'control_overlays');
  assert.equal(names.at(-3), 'control_solunar');
  assert.equal(names.at(-4), 'control_nav');
  assert.equal(names.at(-5), 'set_layer_opacity');
  assert.equal(names.at(-6), 'set_clean_view');
  assert.equal(names.at(-7), 'control_droneplan');

  const clean = GEV_REALTIME_TOOLS.find(
    (tool) => tool.name === 'set_clean_view',
  );
  assert.equal(clean.parameters.properties.enabled.type, 'boolean');
  assert.deepEqual(clean.parameters.required, ['enabled']);
  assert.equal(clean.parameters.additionalProperties, false);

  const opacity = GEV_REALTIME_TOOLS.find(
    (tool) => tool.name === 'set_layer_opacity',
  );
  assert.deepEqual(opacity.parameters.properties.layerId.enum, [
    ...VOICE_TOGGLE_LAYER_IDS,
  ]);
  assert.equal(opacity.parameters.properties.opacityPct.type, 'integer');
  assert.equal(opacity.parameters.properties.opacityPct.minimum, 0);
  assert.equal(opacity.parameters.properties.opacityPct.maximum, 100);
  assert.deepEqual(opacity.parameters.required, ['layerId', 'opacityPct']);
  assert.equal(opacity.parameters.additionalProperties, false);

  const panels = GEV_REALTIME_TOOLS.find(
    (tool) => tool.name === 'set_panel_open',
  ).parameters.properties.panelId.enum;
  assert.deepEqual(panels.slice(-4), NEW_PANEL_TARGETS);
});

test('the appended navigation and solunar voice tools are pinned', () => {
  const nav = GEV_REALTIME_TOOLS.find((tool) => tool.name === 'control_nav');
  assert.deepEqual(nav.parameters.properties.action.enum, [
    'tilt',
    'heading',
    'zoom',
    'top_down',
    'north',
    'look',
    'status',
  ]);
  assert.equal(nav.parameters.properties.tilt.type, 'integer');
  assert.equal(nav.parameters.properties.tilt.minimum, 0);
  assert.equal(nav.parameters.properties.tilt.maximum, TILT_SPAN_DEG);
  assert.equal(nav.parameters.properties.heading.type, 'integer');
  assert.equal(nav.parameters.properties.heading.minimum, 0);
  assert.equal(nav.parameters.properties.heading.maximum, 359);
  assert.deepEqual(nav.parameters.properties.direction.enum, [
    'in',
    'out',
    'up',
    'down',
    'left',
    'right',
  ]);
  assert.equal(nav.parameters.properties.steps.type, 'integer');
  assert.equal(nav.parameters.properties.steps.minimum, 1);
  assert.equal(nav.parameters.properties.steps.maximum, 10);
  assert.deepEqual(nav.parameters.required, ['action']);
  assert.equal(nav.parameters.additionalProperties, false);
  assert.ok(nav.description);

  const solunar = GEV_REALTIME_TOOLS.find(
    (tool) => tool.name === 'control_solunar',
  );
  assert.deepEqual(solunar.parameters.properties.action.enum, [
    'open',
    'spot',
    'center',
    'clock',
    'status',
  ]);
  assert.equal(solunar.parameters.properties.latitude.type, 'number');
  assert.equal(solunar.parameters.properties.latitude.minimum, -90);
  assert.equal(solunar.parameters.properties.latitude.maximum, 90);
  assert.equal(solunar.parameters.properties.longitude.type, 'number');
  assert.equal(solunar.parameters.properties.longitude.minimum, -180);
  assert.equal(solunar.parameters.properties.longitude.maximum, 180);
  assert.equal(solunar.parameters.properties.hour12.type, 'boolean');
  assert.deepEqual(solunar.parameters.required, ['action']);
  assert.equal(solunar.parameters.additionalProperties, false);
  assert.ok(solunar.description);
});

test('the appended map overlay voice tool is pinned', () => {
  const overlays = GEV_REALTIME_TOOLS.find(
    (tool) => tool.name === 'control_overlays',
  );
  assert.deepEqual(overlays.parameters.properties.action.enum, [
    'enable',
    'opacity',
    'raise',
    'lower',
    'phone_mode',
    'status',
  ]);
  // The overlay ids come from the live overlay manifest, so the argument is
  // a bounded string rather than an enum: the model reads the id from the
  // status result and echoes it back.
  assert.equal(overlays.parameters.properties.overlayId.type, 'string');
  assert.equal(overlays.parameters.properties.overlayId.maxLength, 80);
  assert.equal(overlays.parameters.properties.overlayId.enum, undefined);
  assert.equal(overlays.parameters.properties.enabled.type, 'boolean');
  assert.equal(overlays.parameters.properties.opacityPct.type, 'integer');
  assert.equal(overlays.parameters.properties.opacityPct.minimum, 0);
  assert.equal(overlays.parameters.properties.opacityPct.maximum, 100);
  assert.deepEqual(overlays.parameters.required, ['action']);
  assert.equal(overlays.parameters.additionalProperties, false);
  assert.ok(overlays.description);
});

test("the opacity tool takes only whole percents inside the app's range", () => {
  const schema = GEV_ACTION_SCHEMAS.find(
    (tool) => tool.name === 'set_layer_opacity',
  ).parameters;
  for (const pct of [0, 1, 40, 100])
    assert.deepEqual(
      validateArgs(schema, { layerId: 'flights', opacityPct: pct }),
      [],
    );
  for (const pct of [-1, 101, 12.5, '40'])
    assert.ok(
      validateArgs(schema, { layerId: 'flights', opacityPct: pct }).length > 0,
      `opacityPct ${pct}`,
    );
  assert.ok(validateArgs(schema, { layerId: 'flights' }).length > 0);
});

test('photoSpacingM states its floor without a keyword the schema subset cannot enforce', () => {
  const schema = GEV_ACTION_SCHEMAS.find((s) => s.name === 'control_droneplan');
  const prop = schema.parameters.properties.photoSpacingM;
  assert.equal(prop.type, 'number');
  // src/tools/schema.js and the voice bench know `minimum`, not
  // `exclusiveMinimum`; the exact >0 rule lives in the adapter, which refuses
  // zero. Nothing here adds a floor above the panel's own.
  assert.equal(prop.exclusiveMinimum, undefined);
  assert.equal(prop.minimum, 0);
  assert.equal(prop.maximum, undefined);
  // 0 passes the schema and is still refused by the handler's exact rule.
  assert.deepEqual(
    validateArgs(schema.parameters, { action: 'options', photoSpacingM: 0 }),
    [],
  );
  assert.ok(
    validateArgs(schema.parameters, { action: 'options', photoSpacingM: -1 })
      .length > 0,
  );
});

test('control_droneplan option bounds are the panel sliders', () => {
  const panel = readFileSync(
    new URL('../byrdit/dronePlan/panel.js', import.meta.url),
    'utf8',
  );
  // The panel sliders the voice tool mirrors. A schema bound tighter than the
  // UI silently refuses a value the person can set by hand.
  assert.match(panel, /slider\(t\('Front overlap'\), 50, 98, 0\.5\)/);
  assert.match(panel, /slider\(t\('Side overlap'\), 40, 95, 1\)/);
  assert.match(panel, /slider\(t\('Camera tilt'\), -80, -45, 5\)/);
  assert.match(panel, /minM: 10,\s*maxM: 300,/);
  const props = GEV_ACTION_SCHEMAS.find((s) => s.name === 'control_droneplan')
    .parameters.properties;
  assert.deepEqual(
    [props.frontOverlap.minimum, props.frontOverlap.maximum],
    [50, 98],
  );
  assert.deepEqual(
    [props.sideOverlap.minimum, props.sideOverlap.maximum],
    [40, 95],
  );
  assert.deepEqual(
    [props.tiltPitchDeg.minimum, props.tiltPitchDeg.maximum],
    [-80, -45],
  );
  assert.deepEqual(
    [props.orbitRadiusM.minimum, props.orbitRadiusM.maximum],
    [10, 300],
  );
  assert.equal(
    validateArgs(
      GEV_ACTION_SCHEMAS.find((s) => s.name === 'control_droneplan').parameters,
      { action: 'options', frontOverlap: 98 },
    ).length,
    0,
  );
});

test('set_panel_open accepts the Space Missions panel', () => {
  const schema = GEV_ACTION_SCHEMAS.find(
    (tool) => tool.name === 'set_panel_open',
  ).parameters;
  assert.deepEqual(
    validateArgs(schema, { panelId: 'space-missions-panel', open: true }),
    [],
  );
  assert.ok(
    validateArgs(schema, { panelId: 'space-missions', open: true }).length > 0,
    'the Context mode name is not a panel id',
  );
});
