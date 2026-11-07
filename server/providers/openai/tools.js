import { createActionTools } from '../../../src/voice/actionSchemas.js';
import { ACTION_DESCRIPTIONS } from './toolDescriptions.js';

/** Every voice tool, as the Realtime session describes them. */
export const GEV_REALTIME_TOOLS = createActionTools(ACTION_DESCRIPTIONS);

/**
 * The session's tools: the app actions, then additional function tools
 * whose names no action already uses.
 */
export function realtimeSessionTools(additional = []) {
  const names = new Set(GEV_REALTIME_TOOLS.map((tool) => tool.name));
  return [
    ...GEV_REALTIME_TOOLS,
    ...additional.filter((tool) => !names.has(tool.name)),
  ];
}

/** Tools that need an operator-configured Overpass (OVERPASS_UPSTREAMS). */
export const OVERPASS_ONLY_TOOLS = Object.freeze(['osm_query']);

/**
 * The tools one session is offered. Bulk OpenStreetMap place search runs
 * only on an operator's Overpass, so without one `osm_query` is left out
 * rather than offered and refused.
 * @param {Array<{name: string}>} tools
 * @param {{overpass?: boolean}} [options]
 */
export function offeredTools(tools, { overpass = false } = {}) {
  return overpass
    ? tools
    : tools.filter((tool) => !OVERPASS_ONLY_TOOLS.includes(tool.name));
}

// Schema keywords whose value is a subschema, a list of them, or a map of
// name -> subschema. Only these positions are walked, so a property that is
// merely NAMED `pattern`, an enum value, a default or a description is never
// mistaken for a regular expression.
const SUBSCHEMA_KEYS = [
  'items',
  'additionalProperties',
  'not',
  'contains',
  'propertyNames',
  'if',
  'then',
  'else',
];
const SUBSCHEMA_LIST_KEYS = ['anyOf', 'oneOf', 'allOf', 'prefixItems'];
const SUBSCHEMA_MAP_KEYS = [
  'properties',
  'patternProperties',
  '$defs',
  'definitions',
  'dependentSchemas',
];

/**
 * Whether a regular expression source uses a `\p{..}` / `\P{..}` Unicode
 * property escape. An escaped backslash (`\\p`) is a literal backslash then
 * `p`, so escapes are consumed pairwise rather than searched for textually.
 * @param {string} source
 */
function usesUnicodePropertyEscape(source) {
  for (let index = 0; index < source.length; index += 1) {
    if (source[index] !== '\\') continue;
    const escaped = source[index + 1];
    if (escaped === 'p' || escaped === 'P') return true;
    index += 1;
  }
  return false;
}

function stripUnicodePropertyPatterns(schema) {
  if (Array.isArray(schema)) {
    for (const item of schema) stripUnicodePropertyPatterns(item);
    return;
  }
  if (!schema || typeof schema !== 'object') return;
  if (
    typeof schema.pattern === 'string' &&
    usesUnicodePropertyEscape(schema.pattern)
  )
    delete schema.pattern;
  for (const key of SUBSCHEMA_KEYS) stripUnicodePropertyPatterns(schema[key]);
  for (const key of SUBSCHEMA_LIST_KEYS)
    stripUnicodePropertyPatterns(schema[key]);
  for (const key of SUBSCHEMA_MAP_KEYS)
    for (const child of Object.values(schema[key] ?? {}))
      stripUnicodePropertyPatterns(child);
}

/**
 * The tool list as OpenAI accepts it. OpenAI rejects a function-parameter
 * `pattern` that uses a Unicode property class (`\p{L}`) as "not a 'regex'",
 * and one such pattern fails the whole request: every Realtime mint and every
 * text-chat turn. So OpenAI gets a COPY with exactly those patterns removed.
 * The shared schemas keep the strict grammar, which Gemini receives as-is and
 * which local validation (`invalidCalls`, the action runner) still enforces on
 * the model's arguments. Names, descriptions and every other constraint are
 * carried over unchanged.
 * @template {{parameters?: object}} T
 * @param {T[]} tools
 * @returns {T[]}
 */
export function openAiPortableTools(tools) {
  return tools.map((tool) => {
    const copy = structuredClone(tool);
    stripUnicodePropertyPatterns(copy.parameters);
    return copy;
  });
}

/**
 * The app actions one session is offered.
 * @param {{overpass?: boolean}} [options]
 */
export function realtimeTools({ overpass = false } = {}) {
  return offeredTools(GEV_REALTIME_TOOLS, { overpass });
}
