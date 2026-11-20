import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

/**
 * scripts/publish_odm_3d.py: concurrent publishers.
 *
 * The id is unique per build, but two runs can still reach the same final
 * folder: the "does it exist?" check in main() is a race, and another writer
 * can put <final> in place between that check and the move. These tests pin
 * the two safety properties the rollback and placement must keep:
 *
 *   - a run removes only the folders it placed itself; another publisher's
 *     folder is never deleted by our failure path;
 *   - placement never nests the staging folder inside an existing folder and
 *     fails closed (no manifest entry) when the name was taken.
 *
 * No ssh and no network: every command runs locally through the same bash
 * seam the other publish tests use, and the race is injected deterministically
 * at the move command.
 */

const script = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  '../../../scripts/publish_odm_3d.py',
);
const scriptDir = path.dirname(script);

const TRANSFORM = [
  0.9959588334139836, -0.08981092441711609, 0, 0, 0.04850704705607071,
  0.5379192154168977, 0.8415996578368894, 0, -0.07558484325945963,
  -0.8381986134208361, 0.540101856994429, 0, -482561.89339109743,
  -5351373.271248124, 3425128.505589803, 1,
];

/** A Z-up splat tileset; ground 112 m sits inside its heights. */
const splatTileset = (extra = {}) => ({
  asset: { version: '1.0', gltfUpAxis: 'Z' },
  geometricError: 0,
  root: {
    transform: TRANSFORM,
    boundingVolume: {
      box: [0, 0, 112, 80, 0, 0, 0, 80, 0, 0, 0, 40],
    },
    refine: 'REPLACE',
    ...extra,
  },
});

function writeSplat(dir, tileset = splatTileset()) {
  mkdirSync(dir, { recursive: true });
  writeFileSync(path.join(dir, 'tileset.json'), JSON.stringify(tileset, null, 1));
}

const tmp = () => mkdtempSync(path.join(tmpdir(), 'gev-publish-race-'));

function runProgram(program, ...args) {
  const r = spawnSync('python3', ['-c', program, ...args], {
    encoding: 'utf8',
    timeout: 30_000,
  });
  assert.equal(r.status, 0, r.stderr);
  return JSON.parse(r.stdout.trim().split('\n').at(-1));
}

/** The shared harness: a local S1 store, a local run(), and a copytree stream. */
const harness = `
import json, os, shutil, subprocess, sys, tempfile
sys.path.insert(0, ${JSON.stringify(scriptDir)})
import publish_odm_3d as p

main, phone = sys.argv[1], sys.argv[2]
work = tempfile.mkdtemp()
store = os.path.join(work, "hires")
os.makedirs(os.path.join(store, "m2"))
os.makedirs(os.path.join(store, "odm3d"))
p.STORE = store
p.MANIFEST = os.path.join(store, "m2", "overlays.json")
json.dump({"layers": [], "note": ""}, open(p.MANIFEST, "w"))
base = os.path.join(store, "odm3d")

def local_run(cmd, check=True, input=None, **kw):
    if cmd[0] == "curl":
        name = cmd[-1].split("/")[-2]
        served = os.path.join(base, name, "tileset.json")
        if not os.path.exists(served):
            return subprocess.CompletedProcess(cmd, 1, stdout="", stderr="")
        return subprocess.CompletedProcess(cmd, 0, stdout=open(served).read(), stderr="")
    r = subprocess.run(["bash", "-c", cmd[-1]], input=input, text=True, capture_output=True)
    if check and r.returncode != 0:
        raise p.Fail("failed")
    return r

p.run = local_run
p.stream = lambda host, model, stage: shutil.copytree(model, stage)

def snapshot():
    layers = [l.get("id") for l in json.load(open(p.MANIFEST))["layers"]]
    return {
        "layers": layers,
        "staging": sorted(n for n in os.listdir(base) if n.startswith(".staging-")),
        "entries": sorted(os.listdir(base)),
    }
`;

/** Wrap a run() so one move is preceded by another publisher taking the name. */
const raceOnMove = (targetExpr) => `
other = ${targetExpr}
_base_run = local_run
state = {"injected": False}
def local_run(cmd, check=True, input=None, **kw):
    text = cmd[-1]
    if (
        cmd[0] != "curl"
        and text.startswith("mv ")
        and other in text
        and not state["injected"]
    ):
        state["injected"] = True
        os.makedirs(other)
        open(os.path.join(other, "other-publisher.txt"), "w").write("keep me")
    return _base_run(cmd, check=check, input=input, **kw)
p.run = local_run
`;

test('race: a failed phone publish never deletes a phone folder this run did not place', () => {
  const main = tmp();
  const phone = tmp();
  try {
    writeSplat(main);
    writeSplat(phone);
    const out = runProgram(
      harness +
        `
real_publish = p.publish_folder
def racing_publish(host, model, final, stage, count, tileset, fixed_text=None):
    if final.endswith("-phone"):
        # Another publisher won the phone name after main()'s existence check,
        # and our phone publish failed before placing anything.
        os.makedirs(final)
        open(os.path.join(final, "other-publisher.txt"), "w").write("keep me")
        raise p.Fail("phone publish failed before placing")
    return real_publish(host, model, final, stage, count, tileset, fixed_text)
p.publish_folder = racing_publish

rc = p.main(["--splat", main, "--phone-splat", phone, "--ground-m", "112",
             "--id", "odm-3d-race001", "--name", "Race"])
snap = snapshot()
phone_final = os.path.join(base, "odm-3d-race001-phone")
print(json.dumps({
    "rc": rc,
    **snap,
    "main_exists": os.path.exists(os.path.join(base, "odm-3d-race001")),
    "their_phone_marker": os.path.exists(os.path.join(phone_final, "other-publisher.txt")),
    "phone_entries": sorted(os.listdir(phone_final)) if os.path.isdir(phone_final) else None,
}))
`,
      main,
      phone,
    );
    assert.equal(out.rc, 2);
    assert.deepEqual(out.layers, [], 'the manifest was never touched');
    assert.equal(out.main_exists, false, 'the folder this run placed is taken back');
    assert.equal(
      out.their_phone_marker,
      true,
      'another publisher\'s phone folder is not ours to delete',
    );
    assert.deepEqual(out.phone_entries, ['other-publisher.txt']);
    assert.deepEqual(out.staging, []);
  } finally {
    rmSync(main, { recursive: true, force: true });
    rmSync(phone, { recursive: true, force: true });
  }
});

test('race: a folder that appears before the move is neither nested into nor published', () => {
  const main = tmp();
  const phone = tmp();
  try {
    writeSplat(main);
    const out = runProgram(
      harness +
        raceOnMove('os.path.join(base, "odm-3d-race002")') +
        `
rc = p.main(["--splat", main, "--ground-m", "112",
             "--id", "odm-3d-race002", "--name", "Race"])
final = os.path.join(base, "odm-3d-race002")
snap = snapshot()
print(json.dumps({
    "rc": rc,
    **snap,
    "their_marker": os.path.exists(os.path.join(final, "other-publisher.txt")),
    "final_entries": sorted(os.listdir(final)) if os.path.isdir(final) else None,
    "published_by_us": os.path.exists(os.path.join(final, "tileset.json")),
}))
`,
      main,
      phone,
    );
    assert.equal(out.rc, 2, 'the run fails closed instead of claiming the name');
    assert.deepEqual(out.layers, [], 'a lost race adds no manifest entry');
    assert.equal(out.their_marker, true, 'the other publisher\'s folder is untouched');
    assert.deepEqual(
      out.final_entries,
      ['other-publisher.txt'],
      'staging must not be moved inside the existing folder',
    );
    assert.equal(out.published_by_us, false);
    assert.deepEqual(out.staging, [], 'our staging is cleaned up');
  } finally {
    rmSync(main, { recursive: true, force: true });
    rmSync(phone, { recursive: true, force: true });
  }
});

test('race: losing the phone name rolls main back and leaves the phone folder intact', () => {
  const main = tmp();
  const phone = tmp();
  try {
    writeSplat(main);
    writeSplat(phone);
    const out = runProgram(
      harness +
        raceOnMove('os.path.join(base, "odm-3d-race003-phone")') +
        `
rc = p.main(["--splat", main, "--phone-splat", phone, "--ground-m", "112",
             "--id", "odm-3d-race003", "--name", "Race"])
final = os.path.join(base, "odm-3d-race003")
phone_final = final + "-phone"
snap = snapshot()
print(json.dumps({
    "rc": rc,
    **snap,
    "main_exists": os.path.exists(final),
    "their_phone_marker": os.path.exists(os.path.join(phone_final, "other-publisher.txt")),
    "phone_entries": sorted(os.listdir(phone_final)) if os.path.isdir(phone_final) else None,
}))
`,
      main,
      phone,
    );
    assert.equal(out.rc, 2);
    assert.deepEqual(out.layers, [], 'the manifest was never touched');
    assert.equal(out.main_exists, false, 'main is rolled back');
    assert.equal(out.their_phone_marker, true);
    assert.deepEqual(
      out.phone_entries,
      ['other-publisher.txt'],
      'no nested staging folder in the other publisher\'s phone folder',
    );
    assert.deepEqual(out.staging, []);
  } finally {
    rmSync(main, { recursive: true, force: true });
    rmSync(phone, { recursive: true, force: true });
  }
});
