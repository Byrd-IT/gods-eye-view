import { createCoverageStore } from './store.js';
import { createCoverageLayer } from './layer.js';
import { photosForCell } from './coverageCore.js';

/** Small Map Layers card section. No request is made until explicitly enabled. */
export function attachCoveragePanel({Cesium,viewer,container,doc=container?.ownerDocument,fetchImpl=globalThis.fetch,createLayer=createCoverageLayer}) {
  if (!container || !doc) return () => {};
  const store=createCoverageStore({fetchImpl}); let layer=null, epoch=0, selected=null, current=null;
  const section=doc.createElement('section'); section.className='gev-photo-coverage';
  const heading=doc.createElement('h3'); heading.textContent='Photo coverage'; section.append(heading);
  function el(tag,label,parent=section) {const n=doc.createElement(tag);if(label)n.textContent=label;parent.append(n);return n;}
  const toggle=el('button','Show photo coverage'); toggle.type='button';
  const controls=el('div',''); controls.hidden=true;
  const model=el('select','',controls); model.setAttribute('aria-label','Coverage model');
  for(const id of ['s4_today','s6_shop800','nov16plus']) {const o=el('option',id,model);o.value=id;}
  model.value='s4_today';
  const status=el('p','',controls); status.setAttribute('role','status');
  const undo=el('button','Undo',controls); undo.type='button';
  const detail=el('div','',controls);
  const saveName=el('input','',controls); saveName.placeholder='Keep set name'; saveName.setAttribute('aria-label','Keep set name');
  const save=el('button','Save keep set',controls); save.type='button';
  const sets=el('select','',controls); sets.setAttribute('aria-label','Saved keep sets');
  const restore=el('button','Load keep set',controls); restore.type='button';
  const gaps=el('div','',controls);
  container.append(section);
  function report(message) {status.textContent=message;}
  async function refreshSets(){const rows=await store.listSets();sets.replaceChildren();for(const row of rows){const o=el('option',String(row.name ?? row.file),sets);o.value=row.file;}}
  function showDetail(s) {
    detail.replaceChildren(); if(!selected)return;
    if(selected.type==='photo'){
      const p=s.photos.find(x=>x.name===selected.name); if(!p)return;
      const title=el('strong',p.name,detail);
      const img=el('img','',detail);img.alt=`Thumbnail: ${p.name}`;img.loading='lazy';img.style.maxWidth='100%';
      if (typeof p.thumb==='string' && /^thumbs\/[A-Za-z0-9][A-Za-z0-9._-]{0,150}\.jpg$/.test(p.thumb)) img.src=`/api/byrdit/coverage/${s.model}/${p.thumb}`;
      for(const [name,key,unit] of [['Height','height_ft','ft'],['Gimbal pitch','gimbal_pitch','deg'],['Flight date','flight_date',''],['Sharpness','sharpness',''],['Brightness','brightness',''],['3D points','points3d',''],['GPS error','gps_err_ft','ft'],['Splat loss','splat_loss','']]) el('div',`${name}: ${p[key] ?? 'unavailable'} ${unit}`,detail);
      for(const keep of [true,false]){const b=el('button',keep?'Keep':'Discard',detail);b.type='button';b.onclick=()=>update(store.setKept([p.name],keep));}
    } else {
      const index=s.cells.k.indexOf(selected.key); const list=index<0?[]:photosForCell(s.cells,s.photos,index,s.discarded);
      el('strong',`${list.length} kept photos see this cell`,detail);
      for(const p of list){const b=el('button',p.name,detail);b.type='button';b.onclick=()=>{selected={type:'photo',name:p.name};showDetail(store.snapshot());};}
    }
  }
  function showGaps(s){gaps.replaceChildren();el('strong','Needs better coverage',gaps);for(const gap of s.gaps.slice(0,8))el('div',`${Math.round(gap.areaM2*10.7639)} sq ft; ${gap.zero} zero-coverage cells`,gaps);}
  async function update(s){if(!s)return;current=s;const g=++epoch; layer?.destroy();layer=null;report('Drawing coverage...');showDetail(s);showGaps(s);
    try{const next=await createLayer({Cesium,viewer,state:s,onPick:p=>{selected=p;showDetail(store.snapshot());}});if(g!==epoch){next.destroy();return;}layer=next;report(`${s.photos.length} photos; ${s.discarded.size} discarded`);}catch{if(g===epoch)report('Coverage or terrain is unavailable');}}
  async function load(){selected=null;const g=++epoch;layer?.destroy();layer=null;report('Loading photo coverage...');try{const s=await store.load(model.value);if(g!==epoch||!s)return;await update(s);await refreshSets();}catch{if(g===epoch)report('Coverage data is unavailable');}}
  toggle.onclick=()=>{if(controls.hidden){controls.hidden=false;toggle.textContent='Hide photo coverage';load();}else{controls.hidden=true;toggle.textContent='Show photo coverage';epoch++;store.clear();layer?.destroy();layer=null;selected=null;current=null;}};
  model.onchange=load; undo.onclick=()=>update(store.undo());
  save.onclick=async()=>{try{await store.save(saveName.value);await refreshSets();report('Keep set saved');}catch{report('Keep set could not be saved');}};
  restore.onclick=async()=>{try{await update(await store.loadSet(sets.value));}catch{report('Keep set could not be loaded');}};
  return ()=>{epoch++;store.clear();layer?.destroy();section.remove();};
}
