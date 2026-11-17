/**
 * @module byrdit/dronePlan/testDoubles
 * @description Byrd-IT test fakes: the drone-plan tools still bind a Cesium
 * ScreenSpaceEventHandler of their own, so their tests keep the fork's
 * Cesium-direct box-tool fakes. Upstream's `recentImagery/testDoubles.mjs`
 * moved to the renderer's input port (#1760).
 */

const EVENT_TYPES = {
  LEFT_DOWN: 'down',
  MOUSE_MOVE: 'move',
  LEFT_UP: 'up',
  LEFT_CLICK: 'click',
  LEFT_DOUBLE_CLICK: 'dblclick',
};

export function boxToolFakes() {
  const handlers = [];
  class ScreenSpaceEventHandler {
    constructor(canvas) {
      this.canvas = canvas;
      this.actions = new Map();
      this.destroyed = false;
      handlers.push(this);
    }
    setInputAction(fn, type) {
      this.actions.set(type, fn);
    }
    getInputAction(type) {
      return this.actions.get(type);
    }
    removeInputAction(type) {
      this.actions.delete(type);
    }
    destroy() {
      this.destroyed = true;
    }
  }
  class CustomDataSource {
    constructor(name) {
      this.name = name;
      const values = [];
      this.entities = {
        values,
        add: (entity) => (values.push(entity), entity),
        removeAll: () => values.splice(0),
      };
    }
  }
  const color = { withAlpha: (alpha) => ({ alpha }) };
  const cesium = {
    ScreenSpaceEventHandler,
    ScreenSpaceEventType: EVENT_TYPES,
    CustomDataSource,
    CallbackProperty: class {},
    PolylineDashMaterialProperty: class {},
    ClassificationType: { BOTH: 'both' },
    Color: { fromCssColorString: () => color },
    Rectangle: { fromDegrees: () => ({}) },
    Cartesian3: { fromDegreesArray: (values) => values },
  };

  const stock = new ScreenSpaceEventHandler('stock');
  const originalClick = () => 'select';
  const originalDouble = () => 'track';
  stock.setInputAction(originalClick, EVENT_TYPES.LEFT_CLICK);
  stock.setInputAction(originalDouble, EVENT_TYPES.LEFT_DOUBLE_CLICK);
  const sources = [];
  const viewer = {
    renders: 0,
    scene: {
      canvas: { clientWidth: 1000, clientHeight: 500 },
      screenSpaceCameraController: { enableInputs: true },
      requestRender: () => {
        viewer.renders += 1;
      },
    },
    screenSpaceEventHandler: stock,
    dataSources: {
      sources,
      add: (source) => (sources.push(source), Promise.resolve(source)),
      remove: (source) => sources.splice(sources.indexOf(source), 1),
    },
  };

  const listeners = [];
  const classes = new Set();
  const documentRef = {
    listeners,
    classes,
    addEventListener: (type, fn) => listeners.push([type, fn]),
    removeEventListener: (type, fn) => {
      const index = listeners.findIndex((entry) => entry[1] === fn);
      if (index >= 0) listeners.splice(index, 1);
    },
    body: {
      classList: {
        add: (name) => classes.add(name),
        remove: (name) => classes.delete(name),
      },
    },
  };

  const pickWorld = (_viewer, nx, ny) =>
    ny * 500 < 40 ? null : { lon: -97.9 + nx * 0.2, lat: 30.4 - ny * 0.2 };
  /** The live (non-stock) canvas handler, if the tool has one bound. */
  const handler = () =>
    handlers.find((h) => h.canvas !== 'stock' && !h.destroyed) || null;
  const fire = (type, event) =>
    handler()?.actions.get(EVENT_TYPES[type])?.(event);
  /** Dispatch a keydown to the tool's document listener. */
  const key = (name) => {
    const event = {
      key: name,
      prevented: false,
      stopped: false,
      preventDefault() {
        this.prevented = true;
      },
      stopImmediatePropagation() {
        this.stopped = true;
      },
    };
    listeners.find(([type]) => type === 'keydown')?.[1](event);
    return event;
  };
  return {
    cesium,
    viewer,
    documentRef,
    pickWorld,
    handler,
    fire,
    key,
    types: EVENT_TYPES,
    originalClick,
    originalDouble,
  };
}

// ---- the layer's injected parts --------------------------------------
