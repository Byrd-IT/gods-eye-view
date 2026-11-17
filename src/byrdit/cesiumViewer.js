/**
 * @module byrdit/cesiumViewer
 * @description Byrd-IT: the Cesium viewer behind the scene object the app
 * hands the fork's modules. Upstream's renderer seam (#1760) made that object
 * a frozen scene host with no Cesium API; the fork's Cesium-direct features
 * (drone plan, sky view, nav control, history, solunar, basemap, opacity,
 * USGS water, CCTV visibility) take the viewer behind it here, once, at their
 * entry points. A Cesium viewer (tests, no renderer bound) passes through.
 */
import { viewerBehind } from '../render/cesium/viewers.js';

/** @param {object|null|undefined} host @returns {object|null|undefined} */
export const cesiumViewerFor = (host) => viewerBehind(host);
