// Select visible camera marker positions in viewport CSS pixels.
export function selectScreenPoints(points, start, end, mode) {
  if (!['box','circle'].includes(mode) || ![start?.x,start?.y,end?.x,end?.y].every(Number.isFinite)) return [];
  const dx=end.x-start.x,dy=end.y-start.y, radius2=dx*dx+dy*dy;
  return points.filter(p=>Number.isFinite(p.x)&&Number.isFinite(p.y)&&(mode==='circle' ? (p.x-start.x)**2+(p.y-start.y)**2<=radius2 : p.x>=Math.min(start.x,end.x)&&p.x<=Math.max(start.x,end.x)&&p.y>=Math.min(start.y,end.y)&&p.y<=Math.max(start.y,end.y))).map(p=>p.name);
}
