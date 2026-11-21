// Byrd-IT fork: CCTV voice replies must never repeat caller-supplied text.
// A camera query or an unknown action can carry anything the model was told
// (including pasted credentials), so both replies use fixed wording.
import { after, before, test } from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import { controlCctv, createGevActionRunner } from './gevActions.js';

const originalWindow = globalThis.window;
before(() => {
  globalThis.window ??= { clearTimeout, setTimeout, requestIdleCallback: null };
});
after(() => {
  if (originalWindow === undefined) delete globalThis.window;
  else globalThis.window = originalWindow;
});

function hostileInputs() {
  const nonce = crypto.randomUUID().replace(/-/g, '');
  const token = `tok_${nonce}SUFX42`;
  return [
    `Bearer ${token}`,
    `https://user:${nonce}@cams.example.invalid/feed`,
    `https://cams.example.invalid/feed?api_key=${nonce}`,
    `X-Api-Key: ${nonce}`,
    token,
  ];
}

// Every encoding a reply could carry the caller's text in.
function forms(value) {
  const secret = value.match(/[0-9a-f]{32}/)?.[0] || value;
  return [
    value,
    secret,
    secret.slice(0, 8),
    secret.slice(-6),
    value.slice(-6),
    encodeURIComponent(value),
    Buffer.from(value).toString('base64'),
    Buffer.from(secret).toString('base64'),
  ];
}

function assertNoEcho(output, value) {
  const text = typeof output === 'string' ? output : JSON.stringify(output);
  for (const form of forms(value)) {
    assert.equal(text.includes(form), false, 'reply repeats caller text');
  }
}

function managerWith(cameras) {
  const module = {
    getUIState: () => ({
      cameras,
      activeCamera: null,
      activeCameraId: null,
      count: cameras.length,
    }),
    selectCamera: () => assert.fail('no camera should be selected'),
    focusCamera: () => assert.fail('no camera should be focused'),
  };
  return {
    layers: new Map([['cctv', { module }]]),
    isEnabled: () => true,
    getAll: () => [],
    setLayerParams: () => assert.fail('no layer params should change'),
  };
}

function viewerFixture() {
  return {
    clock: { onTick: { addEventListener: () => () => {} } },
    canvas: { addEventListener() {}, removeEventListener() {} },
    scene: { canvas: { addEventListener() {}, removeEventListener() {} } },
    camera: { moveEnd: { addEventListener() {} } },
  };
}

test('CCTV select with no match does not echo the camera query', async () => {
  for (const query of hostileInputs()) {
    const result = await controlCctv(
      managerWith([{ id: 'cam-1', name: 'Main St' }]),
      {
        action: 'select',
        cameraQuery: query,
      },
    );
    assert.equal(result.ok, false);
    assert.equal(result.action, 'control_cctv');
    assert.equal(result.error, 'No camera matched that query');
    assertNoEcho(result, query);
  }
});

test('CCTV unknown action throws a fixed message without the action text', async () => {
  for (const action of [...hostileInputs(), 'rewind']) {
    await assert.rejects(
      () => controlCctv(managerWith([]), { action }),
      (error) => {
        assert.equal(error.message, 'Unknown CCTV action');
        assertNoEcho(String(error.stack), action);
        assertNoEcho(error.message, action);
        return true;
      },
    );
  }
  await assert.rejects(
    () => controlCctv(managerWith([]), {}),
    (error) => error.message === 'Unknown CCTV action',
  );
});

test('the voice runner reply for both paths carries no caller text', async (t) => {
  const runner = createGevActionRunner({
    viewer: viewerFixture(),
    styleManager: {},
    dataManager: managerWith([{ id: 'cam-1', name: 'Main St' }]),
  });
  t.after(() => runner.dispose());
  for (const value of hostileInputs()) {
    let reply;
    try {
      reply = await runner('control_cctv', {
        action: 'select',
        cameraQuery: value,
      });
    } catch (error) {
      reply = { thrown: String(error?.message), stack: String(error?.stack) };
    }
    assertNoEcho(reply, value);
    try {
      reply = await runner('control_cctv', { action: value });
    } catch (error) {
      reply = { thrown: String(error?.message), stack: String(error?.stack) };
    }
    assertNoEcho(reply, value);
  }
});
