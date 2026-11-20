import test from 'node:test';
import assert from 'node:assert/strict';
import {createCoverageLayer} from './layer.js';
function harness(fail=false){
 const primitives=[], dataSources=[], handlers=[];
 class Collection {add(x){this.items??=[];this.items.push(x);return x;}}
 class DataSource {constructor(){this.entities={items:[],add(x){this.items.push(x)}};}}
 class Handler {constructor(){handlers.push(this)} setInputAction(fn){this.fn=fn} destroy(){this.dead=true}}
 const color={withAlpha(){return this}};
 const C={PrimitiveCollection:Collection,CustomDataSource:DataSource,Cartographic:{fromDegrees:(lon,lat)=>({lon,lat})},sampleTerrainMostDetailed:async(_,p)=>{if(fail)throw Error('terrain');return p.map(x=>({...x,height:100}))},Color:{RED:color,ORANGE:color,YELLOW:color,LIME:color,GRAY:color,MAGENTA:color,CYAN:color,BLACK:color},GeometryInstance:class{constructor(x){Object.assign(this,x)}},RectangleGeometry:class{constructor(x){Object.assign(this,x)}},Rectangle:{fromDegrees:(...x)=>x},PerInstanceColorAppearance:class{static VERTEX_FORMAT='v';constructor(x){Object.assign(this,x)}},ColorGeometryInstanceAttribute:{fromColor:x=>x},GroundPrimitive:class{constructor(x){Object.assign(this,x)}},Cartesian3:{fromDegrees:(...a)=>a,fromDegreesArray:a=>a},ScreenSpaceEventHandler:Handler,SceneTransforms:{worldToWindowCoordinates:()=>({x:3,y:4})},ScreenSpaceEventType:{LEFT_CLICK:1}};
 const viewer={terrainProvider:{},scene:{canvas:{},primitives:{add(x){primitives.push(x);return x},remove(x){primitives.splice(primitives.indexOf(x),1)}},pick:()=>null},dataSources:{async add(x){dataSources.push(x)},remove(x){dataSources.splice(dataSources.indexOf(x),1)}}};
 return {C,viewer,primitives,dataSources,handlers};
}
const state={meta:{origin:{lat:0,lon:0},ground_z:-10},photos:[{name:'p.jpg',lat:0,lon:0,z:5,placed:true,flags:[],footprint:[[0,0],[1,0],[1,1],[0,1]]}],cells:{nx:1,ny:1,x0:0,y0:0,cell_m:3,k:[0]},counts:[1],mask:new Set([0]),discarded:new Set()};
test('layer renders ground and terrain-aligned camera then removes both exactly once',async()=>{
 const h=harness(), picks=[]; const layer=await createCoverageLayer({Cesium:h.C,viewer:h.viewer,state,onPick:p=>picks.push(p)});
 assert.equal(h.primitives.length,1);assert.equal(h.primitives[0].items.length,1);assert.deepEqual(h.dataSources[0].entities.items[0].position,[0,0,115]);assert.deepEqual(layer.screenPoints(),[{name:'p.jpg',x:3,y:4}]);
 h.viewer.scene.pick=()=>({id:{type:'coverage-cell',key:0}});h.handlers[0].fn({position:{}});assert.deepEqual(picks,[{type:'cell',key:0}]);
 layer.destroy();layer.destroy();assert.equal(h.primitives.length,0);assert.equal(h.dataSources.length,0);assert(h.handlers[0].dead);
});
test('terrain failure removes all partially created resources',async()=>{
 const h=harness(true);await assert.rejects(createCoverageLayer({Cesium:h.C,viewer:h.viewer,state}));assert.equal(h.primitives.length,0);assert.equal(h.dataSources.length,0);
});
