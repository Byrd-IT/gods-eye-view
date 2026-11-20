import { cellCorners, modelHeight } from './coordinates.js';
import { coverageColor } from './coverageCore.js';

/** Ground coverage and camera positions; caller owns the primitive collection. */
export async function createCoverageLayer({Cesium,viewer,state,onPick=()=>{}}) {
  if (!Cesium || !viewer || !state) throw new Error('Coverage map unavailable');
  const collection = viewer.scene.primitives.add(new Cesium.PrimitiveCollection());
  const cameras = new Cesium.CustomDataSource('Photo coverage cameras');
  let destroyed = false, handler;
  try {
    await viewer.dataSources.add(cameras);
    const positions = state.photos.filter(p=>p.placed && Number.isFinite(p.lat) && Number.isFinite(p.lon) && (!state.visibleNames || state.visibleNames.has(p.name)));
    const cartographics = positions.map(p=>Cesium.Cartographic.fromDegrees(p.lon,p.lat));
    const terrain = cartographics.length ? await Cesium.sampleTerrainMostDetailed(viewer.terrainProvider,cartographics) : [];
    if (terrain.length !== positions.length || terrain.some(p=>!Number.isFinite(p.height))) throw new Error('Terrain height unavailable');
    const byCell = new Map(state.cells.k.map((k,i)=>[k,state.counts[i]]));
    const palette={red:Cesium.Color.RED,orange:Cesium.Color.ORANGE,yellow:Cesium.Color.YELLOW,green:Cesium.Color.LIME};
    const instances = [...state.mask].map(key=>{
      const corners=cellCorners(state.cells,state.meta.origin,key), a=corners[0],b=corners[2];
      const color=palette[coverageColor(byCell.get(key) ?? 0)].withAlpha(0.45);
      return new Cesium.GeometryInstance({id:{type:'coverage-cell',key},geometry:new Cesium.RectangleGeometry({rectangle:Cesium.Rectangle.fromDegrees(a.lon,a.lat,b.lon,b.lat),vertexFormat:Cesium.PerInstanceColorAppearance.VERTEX_FORMAT}),attributes:{color:Cesium.ColorGeometryInstanceAttribute.fromColor(color)}});
    });
    if (instances.length) collection.add(new Cesium.GroundPrimitive({geometryInstances:instances,appearance:new Cesium.PerInstanceColorAppearance({flat:true,translucent:true}),asynchronous:true}));
    positions.forEach((p,i)=>{
      const status=state.discarded.has(p.name)?Cesium.Color.GRAY:(p.flags?.length?Cesium.Color.MAGENTA:Cesium.Color.CYAN);
      cameras.entities.add({id:`photo:${p.name}`,position:Cesium.Cartesian3.fromDegrees(p.lon,p.lat,modelHeight(p.z,state.meta.ground_z,terrain[i].height)),point:{pixelSize:7,color:status,outlineColor:Cesium.Color.BLACK,outlineWidth:1},properties:{photoName:p.name}});
    });
    handler=new Cesium.ScreenSpaceEventHandler(viewer.scene.canvas);
    handler.setInputAction(event=>{
      const hit=viewer.scene.pick(event.position); const id=hit?.id;
      if (id?.type==='coverage-cell') onPick({type:'cell',key:id.key});
      else if (typeof id?.id==='string' && id.id.startsWith('photo:')) onPick({type:'photo',name:id.id.slice(6)});
    },Cesium.ScreenSpaceEventType.LEFT_CLICK);
    return {destroy(){if(destroyed)return;destroyed=true;handler?.destroy();viewer.dataSources.remove(cameras,true);viewer.scene.primitives.remove(collection);}};
  } catch(error) {
    handler?.destroy(); viewer.dataSources.remove(cameras,true); viewer.scene.primitives.remove(collection); throw error;
  }
}
