/**
 * A small XML reader for WPML/KML files (DOMParser is not in Node and the
 * files are tiny). Elements, attributes, text, CDATA, comments and the five
 * entities. No DTD or external entities are ever read, so a hostile file
 * cannot pull anything in. Depth and node counts are capped.
 */
export const MAX_XML_NODES = 200_000;
export const MAX_XML_DEPTH = 64;

const ENTITIES = { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'" };
const decode = (s) =>
  s.replace(/&(#x[0-9a-f]+|#\d+|amp|lt|gt|quot|apos);/gi, (all, name) => {
    if (name[0] === '#') {
      const code =
        name[1] === 'x' || name[1] === 'X'
          ? parseInt(name.slice(2), 16)
          : parseInt(name.slice(1), 10);
      return Number.isInteger(code) && code > 0 && code <= 0x10ffff
        ? String.fromCodePoint(code)
        : all;
    }
    return ENTITIES[name.toLowerCase()] ?? all;
  });

/**
 * @param {string} text
 * @returns {{ name: string, attrs: object, children: object[], text: string }}
 * @throws {Error} on markup that is not well formed
 */
export function parseXml(text) {
  const root = { name: '#root', attrs: {}, children: [], text: '' };
  const stack = [root];
  const re =
    /<\?[\s\S]*?\?>|<!--[\s\S]*?-->|<!\[CDATA\[([\s\S]*?)\]\]>|<(\/?)([A-Za-z_][\w:.-]*)((?:\s+[\w:.-]+\s*=\s*(?:"[^"]*"|'[^']*'))*)\s*(\/?)>|([^<]+)|(<)/g;
  let nodes = 0;
  let m;
  while ((m = re.exec(text))) {
    const [, cdata, close, name, attrText, selfClose, chars, stray] = m;
    if (stray) throw new Error('Malformed XML');
    if (cdata !== undefined) {
      stack.at(-1).text += cdata;
    } else if (chars !== undefined) {
      stack.at(-1).text += decode(chars);
    } else if (name && !close) {
      nodes += 1;
      if (nodes > MAX_XML_NODES) throw new Error('XML is too large');
      const attrs = {};
      for (const a of attrText.matchAll(
        /([\w:.-]+)\s*=\s*(?:"([^"]*)"|'([^']*)')/g,
      )) {
        attrs[a[1]] = decode(a[2] ?? a[3]);
      }
      const node = { name, attrs, children: [], text: '' };
      stack.at(-1).children.push(node);
      if (!selfClose) {
        stack.push(node);
        if (stack.length > MAX_XML_DEPTH)
          throw new Error('XML is nested too deep');
      }
    } else if (name && close) {
      const open = stack.pop();
      if (stack.length === 0 || open.name !== name) {
        throw new Error(`Mismatched </${name}>`);
      }
    }
  }
  if (stack.length !== 1) throw new Error('Unclosed XML element');
  return root;
}

/** Every descendant (and the node itself) called `name`. */
export function findAll(node, name, out = []) {
  if (node.name === name) out.push(node);
  for (const c of node.children) findAll(c, name, out);
  return out;
}
export const findFirst = (node, name) => findAll(node, name)[0] ?? null;
/** Trimmed text of the first descendant called `name`, or null. */
export const textOf = (node, name) => {
  const found = node ? findFirst(node, name) : null;
  return found ? found.text.trim() : null;
};
/** Direct children called `name`. */
export const kids = (node, name) =>
  node.children.filter((c) => c.name === name);
