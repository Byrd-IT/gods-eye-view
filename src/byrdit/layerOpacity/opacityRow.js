/**
 * Byrd-IT fork: the "Opacity" row under a layer in the layer panel.
 * Uses the shared native slider (ui/slider.js), like the overlays panel (M5).
 * A 0..100 % control; 100 % is the default and changes nothing.
 */
import { createSlider } from '../../ui/slider.js';
import { OPACITY_STEP_PCT, opacityPercent } from './opacityModel.js';

/**
 * @param {object} o
 * @param {Document} o.documentRef
 * @param {{get:(id:string)=>number,set:(id:string,v:number)=>boolean,subscribe:(fn:Function)=>Function}} o.model
 * @param {string} o.layerId
 * @param {string} [o.label] Member name when a row holds several layers.
 * @param {(text:string)=>string} [o.translate]
 * @returns {{element: HTMLElement, dispose: () => void}}
 */
export function createOpacityRow({
  documentRef = globalThis.document,
  model,
  layerId,
  label = '',
  translate = (text) => text,
}) {
  const element = documentRef.createElement('div');
  element.className = 'layer-opacity-row';
  element.dataset.opacityFor = layerId;
  const text = documentRef.createElement('span');
  text.className = 'layer-opacity-label';
  text.textContent = label
    ? `${translate('Opacity')}: ${label}`
    : translate('Opacity');
  const slider = createSlider({
    documentRef,
    className: 'layer-opacity-slider',
    min: 0,
    max: 100,
    step: OPACITY_STEP_PCT,
    value: opacityPercent(model.get(layerId)),
    ariaLabel: label
      ? `${translate('Opacity')}: ${label}`
      : `${translate('Layer opacity')} ${layerId}`,
  });
  const readout = documentRef.createElement('span');
  readout.className = 'layer-opacity-value';
  const show = () => {
    const pct = opacityPercent(model.get(layerId));
    if (Number(slider.value) !== pct) slider.value = String(pct);
    readout.textContent = `${pct}%`;
  };
  const onInput = () => {
    model.set(layerId, Number(slider.value) / 100);
    show();
  };
  // A double-click returns the layer to its default of 100 %.
  const onReset = () => {
    model.set(layerId, 1);
    show();
  };
  slider.addEventListener('input', onInput);
  slider.addEventListener('dblclick', onReset);
  const unsubscribe = model.subscribe((id) => {
    if (id === layerId) show();
  });
  show();
  element.append(text, slider, readout);
  return {
    element,
    dispose() {
      slider.removeEventListener('input', onInput);
      slider.removeEventListener('dblclick', onReset);
      unsubscribe();
    },
  };
}
