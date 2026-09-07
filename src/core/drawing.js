/**
 * Core drawing logic.
 */
import { evaluate as _evaluate, getChartApi as _getChartApi, safeString, requireFinite } from '../connection.js';
import { ClassifiedError, CATEGORIES } from '../errors.js';

function _resolve(deps) {
  return { evaluate: deps?.evaluate || _evaluate, getChartApi: deps?.getChartApi || _getChartApi };
}

export async function drawShape({ shape, point, point2, overrides: overridesRaw, text, _deps }) {
  const { evaluate, getChartApi } = _resolve(_deps);
  let overrides;
  try {
    overrides = overridesRaw ? (typeof overridesRaw === 'string' ? JSON.parse(overridesRaw) : overridesRaw) : {};
  } catch (err) {
    throw new ClassifiedError(
      CATEGORIES.INVALID_ARGUMENT,
      `overrides is not valid JSON: ${err.message}`,
      { hint: 'Pass overrides as a JSON object or a JSON-encoded object string.' },
    );
  }
  const apiPath = await getChartApi();
  const overridesStr = JSON.stringify(overrides || {});
  const textStr = text ? JSON.stringify(text) : '""';

  const p1time = requireFinite(point.time, 'point.time');
  const p1price = requireFinite(point.price, 'point.price');

  const before = await evaluate(`${apiPath}.getAllShapes().map(function(s) { return { id: s.id, name: s.name }; })`);

  if (point2) {
    const p2time = requireFinite(point2.time, 'point2.time');
    const p2price = requireFinite(point2.price, 'point2.price');
    await evaluate(`
      ${apiPath}.createMultipointShape(
        [{ time: ${p1time}, price: ${p1price} }, { time: ${p2time}, price: ${p2price} }],
        { shape: ${safeString(shape)}, overrides: ${overridesStr}, text: ${textStr} }
      )
    `);
  } else {
    await evaluate(`
      ${apiPath}.createShape(
        { time: ${p1time}, price: ${p1price} },
        { shape: ${safeString(shape)}, overrides: ${overridesStr}, text: ${textStr} }
      )
    `);
  }

  await new Promise(r => setTimeout(r, 200));
  // ISSUE #8: AN UNKNOWN SHAPE NAME DOES NOT FAIL, IT BECOMES A FLAG.
  //
  // TradingView falls back to a default for a name it does not recognise, and
  // this returned {success: true, shape: "not_a_real_shape"} with a real entity
  // id. draw_get_properties on that id said name: "flag". So a typo silently
  // produced a flag at the right coordinates, and the result echoed the name
  // you ASKED for rather than the one you got - which is the whole bug: the
  // response was built from the request, not from a read.
  //
  // The before/after diff already finds the new id, so the created shape's own
  // name is one property away. Read it, and report both.
  const after = await evaluate(`${apiPath}.getAllShapes().map(function(s) { return { id: s.id, name: s.name }; })`);
  const beforeIds = new Set((before || []).map((entry) => (entry && typeof entry === 'object' ? entry.id : entry)));
  const created = (after || []).find((entry) => !beforeIds.has(entry?.id)) || null;
  const newId = created?.id || null;
  const createdName = created?.name ?? null;

  if (!newId) {
    throw new ClassifiedError(
      CATEGORIES.API_UNEXPECTED,
      `TradingView accepted shape "${shape}" but no new drawing appeared on the chart`,
      { hint: 'Check the coordinates are inside the loaded range, and that the chart is not in a state that rejects drawings.' },
    );
  }

  // A name that came back different from the one requested is TradingView's
  // fallback, not our drawing. Fail closed: a caller that wanted a rectangle and
  // silently got a flag has a wrong chart and no way to know.
  if (createdName && !_shapeNameMatches(shape, createdName)) {
    // SETUP-VERIFIED CLEANUP: this removal runs only because the creation was
    // verifiably read back above, so it can never delete something it did not
    // make. Leaving the wrong drawing on the operator's chart and reporting an
    // error would be its own small mess.
    let removed = false;
    try {
      await evaluate(`${apiPath}.removeEntity(${safeString(newId)})`);
      const remaining = await evaluate(`${apiPath}.getAllShapes().map(function(s) { return s.id; })`);
      removed = !(remaining || []).includes(newId);
    } catch (_) {
      removed = false;
    }
    throw new ClassifiedError(
      CATEGORIES.INVALID_ARGUMENT,
      `"${shape}" is not a shape TradingView recognises: it silently fell back to "${createdName}". ` +
        (removed
          ? 'The wrong drawing was removed from the chart.'
          : `The wrong drawing is STILL ON THE CHART as ${newId} and could not be removed; delete it with draw_remove_one.`),
      {
        hint: 'Check the shape name. draw_list shows what is on the chart.',
        shape_requested: shape,
        shape_created: createdName,
        entity_id: newId,
        cleanup_removed: removed,
      },
    );
  }

  return {
    success: true,
    shape,
    shape_created: createdName,
    entity_id: newId,
    // Absence of a name is not a mismatch, but it is not verification either.
    shape_verified: createdName !== null,
  };
}

/**
 * TradingView reports a created shape's name in its own vocabulary, which is
 * not always character-identical to the argument (`horizontal_line` comes back
 * as `horzline` on 3.3.0). Compare on the alphanumeric core so a legitimate
 * spelling difference is not reported as a fallback.
 */
export function _shapeNameMatches(requested, created) {
  const norm = (v) => String(v || '').toLowerCase().replace(/[^a-z0-9]/g, '');
  const a = norm(requested);
  const b = norm(created);
  if (!a || !b) return false;
  if (a === b) return true;
  const ALIASES = {
    horizontalline: ['horzline', 'horizontalline'],
    verticalline: ['vertline', 'verticalline'],
    horizontalray: ['horzray', 'horizontalray'],
    trendline: ['trendline'],
    fibretracement: ['fibretracement'],
    anchoredvwap: ['anchoredvwap', 'anchoredvwapshape'],
    longposition: ['longposition', 'riskrewardlong'],
    shortposition: ['shortposition', 'riskrewardshort'],
    fixedrangevolumeprofile: ['fixedrangevolumeprofile', 'fixedrangevolumeprofilehorz'],
  };
  const accepted = ALIASES[a];
  if (accepted && accepted.includes(b)) return true;
  // Substring either way covers TradingView prefixing or suffixing its own kind.
  return a.includes(b) || b.includes(a);
}

export async function listDrawings({ _deps } = {}) {
  const { evaluate, getChartApi } = _resolve(_deps);
  const apiPath = await getChartApi();
  const shapes = await evaluate(`
    (function() {
      var api = ${apiPath};
      var all = api.getAllShapes();
      return all.map(function(s) { return { id: s.id, name: s.name }; });
    })()
  `);
  return { success: true, count: shapes?.length || 0, shapes: shapes || [] };
}

export async function getProperties({ entity_id, _deps } = {}) {
  const { evaluate, getChartApi } = _resolve(_deps);
  const apiPath = await getChartApi();
  const result = await evaluate(`
    (function() {
      var api = ${apiPath};
      var eid = ${safeString(entity_id)};
      var props = { entity_id: eid };
      var shape = api.getShapeById(eid);
      if (!shape) return { error: 'Shape not found: ' + eid };
      var methods = [];
      try { for (var key in shape) { if (typeof shape[key] === 'function') methods.push(key); } props.available_methods = methods; } catch(e) {}
      try { var pts = shape.getPoints(); if (pts) props.points = pts; } catch(e) { props.points_error = e.message; }
      try { var ovr = shape.getProperties(); if (ovr) props.properties = ovr; } catch(e) {
        try { var ovr2 = shape.properties(); if (ovr2) props.properties = ovr2; } catch(e2) { props.properties_error = e2.message; }
      }
      try { props.visible = shape.isVisible(); } catch(e) {}
      try { props.locked = shape.isLocked(); } catch(e) {}
      try { props.selectable = shape.isSelectionEnabled(); } catch(e) {}
      try {
        var all = api.getAllShapes();
        for (var i = 0; i < all.length; i++) { if (all[i].id === eid) { props.name = all[i].name; break; } }
      } catch(e) {}
      return props;
    })()
  `);
  if (result?.error) throw new ClassifiedError(CATEGORIES.TV_UI_CHANGED, result.error);
  return { success: true, ...result };
}

export async function removeOne({ entity_id, _deps } = {}) {
  const { evaluate, getChartApi } = _resolve(_deps);
  const apiPath = await getChartApi();
  const result = await evaluate(`
    (function() {
      var api = ${apiPath};
      var eid = ${safeString(entity_id)};
      var before = api.getAllShapes();
      var found = false;
      for (var i = 0; i < before.length; i++) { if (before[i].id === eid) { found = true; break; } }
      if (!found) return { removed: false, error: 'Shape not found: ' + eid, available: before.map(function(s) { return s.id; }) };
      api.removeEntity(eid);
      var after = api.getAllShapes();
      var stillExists = false;
      for (var j = 0; j < after.length; j++) { if (after[j].id === eid) { stillExists = true; break; } }
      return { removed: !stillExists, entity_id: eid, remaining_shapes: after.length };
    })()
  `);
  if (result?.error) throw new ClassifiedError(CATEGORIES.TV_UI_CHANGED, result.error);
  return { success: true, entity_id: result?.entity_id, removed: result?.removed, remaining_shapes: result?.remaining_shapes };
}

export async function clearAll({ _deps } = {}) {
  const { evaluate, getChartApi } = _resolve(_deps);
  const apiPath = await getChartApi();

  // THE MOST DESTRUCTIVE TOOL IN THE SET RETURNED A HARDCODED SUCCESS.
  // It called removeAllShapes() and returned { success: true } without ever
  // looking. If the call threw inside the page, or the API path resolved to a
  // detached widget, or nothing was there to begin with, the answer was
  // identical: "all_shapes_removed". For an irreversible operation on a
  // trader's annotations that is the worst possible place to guess.
  //
  // Count before, count after, and report what actually happened.
  const before = await evaluate(`
    (function() {
      try { return ${apiPath}.getAllShapes().length; } catch (e) { return -1; }
    })()
  `);
  if (before === -1) {
    throw new ClassifiedError(
      CATEGORIES.TV_UI_CHANGED,
      'Could not count the drawings on the chart, so nothing was removed rather than deleting blind',
      { hint: 'Run tv_health_check and confirm the chart has finished loading.' },
    );
  }
  if (before === 0) {
    return { success: true, action: 'nothing_to_remove', removed_count: 0, remaining: 0 };
  }

  await evaluate(`${apiPath}.removeAllShapes()`);

  const after = await evaluate(`
    (function() {
      try { return ${apiPath}.getAllShapes().length; } catch (e) { return -1; }
    })()
  `);
  if (after === -1) {
    throw new ClassifiedError(
      CATEGORIES.TV_UI_CHANGED,
      `removeAllShapes() was called on ${before} drawing(s) but the result could not be read back, so the outcome is unconfirmed`,
      { hint: 'Call draw_list to see the true current state.' },
    );
  }
  if (after > 0) {
    throw new ClassifiedError(
      CATEGORIES.API_UNEXPECTED,
      `removeAllShapes() was accepted but ${after} of ${before} drawing(s) are still on the chart`,
      { hint: 'Retry once, or remove the remainder individually with draw_remove_one.' },
    );
  }
  return { success: true, action: 'all_shapes_removed', removed_count: before, remaining: 0, verified: true };
}
