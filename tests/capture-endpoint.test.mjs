/**
 * Capture endpoint image handling.
 *
 * Real captures failed with "not a jpg/png/webp" because AliExpress and Temu
 * content-negotiate on Accept: Chrome asks for AVIF and gets it. Plain curl
 * asks for neither and gets WebP, which is why manual testing missed it.
 */
import { test, describe, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { readFileSync, existsSync, unlinkSync } from 'node:fs';
import { join } from 'node:path';

const PORT = 4321;
const IMAGES = join('admin-offline', 'images');
let server;

const post = (body) => fetch(`http://127.0.0.1:${PORT}/api/capture`, {
  method: 'POST',
  headers: { 'content-type': 'application/json', Origin: 'chrome-extension://test' },
  body: JSON.stringify(body),
}).then((r) => r.json());

const cleanup = (...names) => {
  for (const n of names) {
    const p = join(IMAGES, n);
    if (existsSync(p)) unlinkSync(p);
  }
};

describe('capture endpoint', () => {
  before(async () => {
    server = spawn('node', ['scripts/admin-server.mjs'], { stdio: 'ignore' });
    // Wait for it to bind rather than sleeping a fixed time.
    for (let i = 0; i < 40; i++) {
      try {
        await fetch(`http://127.0.0.1:${PORT}/api/pricing`);
        return;
      } catch { await new Promise((r) => setTimeout(r, 100)); }
    }
    throw new Error('admin server did not start');
  });

  after(() => server?.kill());

  test('rejects a non-image with a stated reason', async () => {
    const out = await post({
      product: { title: 'T' },
      images: [{ name: 'x.gif', dataUrl: 'data:image/gif;base64,R0lGOD' }],
    });
    assert.equal(out.savedImages, 0);
    assert.match(out.rejected[0], /not a jpg\/png\/webp\/avif/);
  });

  test('reports an empty payload rather than saving a 0-byte file', async () => {
    const out = await post({
      product: { title: 'T' },
      images: [{ name: 'empty.jpg', dataUrl: 'data:image/jpeg;base64,' }],
    });
    assert.equal(out.savedImages, 0);
    assert.match(out.rejected[0], /0 bytes/);
  });

  test('rejects a traversal filename', async () => {
    const out = await post({
      product: { title: 'T' },
      images: [{ name: '../../escape.jpg', dataUrl: 'data:image/jpeg;base64,AAAA' }],
    });
    // safeName strips the path, so it is judged on the basename alone.
    assert.ok(!existsSync('escape.jpg'), 'must never write outside the images dir');
  });

  test('accepts AVIF and converts it to webp', async () => {
    // A minimal real AVIF, produced by sharp so the test carries no binary.
    const sharp = (await import('sharp')).default;
    const avif = await sharp({
      create: { width: 16, height: 16, channels: 3, background: '#123456' },
    }).avif().toBuffer();

    const out = await post({
      product: { title: 'AVIF test' },
      images: [{
        name: 'avif-test-1.avif',
        dataUrl: `data:image/avif;base64,${avif.toString('base64')}`,
      }],
    });

    assert.equal(out.savedImages, 1, JSON.stringify(out.rejected));
    assert.equal(out.rejected.length, 0);
    // Saved under a .webp name, since the build pipeline expects that.
    assert.ok(existsSync(join(IMAGES, 'avif-test-1.webp')), 'should be converted to webp');
    cleanup('avif-test-1.webp', 'avif-test-1.avif');
  });
});
