import test from 'node:test';
import assert from 'node:assert/strict';
import {fakeDocument} from '../historyUi/fakeDom.mjs';
import {attachCoveragePanel} from './panel.js';
const model='s4_today';
const photos=[{name:'p.jpg',placed:true,looks_at_ground:true,x:0,y:0,lat:0,lon:0,z:1,thumb:'thumbs/p.jpg',flags:[]}];
const cells={model,nx:1,ny:1,x0:0,y0:0,cell_m:10,k:[0],photos:[[0]]};
const ok=value=>({ok:true,json:async()=>value});
const tick=()=>new Promise(r=>setImmediate(r));
test('no fetch before opt-in; photo selection, discard, and teardown',async()=>{
 const doc=fakeDocument(),root=doc.createElement('div');let requests=[],layers=[],pick;
 const fetchImpl=async(url)=>{requests.push(url);if(url.endsWith('/model.json'))return ok({id:model,origin:{lat:0,lon:0},ground_z:0});if(url.endsWith('/photos.json'))return ok({model,photos});if(url.endsWith('/cells.json'))return ok(cells);return ok([])};
 const createLayer=async x=>{pick=x.onPick;const layer={dead:false,destroy(){this.dead=true}};layers.push(layer);return layer};
 const detach=attachCoveragePanel({doc,container:root,viewer:{},Cesium:{},fetchImpl,createLayer});assert.equal(requests.length,0);
 const toggle=root.find(n=>n.textContent==='Show photo coverage');toggle.onclick();await tick();await tick();assert.equal(layers.length,1);
 pick({type:'photo',name:'p.jpg'});assert(root.textContent.includes('p.jpg'));
 const discard=root.find(n=>n.textContent==='Discard');discard.onclick();await tick();assert.equal(layers.length,2);assert(layers[0].dead);
 toggle.onclick();assert(layers[1].dead);detach();assert.equal(root.children.length,0);
});
