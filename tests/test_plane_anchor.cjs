// Verify world-space plane geometry independently of camera targets/projection.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const web = path.join(__dirname, '../web');
(async () => {
  const THREE = await import('data:text/javascript;base64,' +
    fs.readFileSync(path.join(web, 'vendor/spark/three.core.js')).toString('base64'));
  const source = fs.readFileSync(path.join(web, 'legacy-view-controls.js'), 'utf8')
    .replace(/^import .*;$/gm, '').replace('export class LegacyViewControls', 'class LegacyViewControls');
  const Controls = vm.runInNewContext(source + '\nLegacyViewControls;', { THREE });
  const controls = Object.create(Controls.prototype);
  controls.center = new THREE.Vector3(4, -3, 8);
  controls.planeOrigin = controls.center.clone();
  controls.up = new THREE.Vector3(.2, 1, -.1).normalize();
  controls.radius = 2;
  controls.controls = { target: controls.center.clone() };
  controls.pcStart = new THREE.Vector3(); controls.pcEnd = new THREE.Vector3();
  let lines;
  controls.app = { drawLine(a, b) { lines.push([a.clone(), b.clone()]); } };
  const geometry = () => { lines = []; controls.grid(); return lines; };
  const values = () => geometry().flat().flatMap(v => v.toArray());
  const initial = values();
  for (const offset of [[3, 0, 0], [-6, 4, 2], [0, -8, 0]]) {
    controls.controls.target.add(new THREE.Vector3(...offset));
    assert.deepEqual(values(), initial, 'pan and pivot changes must not move the plane');
  }
  for (const point of geometry().flat()) {
    assert.ok(Math.abs(point.clone().sub(controls.planeOrigin).dot(controls.up)) < 1e-10);
  }
  const originalOrigin = controls.planeOrigin.clone();
  controls.up.applyAxisAngle(new THREE.Vector3(0, 0, 1), .1);
  assert.notDeepEqual(values(), initial, 'explicit leveling still changes the plane orientation');
  assert.ok(controls.planeOrigin.equals(originalOrigin), 'leveling keeps the origin fixed');
  console.log('Plane anchor: pan, height, pivot and leveling passed');
})().catch(error => { console.error(error.message); process.exitCode = 1; });
