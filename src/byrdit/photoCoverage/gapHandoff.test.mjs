import test from 'node:test';
import assert from 'node:assert/strict';
import {fakeDocument} from '../historyUi/fakeDom.mjs';
import {attachCoveragePanel} from './panel.js';
const tick=()=>new Promise(r=>setImmediate(r));
test('gap handoff adds an explicitly labelled bounding polygon to flight plan',async()=>{
 const doc=fakeDocument(),root=doc.createElement('div');let ring=null, opened=false;
 doc.defaultView={__gevDronePlan:{setPolygon(r){ring=r;return true},open(){opened=true}}};
 const model='s4_today'; const photos=[{name:'p',placed:true,looks_at_ground:true,x:0,y:0}];
 const cells={model,nx:3,ny:3,x0:0,y0:0,cell_m:10,k:[],photos:[]};
 const fetchImpl=async url=>({ok:true,json:async()=>url.endsWith('/model.json')?{id:model,origin:{lat:0,lon:0}}:url.endsWith('/photos.json')?{model,photos}:url.endsWith('/cells.json')?cells:[]});
 const detach=attachCoveragePanel({doc,container:root,viewer:{},Cesium:{},fetchImpl,createLayer:async()=>({destroy(){}})});
 root.find(n=>n.textContent==='Show photo coverage').onclick();await tick();await tick();
 const send=root.find(n=>n.textContent==='Send bounding box to Drone Flight Plan');assert(send);send.onclick();assert.equal(ring.length,4);assert(opened);assert(root.textContent.includes('Gap bounding box added'));detach();
});
