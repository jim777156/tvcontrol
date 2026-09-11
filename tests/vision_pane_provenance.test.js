import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { chartVisionRead } from '../src/core/vision.js';

const PNG_BYTES = Buffer.from('89504e470d0a1a0a00000000', 'hex');

function fixturePath() {
  const dir = mkdtempSync(join(tmpdir(), 'tv-vision-pane-'));
  const path = join(dir, 'pane.png');
  writeFileSync(path, PNG_BYTES);
  return path;
}

test('chartVisionRead propagates pane provenance from chart capture', async () => {
  const filePath = fixturePath();
  const result = await chartVisionRead({
    include: ['image'],
    _deps: {
      captureScreenshot: async () => ({
        success: true,
        method: 'cdp',
        file_path: filePath,
        pane_selected_by: 'active_pane',
        pane_count: 4,
      }),
      getState: async () => ({}),
      getQuote: async () => ({}),
      getStudyValues: async () => ({}),
      getPineLines: async () => ({}),
      getPineLabels: async () => ({}),
      getPineTables: async () => ({}),
      getPineBoxes: async () => ({}),
      getOhlcv: async () => ({}),
    },
  });

  assert.equal(result.success, true);
  assert.equal(result.image_mode, 'inline');
  assert.equal(result.pane_selected_by, 'active_pane');
  assert.equal(result.pane_count, 4);
});

test('chartVisionRead does not invent pane provenance when image capture omits it', async () => {
  const filePath = fixturePath();
  const result = await chartVisionRead({
    include: ['image'],
    _deps: {
      captureScreenshot: async () => ({
        success: true,
        method: 'cdp',
        file_path: filePath,
      }),
      getState: async () => ({}),
      getQuote: async () => ({}),
      getStudyValues: async () => ({}),
      getPineLines: async () => ({}),
      getPineLabels: async () => ({}),
      getPineTables: async () => ({}),
      getPineBoxes: async () => ({}),
      getOhlcv: async () => ({}),
    },
  });

  assert.equal(result.success, true);
  assert.equal(result.image_mode, 'inline');
  assert.equal('pane_selected_by' in result, false);
  assert.equal('pane_count' in result, false);
});
