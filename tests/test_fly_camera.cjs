const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const vendor = path.join(__dirname, '../web/vendor/supersplat');

// Execute the pinned engine's real math, controller, spawn and movement code.
// No renderer or substitute quaternion implementation is needed for this bug.
function load(runtime, oldAdapter = false) {
  const source = fs.readFileSync(path.join(vendor, runtime), 'utf8');
  const block = name => {
    const start = source.indexOf(`class ${name} {`);
    assert.ok(start >= 0, name);
    return source.slice(start, source.indexOf('\n}', start) + 2);
  };
  let fly = block('FlyController');
  if (oldAdapter) {
    fly = fly.replace('camera.angles.set(this._angles.x, this._angles.y, 0);', 'camera.angles.copy(this._angles);')
      .replace('this._angles.set(camera.angles.x, camera.angles.y, 0);', 'this._angles.copy(camera.angles);\n        this.fov = camera.fov;')
      .replace('applyFrameRotation(this._targetAngles, rotate);', 'const roll = this._targetAngles.z;\n        applyFrameRotation(this._targetAngles, rotate);\n        this._targetAngles.z = roll;');
  }
  const mathStart = source.indexOf('const math = {');
  const dampStart = source.indexOf('const DEFAULT_CONTROLLER_DAMPING =');
  const dampEnd = source.indexOf('\n};', source.indexOf('const dampAngles =', dampStart)) + 3;
  const flyStart = source.indexOf('const CAMERA_RADIUS =');
  const setup = [
    source.slice(mathStart, source.indexOf('\n};', mathStart) + 3),
    block('Vec3'), block('Quat'),
    'const mod = (n, m) => ((n % m) + m) % m;',
    source.slice(source.indexOf('const damp ='), source.indexOf(';', source.indexOf('const damp =')) + 1),
    source.slice(dampStart, dampEnd),
    block('SpawnState'), block('SphereMover'),
    source.slice(flyStart, source.indexOf('class FlyController {', flyStart)), fly,
    source.slice(source.indexOf('const RAD_TO_DEG', flyStart), source.indexOf('class FlySource {', flyStart)),
    block('FlySource'),
    '({ Vec3, Quat, FlyController, FlySource });'
  ].join('\n');
  return vm.runInNewContext(setup);
}

const engine = load('host-viewer.js');
const { Vec3, Quat, FlyController } = engine;
const basis = (angles, E = engine) => {
  const q = new E.Quat().setFromEulerAngles(angles);
  return { q, forward: q.transformVector(E.Vec3.FORWARD),
    right: q.transformVector(E.Vec3.RIGHT), up: q.transformVector(E.Vec3.UP) };
};
function fixture(angles, E = engine) {
  const camera = { angles: new E.Vec3(...angles), position: new E.Vec3(2, 3, 4), distance: 7, fov: 51 };
  const fly = new E.FlyController();
  fly.onEnter(camera); fly.rotateDamping = 0;
  return { camera, fly };
}
const step = (f, rotate = [0,0,0], move = [0,0,0], dt = 1/60) =>
  f.fly.update(dt, { read: () => ({ rotate, move }) }, f.camera);
const sameRotation = (a, b, message) => assert.ok(Math.abs(a.dot(b)) > 1 - 1e-8, message);

// Demonstrate the reported bug against the exact previous host adaptation.
const old = load('index.js', true), oldCase = fixture([75, 0, 90], old);
const oldBasis = basis(oldCase.camera.angles, old);
step(oldCase, [30,0,0]);
assert.ok(Math.abs(basis(oldCase.camera.angles, old).right.dot(oldBasis.up)) > .4,
  'previous mouse yaw rolls the screen with a steeply tilted camera');

let cases = 0;
for (const roll of [0, 30, 90, 135, -90]) {
  for (const pitch of [0, 35, 75]) {
    for (const yaw of [0, 70, 140]) {
      for (const delta of [-30, 30]) {
        const f = fixture([pitch, yaw, roll]);
        const entered = basis(f.camera.angles);
        step(f);
        sameRotation(basis(f.camera.angles).q, entered.q, 'idle entry preserves shooting orientation');
        step(f, [delta,0,0]);
        const actual = basis(f.camera.angles);
        const expected = new Quat().setFromAxisAngle(entered.up, -delta).mul(entered.q);
        sameRotation(actual.q, expected, 'mouse yaw turns about entered camera up');
        assert.ok(actual.up.distance(entered.up) < 1e-6, 'mouse yaw never adds screen roll');
        assert.ok(Math.abs(actual.forward.dot(entered.up)) < 1e-6, 'horizontal motion stays horizontal');
        assert.ok(actual.forward.dot(entered.right) * delta > 0, 'both turn directions match mouse input');
        assert.equal(f.camera.fov, 51, 'FOV preserved');
        assert.equal(f.camera.distance, 7, 'focus distance preserved');
        cases++;
      }
    }
  }
}

const f = fixture([32, 113, 74]), entered = basis(f.camera.angles);
step(f, [0,20,0]);
sameRotation(basis(f.camera.angles).q,
  new Quat().setFromAxisAngle(entered.right, -20).mul(entered.q), 'vertical drag pitches around camera right');
step(f, [35,-10,0]);
assert.ok(Math.abs(basis(f.camera.angles).right.dot(entered.up)) < 1e-6,
  'mixed yaw/pitch retains reference horizon');
const right = basis(f.camera.angles).right, before = f.camera.position.clone();
const orientation = basis(f.camera.angles).q;
step(f, [0,0,0], [2,0,0]);
assert.ok(f.camera.position.distance(before.add(right.mulScalar(2))) < 1e-6, 'pan moves along visible screen right');
sameRotation(basis(f.camera.angles).q, orientation, 'pan never rotates the camera');
step(f, [0,1000,0]);
assert.equal(f.fly._targetAngles.x, -89, 'pitch is clamped before a pole');
assert.ok(f.fly.resetToSpawn(f.camera), 'reset available');
step(f);
sameRotation(basis(f.camera.angles).q, entered.q, 'reset restores original tilt and clears pending rotation');
assert.ok(f.camera.position.distance(new Vec3(2,3,4)) < 1e-8, 'reset restores spawn position');
f.camera.angles.set(-25, -63, -110); f.camera.fov = 38;
const newPose = basis(f.camera.angles);
f.fly.goto(f.camera); step(f, [25,0,0]);
sameRotation(basis(f.camera.angles).q,
  new Quat().setFromAxisAngle(newPose.up, -25).mul(newPose.q), 'restored pose reseeds fly rotation axes');
assert.equal(f.camera.fov, 38);

const smooth = fixture([0,0,90]); smooth.fly.rotateDamping = .95;
const smoothUp = basis(smooth.camera.angles).up;
step(smooth, [20,0,0], [0,0,0], 0);
sameRotation(basis(smooth.camera.angles).q, new Quat().setFromEulerAngles(0,0,90), 'zero dt does not jump');
for (let i = 0; i < 180; i++) {
  step(smooth, i % 3 === 0 ? [15,0,0] : [0,0,0]);
  assert.ok(basis(smooth.camera.angles).up.distance(smoothUp) < 1e-6,
    'damping and repeated full turns cannot accumulate screen roll');
}
for (const angles of [[75,0,90], [35,140,-90], [0,0,0], [30,30,15]]) {
  for (const localDestination of [[4,3,-8], [1,0,8]]) {
    const auto = fixture(angles), initial = basis(auto.camera.angles);
    auto.fly.rotateDamping = .95;
    const source = new engine.FlySource(); source.controller = auto.fly;
    const destination = initial.q.transformVector(new Vec3(...localDestination)).add(auto.camera.position);
    source.navigateTo(destination);
    for (let i = 0; i < 1800 && source.isActive; i++) {
      const move = [0,0,0], rotate = [0,0,0];
      const append = out => ({ append: input => input.forEach((v,j) => { out[j] += v; }) });
      const frame = { deltas: { move: append(move), rotate: append(rotate) }, read: () => ({ move, rotate }) };
      source.update(1/60, auto.camera, frame);
      auto.fly.update(1/60, frame, auto.camera);
    }
    const distance = destination.distance(auto.camera.position);
    const stopDistance = .75 / Math.tan(auto.camera.fov * Math.PI / 360);
    assert.ok(!source.isActive && Math.abs(distance - stopDistance) < .04,
      `automatic flight reaches its world target from tilted frame ${angles}`);
    assert.ok(basis(auto.camera.angles).forward.dot(destination.clone().sub(auto.camera.position).normalize()) > .999,
      'automatic steering faces the destination in world space');
    assert.ok(Math.abs(basis(auto.camera.angles).right.dot(initial.up)) < 1e-5,
      'automatic steering retains the entered horizon');
  }
}
console.log(`Fly camera: ${cases} tilted horizontal-turn cases, pitch, pan, reset, pose restore, damping, yaw wrapping and 8 automatic flights passed`);
