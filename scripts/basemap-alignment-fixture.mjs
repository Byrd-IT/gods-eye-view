// Regenerates fixtures/alignment-austin.json (BASEMAP P6 item 5). Not a test;
// run by hand when the buildings or terrain version changes:
//
//   curl -o /tmp/b.glb  <edge>/v/<ver>/buildings/<impl>/14/3743/6745.glb
//   curl -o src/byrdit/basemap/fixtures/terrain-14-7487-10947.terrain \
//        <terrain-edge>/v/<ver>/terrain/cesium-mesh/ellipsoid/14/7487/10947.terrain
//   node scripts/basemap-alignment-fixture.mjs /tmp/b.glb > \
//        src/byrdit/basemap/fixtures/alignment-austin.json
//
// For every building of the glb whose lowest vertex falls inside the terrain
// tile it records that vertex (lon, lat, ellipsoid height) and the building's
// metadata (EXT_structural_metadata). The glb uses EXT_meshopt_compression;
// the decoder is the meshoptimizer package Cesium already depends on.
import fs from 'node:fs';
import { MeshoptDecoder } from 'meshoptimizer';
import { geographicTileBounds } from '../src/byrdit/basemap/fixtures/quantizedMesh.mjs';

const TILE = { z: 14, x: 7487, y: 10947 };
const [file] = process.argv.slice(2);
const b = fs.readFileSync(file);
const jsonLength = b.readUInt32LE(12);
const gltf = JSON.parse(b.subarray(20, 20 + jsonLength).toString());
const bin = b.subarray(20 + jsonLength + 8);
await MeshoptDecoder.ready;

function view(index) {
  const v = gltf.bufferViews[index];
  const ext = v.extensions?.EXT_meshopt_compression;
  if (!ext)
    return bin.buffer.slice(
      bin.byteOffset + (v.byteOffset ?? 0),
      bin.byteOffset + (v.byteOffset ?? 0) + v.byteLength,
    );
  const src = new Uint8Array(
    bin.buffer,
    bin.byteOffset + (ext.byteOffset ?? 0),
    ext.byteLength,
  );
  const out = new Uint8Array(ext.count * ext.byteStride);
  MeshoptDecoder.decodeGltfBuffer(
    out,
    ext.count,
    ext.byteStride,
    src,
    ext.mode,
    ext.filter,
  );
  return out.buffer;
}
function accessor(index, Type) {
  const a = gltf.accessors[index];
  const buffer = view(a.bufferView);
  const components = { SCALAR: 1, VEC2: 2, VEC3: 3, VEC4: 4 }[a.type];
  return new Type(buffer, a.byteOffset ?? 0, a.count * components);
}

const meta = gltf.extensions.EXT_structural_metadata;
const table = meta.propertyTables[0];
const props = table.properties;
const f32 = (name) => new Float32Array(view(props[name].values));
function strings(name) {
  if (!props[name]) return [];
  const values = new Uint8Array(view(props[name].values));
  const offsets = new Uint32Array(view(props[name].stringOffsets));
  const out = [];
  for (let i = 0; i < table.count; i++)
    out.push(
      Buffer.from(values.subarray(offsets[i], offsets[i + 1])).toString(),
    );
  return out;
}
const height = f32('height');
const ground = f32('ground_elev');
const method = strings('height_method');
const name = strings('name');

const A = 6378137;
const F = 1 / 298.257223563;
const E2 = F * (2 - F);
const M = gltf.nodes.find((n) => n.matrix)?.matrix;
function toGeodetic(x, y, z) {
  // glTF node space (Y up) -> ECEF (Z up) -> WGS84 geodetic.
  const X = M[0] * x + M[4] * y + M[8] * z + M[12];
  const Y = M[1] * x + M[5] * y + M[9] * z + M[13];
  const Z = M[2] * x + M[6] * y + M[10] * z + M[14];
  const [ex, ey, ez] = [X, -Z, Y];
  const p = Math.hypot(ex, ey);
  let lat = Math.atan2(ez, p * (1 - E2));
  let h = 0;
  for (let i = 0; i < 10; i++) {
    const s = Math.sin(lat);
    const N = A / Math.sqrt(1 - E2 * s * s);
    h = p / Math.cos(lat) - N;
    lat = Math.atan2(ez, p * (1 - (E2 * N) / (N + h)));
  }
  return {
    lon: (Math.atan2(ey, ex) * 180) / Math.PI,
    lat: (lat * 180) / Math.PI,
    h,
  };
}

const lowest = new Map();
for (const mesh of gltf.meshes)
  for (const primitive of mesh.primitives) {
    const pos = accessor(primitive.attributes.POSITION, Float32Array);
    const fidAccessor = gltf.accessors[primitive.attributes._FEATURE_ID_0];
    const FidType = { 5121: Uint8Array, 5123: Uint16Array, 5125: Uint32Array, 5126: Float32Array }[
      fidAccessor.componentType
    ];
    const fid = accessor(primitive.attributes._FEATURE_ID_0, FidType);
    for (let v = 0; v < fid.length; v++) {
      const f = fid[v];
      const y = pos[3 * v + 1];
      const best = lowest.get(f);
      if (!best || y < best.y)
        lowest.set(f, { y, x: pos[3 * v], z: pos[3 * v + 2] });
    }
  }

const [w, s, e, n] = geographicTileBounds(TILE);
const inside = [];
for (const [f, v] of [...lowest].sort((a, b) => a[0] - b[0])) {
  const g = toGeodetic(v.x, v.y, v.z);
  if (g.lon <= w || g.lon >= e || g.lat <= s || g.lat >= n) continue;
  inside.push({
    feature: f,
    lon: +g.lon.toFixed(7),
    lat: +g.lat.toFixed(7),
    baseM: +g.h.toFixed(2),
    groundElevM: +ground[f].toFixed(2),
    heightM: +height[f].toFixed(2),
    heightMethod: method[f] || null,
    name: name[f] || null,
  });
}
// Keep the fixture small: every k-th building, at most 80.
const step = Math.max(1, Math.ceil(inside.length / 80));
const buildings = inside.filter((_, i) => i % step === 0);
process.stdout.write(
  `${JSON.stringify(
    {
      source: {
        buildings: 'gev-buildings ov2026-09-23.1-v5-add 14/3743/6745.glb',
        terrain:
          'gev-basemap mh0.0.13-wm20261011 cesium-mesh/ellipsoid 14/7487/10947.terrain',
        buildingsInTile: inside.length,
      },
      tile: TILE,
      buildings,
    },
    null,
    1,
  )}\n`,
);
