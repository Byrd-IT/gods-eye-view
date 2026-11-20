// Coverage is based on actual reconstructed 3D observations, not drone location.
// A cell's list contains indices into the matching model's photos array.
export function coverageCounts(cells, photos, discarded = new Set()) {
  if (!Array.isArray(cells?.photos) || !Array.isArray(cells?.k) || cells.photos.length !== cells.k.length || !Array.isArray(photos)) {
    throw new Error('Invalid coverage data');
  }
  return cells.photos.map((indices) => {
    if (!Array.isArray(indices)) throw new Error('Invalid coverage data');
    const seen = new Set();
    for (const i of indices) {
      if (!Number.isInteger(i) || i < 0 || i >= photos.length) throw new Error('Invalid coverage data');
      const photo = photos[i];
      if (photo?.placed && photo.looks_at_ground !== false && !discarded.has(photo.name)) seen.add(i);
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

export function photosForCell(cells, photos, index, discarded = new Set()) {
  coverageCounts(cells, photos, discarded); // validate indices and matching arrays first
  if (!Number.isInteger(index) || index < 0 || index >= cells.photos.length) return [];
  return [...new Set(cells.photos[index])].map((i) => photos[i]).filter((p) => p.placed && p.looks_at_ground !== false && !discarded.has(p.name));
}
