/**
 * Isolated reference-image validation + store.
 * No live Dola, no browser, no real accounts.
 */
import assert from 'node:assert/strict';
import test from 'node:test';
import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  validateReferenceImages, IMAGE_MAX_COUNT, IMAGE_MAX_TOTAL_BYTES,
} from '../server/dola/reference-images.js';
import {
  saveReferenceImages, listReferenceImages, cleanupReferenceImages,
} from '../server/dola/reference-image-store.js';

const FIXTURE = path.join(path.dirname(fileURLToPath(import.meta.url)), 'fixtures', 'ref-1x1.png');

test('validateReferenceImages accepts a small PNG under the shared limits', async () => {
  const buf = await fs.readFile(FIXTURE);
  const inspected = await validateReferenceImages([
    { name: 'ref.png', dataBase64: buf.toString('base64') },
  ], { prompt: 'synthetic' });
  assert.equal(inspected.length, 1);
  assert.equal(inspected[0].mime, 'image/png');
  assert.equal(inspected[0].width, 1);
  assert.equal(inspected[0].height, 1);
});

test('validateReferenceImages rejects over-count before charge', async () => {
  const buf = await fs.readFile(FIXTURE);
  const tooMany = Array.from({ length: IMAGE_MAX_COUNT + 1 }, (_, i) => ({
    name: `ref-${i}.png`, dataBase64: buf.toString('base64'),
  }));
  await assert.rejects(() => validateReferenceImages(tooMany, { prompt: 'x' }), (error) => {
    assert.equal(error.code, 'REFERENCE_IMAGE_LIMIT');
    assert.equal(error.status, 400);
    return true;
  });
});

test('validateReferenceImages rejects non-image bytes before charge', async () => {
  const huge = Buffer.alloc(Math.min(IMAGE_MAX_TOTAL_BYTES, 64 * 1024), 0xff);
  await assert.rejects(() => validateReferenceImages([
    { name: 'big.bin', dataBase64: huge.toString('base64') },
  ], { prompt: 'x' }), (error) => {
    assert.equal(error.code, 'REFERENCE_IMAGE_INVALID');
    assert.equal(error.status, 400);
    return true;
  });
});

test('reference-image store is path-traversal safe and cleans up by task id', async () => {
  const buf = await fs.readFile(FIXTURE);
  const inspected = await validateReferenceImages([
    { name: 'ok.png', dataBase64: buf.toString('base64') },
  ]);
  const taskId = 424242;
  await cleanupReferenceImages(taskId);
  const saved = await saveReferenceImages(taskId, inspected);
  assert.equal(saved.length, 1);
  assert.match(saved[0], new RegExp(`[\\\\/]${taskId}[\\\\/]`));
  const listed = await listReferenceImages(taskId);
  assert.equal(listed.length, 1);
  await assert.rejects(
    () => saveReferenceImages('../escape', inspected),
    (error) => error.code === 'REFERENCE_STORE_PATH' || /invalid reference-image task id/.test(error.message),
  );
  await cleanupReferenceImages(taskId);
  assert.deepEqual(await listReferenceImages(taskId), []);
});
