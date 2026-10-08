import * as THREE from './vendor/spark/three.core.js';

const vec = a => Array.isArray(a) && a.length === 3 && a.every(Number.isFinite);
const display = a => new THREE.Vector3(-a[0], -a[1], a[2]);

// Jacobi diagonalization of a symmetric covariance matrix; no renderer needed.
function principalAxes(points, center) {
  const a = [[0, 0, 0], [0, 0, 0], [0, 0, 0]];
  for (const point of points) {
    const d = point.clone().sub(center).toArray();
    for (let i = 0; i < 3; i++) for (let j = 0; j < 3; j++) a[i][j] += d[i] * d[j] / points.length;
  }
  const magnitude = Math.max(Number.MIN_VALUE, ...a.map((row, i) => Math.abs(row[i])));
  for (const row of a) for (let i = 0; i < 3; i++) row[i] /= magnitude;
  const v = [[1, 0, 0], [0, 1, 0], [0, 0, 1]];
  for (let pass = 0; pass < 32; pass++) {
    let p = 0, q = 1;
    for (const [i, j] of [[0, 2], [1, 2]]) if (Math.abs(a[i][j]) > Math.abs(a[p][q])) { p = i; q = j; }
    if (Math.abs(a[p][q]) < 1e-10 * Math.max(1, ...a.map((row, i) => Math.abs(row[i])))) break;
    const angle = .5 * Math.atan2(2 * a[p][q], a[q][q] - a[p][p]);
    const c = Math.cos(angle), s = Math.sin(angle);
    const ap = a[p][p], aq = a[q][q], off = a[p][q];
    a[p][p] = c*c*ap - 2*s*c*off + s*s*aq;
    a[q][q] = s*s*ap + 2*s*c*off + c*c*aq;
    a[p][q] = a[q][p] = 0;
    for (let k = 0; k < 3; k++) {
      if (k !== p && k !== q) {
        const kp = a[k][p], kq = a[k][q];
        a[k][p] = a[p][k] = c*kp - s*kq;
        a[k][q] = a[q][k] = s*kp + c*kq;
      }
      const vp = v[k][p], vq = v[k][q];
      v[k][p] = c*vp - s*vq; v[k][q] = s*vp + c*vq;
    }
  }
  return [0, 1, 2].sort((i, j) => a[i][i] - a[j][j]).map(i => new THREE.Vector3(v[0][i], v[1][i], v[2][i]).normalize());
}

export function calculateModelView(resource, box, { sourceView, aspect = 1 } = {}) {
  aspect = Number.isFinite(aspect) && aspect > 0 ? aspect : 1;
  const center = display([box.center.x, box.center.y, box.center.z]);
  const radius = Math.max(box.halfExtents.length(), .01);
  if (sourceView?.coordinateSpace === 'colmap' && vec(sourceView.position) && vec(sourceView.forward) && vec(sourceView.up)) {
    const position = display(sourceView.position);
    const forward = display(sourceView.forward), up = display(sourceView.up);
    if (forward.lengthSq() > 1e-10 && up.lengthSq() > 1e-10 && new THREE.Vector3().crossVectors(forward, up).lengthSq() > 1e-10) {
      forward.normalize(); up.normalize();
      const depth = Math.max(radius * .25, center.clone().sub(position).dot(forward));
      return { position: position.toArray(), target: position.clone().addScaledVector(forward, depth).toArray(), up: up.toArray(),
        fov: sourceView.fov > 1 && sourceView.fov < 179 ? sourceView.fov : 65, source: 'camera', image: sourceView.image };
    }
  }
  const props = ['x', 'y', 'z'].map(name => resource.gsplatData?.getProp(name));
  const points = [];
  const half = box.halfExtents;
  if (props.every(p => p?.length)) {
    const stride = Math.max(1, Math.ceil(props[0].length / 12000));
    for (let i = 0; i < props[0].length; i += stride) {
      const point = display(props.map(prop => prop[i]));
      const d = point.clone().sub(center);
      if ([d.x, d.y, d.z].every(Number.isFinite) && Math.abs(d.x) <= half.x && Math.abs(d.y) <= half.y && Math.abs(d.z) <= half.z) points.push(point);
    }
  }
  const axes = points.length > 3 ? principalAxes(points, center) : [new THREE.Vector3(0, 0, -1), new THREE.Vector3(1, 0, 0), new THREE.Vector3(0, 1, 0)];
  const direction = axes[0];
  const dominant = ['z', 'x', 'y'].sort((a, b) => Math.abs(direction[b]) - Math.abs(direction[a]))[0];
  if (direction[dominant] > 0) direction.negate();
  const up = Math.abs(axes[1].y) > Math.abs(axes[2].y) ? axes[1] : axes[2];
  if (up.y < 0 || (Math.abs(up.y) < 1e-6 && up.x < 0)) up.negate();
  const right = new THREE.Vector3().crossVectors(up, direction).normalize();
  const fov = 65, tangent = Math.tan(THREE.MathUtils.degToRad(fov / 2));
  let distance = .01;
  // Fit both axes and depth at the actual aspect ratio, including portrait.
  for (const x of [-half.x, half.x]) for (const y of [-half.y, half.y]) for (const z of [-half.z, half.z]) {
    const corner = new THREE.Vector3(x, y, z);
    distance = Math.max(distance, corner.dot(direction) + Math.max(Math.abs(corner.dot(up))/tangent, Math.abs(corner.dot(right))/(tangent*aspect)));
  }
  return { position: center.clone().addScaledVector(direction, distance * 1.12).toArray(),
    target: center.toArray(), up: up.toArray(), fov, source: 'geometry' };
}

export function nativeCameraPose(view, rotation, aspect) {
  const camera = new THREE.PerspectiveCamera(view.fov);
  camera.position.fromArray(view.position); camera.up.fromArray(view.up); camera.lookAt(new THREE.Vector3(...view.target));
  const angles = rotation.set(camera.quaternion.x, camera.quaternion.y, camera.quaternion.z, camera.quaternion.w).getEulerAngles();
  if (angles.x > 90 || angles.x < -90) {
    angles.x += angles.x > 90 ? -180 : 180; angles.y = 180 - angles.y; angles.z += 180;
  }
  return { position: [...view.position], angles: [angles.x, angles.y, angles.z], distance: camera.position.distanceTo(new THREE.Vector3(...view.target)),
    fov: aspect > 1 ? THREE.MathUtils.radToDeg(2 * Math.atan(Math.tan(THREE.MathUtils.degToRad(view.fov / 2)) * aspect)) : view.fov, mode: 'orbit' };
}
