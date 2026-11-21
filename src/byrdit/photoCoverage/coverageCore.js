// Coverage is based on actual reconstructed 3D observations, not drone location.
// A cell's list contains indices into the matching model's photos array.

function vector3(value) {
  return (
    Array.isArray(value) && value.length === 3 && value.every(Number.isFinite)
  );
}

// A shallow photo (looks_at_ground === false) claims a cell only when that
// cell's centre is inside the camera's actual frame and strictly below the
// camera's horizon. The reconstructed observation lists say a shallow photo
// saw a cell; this check keeps only the observations its real pose supports.
// Missing or malformed geometry fails closed for that observation.
function shallowSeesCell(cells, cellIndex, photo) {
  if (
    !Number.isInteger(cells?.nx) ||
    cells.nx <= 0 ||
    !Number.isInteger(cells?.ny) ||
    cells.ny <= 0 ||
    !Number.isFinite(cells?.x0) ||
    !Number.isFinite(cells?.y0) ||
    !Number.isFinite(cells?.cell_m) ||
    cells.cell_m <= 0 ||
    !Array.isArray(cells?.k) ||
    !Array.isArray(cells?.z) ||
    cells.k.length !== cells.photos.length ||
    cells.z.length !== cells.k.length
  )
    return false;
  const key = cells.k[cellIndex],
    z = cells.z[cellIndex];
  if (
    !Number.isInteger(key) ||
    key < 0 ||
    key >= cells.nx * cells.ny ||
    !Number.isFinite(z) ||
    ![photo?.x, photo?.y, photo?.z, photo?.hfov, photo?.vfov].every(
      Number.isFinite,
    ) ||
    !vector3(photo.fwd) ||
    !vector3(photo.right) ||
    !vector3(photo.down) ||
    photo.hfov <= 0 ||
    photo.hfov >= 180 ||
    photo.vfov <= 0 ||
    photo.vfov >= 180
  )
    return false;
  const x = cells.x0 + ((key % cells.nx) + 0.5) * cells.cell_m,
    y = cells.y0 + (Math.floor(key / cells.nx) + 0.5) * cells.cell_m,
    wx = x - photo.x,
    wy = y - photo.y,
    wz = z - photo.z;
  // Ground a shallow camera can see is below it; a cell on or above the
  // camera's altitude lies on or above the horizon and is not ground cover.
  if (!(wz < 0)) return false;
  const xc = wx * photo.fwd[0] + wy * photo.fwd[1] + wz * photo.fwd[2];
  if (!(xc > 0)) return false; // at or behind the image plane
  const yc = wx * photo.right[0] + wy * photo.right[1] + wz * photo.right[2],
    zc = wx * photo.down[0] + wy * photo.down[1] + wz * photo.down[2],
    tx = Math.tan((photo.hfov * Math.PI) / 360),
    ty = Math.tan((photo.vfov * Math.PI) / 360);
  return Math.abs(yc) < tx * xc && Math.abs(zc) < ty * xc;
}

// The one eligibility rule shared by counts and per-cell photo lists.
function observed(cells, cellIndex, photo, discarded, included) {
  return (
    photo?.placed &&
    !discarded.has(photo.name) &&
    (!included || included.has(photo.name)) &&
    (photo.looks_at_ground !== false ||
      shallowSeesCell(cells, cellIndex, photo))
  );
}

export function coverageCounts(
  cells,
  photos,
  discarded = new Set(),
  included = null,
) {
  if (
    !Array.isArray(cells?.photos) ||
    !Array.isArray(cells?.k) ||
    cells.photos.length !== cells.k.length ||
    !Array.isArray(photos)
  ) {
    throw new Error('Invalid coverage data');
  }
  return cells.photos.map((indices, cellIndex) => {
    if (!Array.isArray(indices)) throw new Error('Invalid coverage data');
    const seen = new Set();
    for (const i of indices) {
      if (!Number.isInteger(i) || i < 0 || i >= photos.length)
        throw new Error('Invalid coverage data');
      if (observed(cells, cellIndex, photos[i], discarded, included))
        seen.add(i);
    }
    return seen.size;
  });
}

export function coverageColor(count) {
  if (count <= 0) return 'red';
  if (count <= 2) return 'orange';
  if (count <= 4) return 'yellow';
  return 'green';
}

export function photosForCell(
  cells,
  photos,
  index,
  discarded = new Set(),
  included = null,
) {
  coverageCounts(cells, photos, discarded, included); // validate indices and matching arrays first
  if (!Number.isInteger(index) || index < 0 || index >= cells.photos.length)
    return [];
  return [...new Set(cells.photos[index])]
    .map((i) => photos[i])
    .filter((p) => observed(cells, index, p, discarded, included));
}
