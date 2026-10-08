const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const web = path.join(__dirname, '../web');
const uri = text => 'data:text/javascript;base64,' + Buffer.from(text).toString('base64');
(async () => {
  const core = uri(fs.readFileSync(path.join(web, 'vendor/spark/three.core.js'), 'utf8'));
  const THREE = await import(core);
  const { calculateModelView, nativeCameraPose } = await import(uri(fs.readFileSync(path.join(web, 'model-view.js'), 'utf8').replace("'./vendor/spark/three.core.js'", JSON.stringify(core))));
  const fixture = rotation => {
    const points = [];
    for (let x = -3; x <= 3; x += .2) for (let y = -1; y <= 1; y += .2) {
      points.push(new THREE.Vector3(x, y, .02 * Math.sin(x)).applyAxisAngle(new THREE.Vector3(0, 1, 0), rotation));
    }
    const bounds = new THREE.Box3().setFromPoints(points);
    const halfExtents = bounds.getSize(new THREE.Vector3()).multiplyScalar(.55);
    return { resource: { gsplatData: { getProp: name => points.map(p=>p[name]) } },
      box: { center: bounds.getCenter(new THREE.Vector3()), halfExtents } };
  };
  const a = fixture(0), b = fixture(Math.PI / 2);
  const view = (model, options) => calculateModelView(model.resource, model.box, options);
  const first = view(a), second = view(b);
  const direction = v => new THREE.Vector3(...v.position).sub(new THREE.Vector3(...v.target)).normalize();
  assert.ok(Math.abs(direction(first).dot(direction(second))) < .05, 'rotating a planar model changes initial viewing direction');
  for (const aspect of [2.4, 1, .4]) {
    const v = view(b, { aspect });
    const camera = new THREE.PerspectiveCamera(v.fov, aspect, .001, 1000);
    camera.position.fromArray(v.position); camera.up.fromArray(v.up); camera.lookAt(new THREE.Vector3(...v.target)); camera.updateMatrixWorld();
    const h = b.box.halfExtents;
    for (const x of [-h.x, h.x]) for (const y of [-h.y, h.y]) for (const z of [-h.z, h.z]) {
      const p = new THREE.Vector3(x, y, z).project(camera);
      assert.ok(Math.abs(p.x) < 1 && Math.abs(p.y) < 1 && p.z < 1 && p.z > -1, `all bounding corners fit at aspect=${aspect}`);
    }
  }
  const sourceView = { coordinateSpace: 'colmap', position: [4, 2, -6], forward: [-.4, -.2, 1], up: [0, -1, -.2], fov: 42 };
  const camera = view(a, { sourceView });
  assert.equal(camera.source, 'camera'); assert.deepEqual(camera.position, [-4, -2, -6]); assert.equal(camera.fov, 42);
  assert.ok(direction(camera).dot(new THREE.Vector3(.4, .2, 1).normalize()) < -.999, 'COLMAP forward and display transform agree');
  assert.equal(view(a, { sourceView: { ...sourceView, forward: [0, 0, 0] } }).source, 'geometry');
  assert.equal(view(a, { sourceView: { ...sourceView, up: [NaN, 1, 0] } }).source, 'geometry');
  // Exercise the pinned engine's actual quaternion-to-Euler implementation.
  const engine = fs.readFileSync(path.join(web, 'vendor/supersplat/host-viewer.js'), 'utf8');
  const start = engine.indexOf('class Quat {'), end = engine.indexOf('\n}', start) + 2;
  class Vec3 extends THREE.Vector3 { mulScalar(s) { return this.multiplyScalar(s); } }
  const Quat = vm.runInNewContext(engine.slice(start,end) + '\nQuat;', { Vec3, math: { RAD_TO_DEG: 180/Math.PI, DEG_TO_RAD: Math.PI/180 } });
  for (const v of [first, second, camera, { ...camera, up: [1, .1, 0] }]) {
    const snapshot = nativeCameraPose(v, new Quat(), 2);
    const expected = new THREE.PerspectiveCamera(v.fov);
    expected.position.fromArray(v.position); expected.up.fromArray(v.up); expected.lookAt(new THREE.Vector3(...v.target));
    const actual = new Quat().setFromEulerAngles(...snapshot.angles);
    assert.ok(Math.abs(new THREE.Quaternion(actual.x,actual.y,actual.z,actual.w).dot(expected.quaternion)) > .99999,
      'native initial pose preserves the shooting orientation and camera roll');
    assert.ok(snapshot.distance > 0 && snapshot.fov > v.fov);
  }
  const store = new Map([['splat.viewPlaneUp', '[1,0,0]']]);
  global.localStorage = { getItem: k => store.get(k) || null, setItem: (k,v) => store.set(k,v) };
  const { ViewPreferences } = await import(uri(fs.readFileSync(path.join(web, 'view-preferences.js'), 'utf8')));
  const prefsA = new ViewPreferences('job:A'), prefsB = new ViewPreferences('job:B');
  assert.deepEqual(prefsA.read(), {}, 'unidentified global horizon is never inherited');
  prefsA.set({ up: [0, 0, 1], pose: { position: [1, 2, 3] } });
  assert.deepEqual(prefsB.read(), {}, 'plane and pose cannot leak to another model');
  assert.deepEqual(new ViewPreferences('job:A').read().up, [0, 0, 1]);
  assert.ok(store.has('splat.viewPlaneUp'), 'obsolete global data is preserved without being applied');
  const controlsSource = fs.readFileSync(path.join(web, 'legacy-view-controls.js'), 'utf8').replace(/^import .*;$/gm, '').replace('export class LegacyViewControls', 'class LegacyViewControls');
  const Controls = vm.runInNewContext(controlsSource + '\nLegacyViewControls;', { THREE, vectorValid: a => Array.isArray(a) && a.length === 3 && a.every(Number.isFinite) });
  const controls = Object.create(Controls.prototype);
  Object.assign(controls, { preview: { modelView: camera, preferences: prefsB }, camera: new THREE.PerspectiveCamera(30),
    center: new THREE.Vector3(), radius: 2, up: new THREE.Vector3(0,1,0), homeDirection: new THREE.Vector3(), sync() {} });
  controls.controls = { target: new THREE.Vector3(), _quat: new THREE.Quaternion(), _quatInverse: new THREE.Quaternion(),
    _sphericalDelta: new THREE.Spherical(), _panOffset: new THREE.Vector3(), update() {} };
  controls.preset(0);
  assert.deepEqual(controls.camera.position.toArray(), camera.position);
  assert.deepEqual(controls.controls.target.toArray(), camera.target);
  assert.equal(controls.camera.fov, 42);
  const modelUp = controls.up.clone();
  controls.up.set(1,0,0); prefsB.set({ up: [1,0,0] });
  controls.status = () => {}; controls.app = {}; controls.action('resetPlane');
  assert.ok(controls.up.distanceTo(modelUp) < 1e-8, 'resetting the plane returns to this model shooting horizon');
  console.log('Model view: rotated geometry, portrait/landscape fit, camera conversion, invalid metadata and model isolation passed');
})().catch(error => { console.error(error); process.exitCode = 1; });
