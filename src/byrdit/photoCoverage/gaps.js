// Default area of interest: observed cells with two neighbouring observations,
// plus the area within 100 feet of placed cameras. A drawn AOI can replace it.
export function defaultArea(cells, photos) {
  const { nx, ny, x0, y0, cell_m: size, k } = cells;
  if (!Number.isInteger(nx) || !Number.isInteger(ny) || nx < 1 || ny < 1 || nx * ny > 10000000 || !Number.isFinite(size) || size <= 0 || !Number.isFinite(x0) || !Number.isFinite(y0) || !Array.isArray(k)) throw new Error('Invalid coverage grid');
  const valid = (i,j) => i >= 0 && i < nx && j >= 0 && j < ny;
  const observed = new Set(k.filter(n => Number.isInteger(n) && n >= 0 && n < nx * ny));
  const mask = new Set();
  for (const n of observed) {
    const i = n % nx, j = Math.floor(n / nx);
    let neighbors = 0;
    for (let dj = -1; dj <= 1; dj++) for (let di = -1; di <= 1; di++) {
      if ((di || dj) && valid(i + di, j + dj) && observed.has((j + dj) * nx + i + di)) neighbors++;
    }
    if (neighbors >= 2) mask.add(n);
  }
  const radius = Math.ceil(30.48 / size);
  for (const photo of photos) {
    if (!photo.placed || !Number.isFinite(photo.x) || !Number.isFinite(photo.y)) continue;
    const ci = Math.floor((photo.x - x0) / size), cj = Math.floor((photo.y - y0) / size);
    for (let j = Math.max(0,cj-radius); j <= Math.min(ny-1,cj+radius); j++) for (let i = Math.max(0,ci-radius); i <= Math.min(nx-1,ci+radius); i++) {
      if ((i-ci)**2 + (j-cj)**2 <= radius**2) mask.add(j*nx+i);
    }
  }
  return mask;
}

export function rankGaps(cells, mask, counts) {
  if (!Array.isArray(counts) || counts.length !== cells.k.length) throw new Error('Invalid coverage counts');
  const {nx, ny, x0, y0, cell_m:size} = cells;
  const byCell = new Map(cells.k.map((k,i)=>[k,counts[i]]));
  const low = new Set([...mask].filter(k => Number.isInteger(k) && k >= 0 && k < nx*ny && (byCell.get(k) ?? 0) <= 2));
  const visited = new Set(), gaps = [];
  for (const start of low) {
    if (visited.has(start)) continue;
    const todo = [start], group = []; visited.add(start);
    let x = 0, y = 0, zero = 0;
    while (todo.length) {
      const k = todo.pop(), i = k % nx, j = Math.floor(k / nx); group.push(k);
      x += x0 + (i+0.5)*size; y += y0 + (j+0.5)*size;
      if (!(byCell.get(k) ?? 0)) zero++;
      for (const [di,dj] of [[1,0],[-1,0],[0,1],[0,-1]]) {
        const ni=i+di,nj=j+dj; if (ni<0 || ni>=nx || nj<0 || nj>=ny) continue;
        const n=nj*nx+ni; if (low.has(n) && !visited.has(n)) {visited.add(n);todo.push(n);}
      }
    }
    if (group.length >= 4) gaps.push({cells:group, zero, x:x/group.length, y:y/group.length, areaM2:group.length*size*size});
  }
  return gaps.sort((a,b)=>(b.zero*3+b.cells.length)-(a.zero*3+a.cells.length));
}
