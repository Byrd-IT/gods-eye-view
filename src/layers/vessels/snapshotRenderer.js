const KNOT_MPS = 1852 / 3600;
const finiteOrNaN = (value) =>
  typeof value === 'number' && Number.isFinite(value) ? value : NaN;

/**
 * A vessel record's fix as a host-supplied placement takes it: its own time
 * (when it was received, if the row gives none), position, speed in m/s
 * (rows give knots), course and heading.
 */
function placementFix(record) {
  const epoch = record.lastPositionEpoch;
  return {
    timeMs: Number.isFinite(epoch) ? epoch * 1000 : record.receivedAtMs,
    lat: record.lat,
    lon: record.lon,
    altitudeM: NaN,
    speedMps: Number.isFinite(record.speed) ? record.speed * KNOT_MPS : NaN,
    courseDeg: finiteOrNaN(record.course),
    headingDeg: finiteOrNaN(record.heading),
  };
}

/**
 * Connect portable vessel reconciliation to scene and selection operations.
 * `placement`, a host-supplied placement, is told each live fix.
 */
export function createVesselSnapshotRenderer({
  state,
  placement = null,
  records,
  rendering,
  tracking,
  selection,
  cards,
  followsClock = () => false,
}) {
  /** `replace`: the rows are the world at another time (see VesselRecords). */
  function reconcileVessels(
    viewer,
    rows,
    { complete = true, replace = false } = {},
  ) {
    rendering.ensureCollections(viewer);
    // GEV history seam (fork card B12a): a history frame is complete, pins
    // no selected vessel and starts the selected trail over at this time. It
    // reconciles as `replace` (the rows are the world at another time).
    const historyFrame = state.historyFrameArmed === true;
    if (historyFrame) {
      state.historyFrameArmed = false;
      state.trailAbort?.abort();
      state.trailBackfillToken += 1;
      state.trailPositions = [];
      state.trail?.clear();
    }
    const replaceFrame = replace || historyFrame;
    const occluder = rendering.makeOccluder();
    const follow = followsClock();
    // Live fixes only: following the clock, the layer places every vessel.
    const observe =
      placement && !follow && !replace
        ? (record) => {
            if (record.id) placement.observe(record.id, placementFix(record));
          }
        : () => {};
    records.reconcile(
      rows,
      {
        complete: complete || historyFrame,
        selectedRecord: state.selectedRecord,
        cap: rendering.renderRowLimit(),
        ...(replaceFrame && { replace: true }),
        ...(follow && { follow }),
      },
      {
        add(record) {
          observe(record);
          rendering.prepareRecordVisual(record);
          rendering.addRecordPrimitives(record, occluder);
        },
        updated(record) {
          observe(record);
          const selected = record === state.selectedRecord;
          rendering.prepareRecordVisual(record);
          rendering.syncRecordIcon(record);
          if (record.id === state.trailId)
            tracking.appendSelectedVesselTrailFix(record);
          if (selected) {
            cards.updateSelectedVesselHud(record);
            selection.registerSelectedContext(record);
          }
        },
        remove(record, evicted) {
          if (evicted) selection.clearVesselInspection({ evicted: true });
          rendering.removeRecordPrimitives(record);
        },
        removed(id) {
          placement?.forget(id);
          if (state.trailId === id) tracking.clearSelectedVesselTrail();
        },
        staleSelected(record) {
          cards.updateSelectedVesselHud(record);
        },
      },
    );
    // The selected vessel at the new time: its trail is drawn to it. (A history
    // frame must not carry the live ring-buffer path across times: its trail
    // restarts from the frame's own fixes.)
    if (replace && !historyFrame && state.selectedRecord && state.trailId)
      tracking.retimeSelectedVesselTrail(state.selectedRecord);
    state.lastVisibilityUpdate = 0;
    rendering.updateVisibility(true);
  }
  return { reconcileVessels };
}
