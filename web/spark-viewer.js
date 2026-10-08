import * as THREE from 'three';
import { OrbitControls } from 'three/addons/controls/OrbitControls.js';
import { SparkRenderer, SplatMesh, SplatFileType } from '@sparkjsdev/spark';
import { createSplatEffects } from './splat-effects.js';
import { createSceneIntro } from './scene-intro.js';

export function isEditingKey(e) {
  const target = e.target;
  if (target?.isContentEditable || target?.closest?.('textarea, select, [contenteditable="true"]')) return true;
  const slider = target?.closest?.('.tp-sldv_t');
  const input = target?.closest?.('input');
  // Checkboxes and sliders are settings, not text editors. Keep their native
  // arrow/space navigation but allow model letter shortcuts after using them.
  if (slider || ['checkbox', 'radio', 'range', 'button', 'submit', 'reset'].includes(input?.type)) {
    return ['ArrowLeft', 'ArrowRight', 'ArrowUp', 'ArrowDown', 'Space', 'Home', 'End'].includes(e.code);
  }
  if (!input) return false;
  return true;
}

// Spark 2.2.0 dispose() frees readback targets immediately while a sort may
// still be awaiting GPU/worker results. Drain those jobs before disposing.
// Keep the upstream bundle unchanged; this adapter is version-pinned.
class ManagedSparkRenderer extends SparkRenderer {
  pendingSorts = new Set();
  closing = false;
  driveSort() {
    if (this.closing) return Promise.resolve();
    const job = super.driveSort();
    this.pendingSorts.add(job);
    const started = performance.now();
    const done = () => { this.pendingSorts.delete(job); this.lastSortTime = performance.now() - started; };
    job.then(done, done);
    return job;
  }
  async disposeAfterSort() {
    this.closing = true;
    this.autoUpdate = false;
    clearTimeout(this.updateTimeoutId);
    clearTimeout(this.sortTimeoutId);
    await Promise.allSettled([...this.pendingSorts]);
    super.dispose();
    this.geometry.dispose();
    this.material.dispose();
  }
}

// Rendering/sorting/loading are provided by Spark; camera gestures by Three.js.
export class SparkViewer {
  constructor({ rootElement }) {
    this.rootElement = rootElement;
    this.disposed = false;
    this.renderer = new THREE.WebGLRenderer({ antialias: false, alpha: true });
    this.renderer.setPixelRatio(Math.min(devicePixelRatio, 1.5));
    this.renderer.setClearColor(0x05070b, 1);
    rootElement.appendChild(this.renderer.domElement);
    this.scene = new THREE.Scene();
    this.camera = new THREE.PerspectiveCamera(50, 1, .01, 1000);
    this.camera.up.set(0, -1, 0);
    this.viewPlaneUp = new THREE.Vector3(0, -1, 0);   // 视角平面：相机基准「朝上」矢量（世界系）
    this.camera.position.set(0, 0, 5);
    this.renderCamera = this.camera.clone();
    this.controls = new OrbitControls(this.camera, this.renderer.domElement);
    this.controls.enableDamping = true;
    this.controls.dampingFactor = .065;
    this.controls.rotateSpeed = .55;
    this.controls.zoomSpeed = .8;
    this.controls.mouseButtons = {
      LEFT: THREE.MOUSE.ROTATE, MIDDLE: THREE.MOUSE.DOLLY, RIGHT: THREE.MOUSE.PAN,
    };
    this.controls.autoRotateSpeed = .65;
    this.controls.minPolarAngle = .025;
    this.controls.maxPolarAngle = Math.PI - .025;
    this.controls.keys = { LEFT: 'KeyA', UP: 'KeyW', RIGHT: 'KeyD', BOTTOM: 'KeyS' };
    this.setCameraUp(this.viewPlaneUp);
    // Forward only non-editing keystrokes to upstream OrbitControls.
    this.keyboardEvents = new EventTarget();
    this.controls.listenToKeyEvents(this.keyboardEvents);
    this.splatScale = 1;
    this.pointCloud = false;
    this.spark = new ManagedSparkRenderer({ renderer: this.renderer });
    this.scene.add(this.spark);
    this.pointerNdc = new THREE.Vector2();
    this.parallaxOffset = new THREE.Vector2();
    this.pointerPoint = new THREE.Vector3();
    this.pointerVelocity = new THREE.Vector3();
    this.previousPoint = new THREE.Vector3();
    this.axis = new THREE.Vector3();
    this.raycaster = new THREE.Raycaster();
    this.plane = new THREE.Plane();
    this.inside = false;
    this.pointerReady = false;
    this.hitPoint = new THREE.Vector3();
    this.lastPick = 0;
    this.dragging = false;
    this.parallax = true;
    this.returnHome = false;
    this.homeDirection = new THREE.Vector3(0, 0, 1);
    this.releaseTime = 0;
    this.lastInteraction = performance.now();
    this.events = [];
    const listen = (target, event, callback, options) => {
      target.addEventListener(event, callback, options);
      this.events.push(() => target.removeEventListener(event, callback, options));
    };
    const canvas = this.renderer.domElement;
    // Cancel browser middle-button autoscroll, while letting OrbitControls
    // receive the gesture and handle dolly in perspective and orthographic mode.
    listen(canvas, 'mousedown', e => { if (e.button === 1) e.preventDefault(); });
    listen(canvas, 'auxclick', e => { if (e.button === 1) e.preventDefault(); });
    canvas.tabIndex = 0;
    canvas.setAttribute('aria-label', '3D 模型视窗');
    this.info = document.createElement('output');
    this.info.className = 'viewer-info';
    this.info.hidden = true;
    rootElement.appendChild(this.info);
    this.focusStatus = document.createElement('output');
    this.focusStatus.className = 'viewer-focus-status';
    this.focusStatus.setAttribute('aria-live', 'polite');
    rootElement.appendChild(this.focusStatus);
    listen(window, 'keydown', e => this.onKeyDown(e));
    listen(canvas, 'pointermove', e => {
      if (this.down?.pointerId === e.pointerId) this.down.moved = Math.max(this.down.moved,
        Math.hypot(e.clientX - this.down.x, e.clientY - this.down.y));
      this.movePointer(e);
    });
    listen(canvas, 'pointerleave', () => {
      this.inside = false; this.pointerReady = false; this.effects?.leave();
      if (this.cursor) this.cursor.visible = false;
    });
    listen(canvas, 'pointerdown', e => {
      if (e.button === 1) e.preventDefault();
      canvas.focus({ preventScroll: true });
      this.down = { x: e.clientX, y: e.clientY, time: performance.now(), button: e.button,
        pointerId: e.pointerId, moved: 0 };
      this.movePointer(e);
    });
    listen(window, 'pointerup', e => {
      if (!this.down || e.pointerId !== this.down.pointerId) return;
      const down = this.down; this.down = null;
      if (this.intro?.active) return;
      const click = e.button === down.button && down.moved < 3 &&
        Math.hypot(e.clientX - down.x, e.clientY - down.y) < 3 && performance.now() - down.time < 500;
      if (click && down.button === 1) this.focusAtScreenPoint(e.clientX, e.clientY);
      else if (click && down.button === 0 && this.inside && this.pointerReady) {
        this.pulse(this.effects?.uniforms.mode.value === 9 ? 'explosion' : 'ripple');
      }
    });
    listen(window, 'pointercancel', () => { this.down = null; this.effects?.leave(); });
    listen(canvas, 'wheel', () => { this.cancelFocus(); this.lastInteraction = performance.now(); }, { passive: true });
    listen(this.controls, 'start', () => {
      this.dragging = true; this.controls.autoRotate = false;
      this.cancelFocus();
      this.releaseTime = 0; this.lastInteraction = performance.now();
    });
    listen(this.controls, 'end', () => {
      this.dragging = false; this.releaseTime = performance.now();
      this.lastInteraction = performance.now();
      this.pointerVelocity.set(0, 0, 0);
      this.effects?.leave();
    });
    listen(document, 'visibilitychange', () => {
      this.previousFrame = performance.now();
      if (document.hidden) this.effects?.leave();
    });
    this.resizeObserver = new ResizeObserver(() => this.resize());
    this.resizeObserver.observe(rootElement);
    this.resize();
  }

  resize() {
    const w = Math.max(1, this.rootElement.clientWidth);
    const h = Math.max(1, this.rootElement.clientHeight);
    this.renderer.setSize(w, h, false);
    this.renderer.domElement.style.width = `${w}px`;
    this.renderer.domElement.style.height = `${h}px`;
    if (this.camera.isOrthographicCamera) {
      this.camera.left = -this.orthoHalfHeight * w / h;
      this.camera.right = this.orthoHalfHeight * w / h;
    } else this.camera.aspect = w / h;
    this.camera.updateProjectionMatrix();
  }

  async addSplatScene(url, { onProgress, intro = false } = {}) {
    this.splatMesh = new SplatMesh({
      url, fileType: SplatFileType.PLY, fileName: 'final.ply',
      onProgress: e => { if (e.lengthComputable) onProgress?.(e.loaded / e.total); },
    });
    await this.splatMesh.initialized;
    if (this.disposed) { this.splatMesh.dispose(); return; }
    const coordinates = [[], [], []];
    const stride = Math.max(1, Math.ceil(this.splatMesh.numSplats / 50000));
    this.splatMesh.forEachSplat((index, center, scales, rotation, opacity) => {
      if (index % stride || opacity < .02 || ![center.x, center.y, center.z].every(Number.isFinite)) return;
      coordinates[0].push(center.x); coordinates[1].push(center.y); coordinates[2].push(center.z);
    });
    const lo = [], hi = [];
    coordinates.forEach((arr, axis) => {
      arr.sort((a, b) => a - b);
      lo[axis] = arr[Math.floor((arr.length - 1) * .01)] ?? -1;
      hi[axis] = arr[Math.floor((arr.length - 1) * .99)] ?? 1;
    });
    this.bounds = {
      center: new THREE.Vector3(...lo.map((v, i) => (v + hi[i]) / 2)),
      radius: Math.max(...hi.map((v, i) => v - lo[i])) * .5 || 1,
    };
    this.camera.near = Math.max(.001, this.bounds.radius / 1000);
    this.camera.far = this.bounds.radius * 100;
    this.camera.updateProjectionMatrix();
    this.controls.minDistance = this.bounds.radius * .25;
    this.controls.maxDistance = this.bounds.radius * 15;
    this.pointerPoint.copy(this.bounds.center);
    this.effects = createSplatEffects(this.splatMesh, this.bounds);
    this.scene.add(this.splatMesh);
    this.controlPlane = new THREE.Group();
    this.controlPlane.add(new THREE.GridHelper(this.bounds.radius * 4, 20, 0x7396aa, 0x39495d),
      new THREE.AxesHelper(this.bounds.radius));
    this.controlPlane.position.copy(this.bounds.center);
    this.controlPlane.visible = false;
    this.scene.add(this.controlPlane);
    this.cursor = new THREE.Mesh(new THREE.SphereGeometry(this.bounds.radius * .025, 12, 8),
      new THREE.MeshBasicMaterial({ color: 0x70e0ff, wireframe: true, depthTest: false }));
    this.cursor.visible = false;
    this.scene.add(this.cursor);
    this.focusMarker = new THREE.Mesh(new THREE.RingGeometry(.72, 1, 32),
      new THREE.MeshBasicMaterial({ color: 0x78d6ff, transparent: true, depthTest: false, depthWrite: false }));
    this.focusMarker.visible = false;
    this.focusMarker.renderOrder = 100;
    this.scene.add(this.focusMarker);
    if (intro) this.intro = createSceneIntro({ mesh: this.splatMesh, bounds: this.bounds,
      root: this.rootElement, controls: this.controls, effects: this.effects,
      onPrepare: () => {
        this.cancelFocus();
        this.clearDamping();
        this.camera.position.add(this.bounds.center.clone().sub(this.controls.target));
        this.controls.target.copy(this.bounds.center);
        this.controls.update(0);
        this.parallaxOffset.set(0, 0);
        this.inside = false;
        this.pointerReady = false;
        this.releaseTime = 0;
        this.cursor.visible = false;
        this.focusMarker.visible = false;
      } });
  }

  focusAtScreenPoint(x, y) {
    if (this.intro?.active) return false;
    if (!this.bounds || this.disposed) return false;
    const rect = this.renderer.domElement.getBoundingClientRect();
    if (x < rect.left || x > rect.right || y < rect.top || y > rect.bottom || !rect.width || !rect.height) return false;
    const ndc = new THREE.Vector2((x - rect.left) / rect.width * 2 - 1, 1 - (y - rect.top) / rect.height * 2);
    // Use the actual displayed camera, with a fresh Spark raycast at click time.
    // A hover's fallback depth plane must never become a fake focus point.
    this.renderCamera.updateMatrixWorld();
    this.raycaster.setFromCamera(ndc, this.renderCamera);
    const hit = this.raycaster.intersectObject(this.splatMesh, false)[0];
    if (!hit?.point || hit.point.distanceTo(this.camera.position) < this.camera.near * 2) {
      this.focusStatus.textContent = '未命中模型，旋转中心保持不变';
      return false;
    }
    this.controls.autoRotate = false;
    this.clearDamping();
    this.effects.leave();
    this.releaseTime = 0;
    this.lastInteraction = performance.now();
    this.focusTransition = { from: this.controls.target.clone(), to: hit.point.clone(),
      position: this.camera.position.clone(), started: this.lastInteraction };
    this.focusMarker.position.copy(hit.point);
    this.focusMarker.visible = true;
    this.focusMarker.material.opacity = 1;
    this.focusMarkerUntil = this.lastInteraction + 1400;
    const p = hit.point;
    this.focusStatus.textContent = `中键定位：${p.x.toFixed(3)}, ${p.y.toFixed(3)}, ${p.z.toFixed(3)}`;
    return true;
  }

  cancelFocus() { this.focusTransition = null; }

  updateFocus(now) {
    const transition = this.focusTransition;
    if (transition) {
      const t = THREE.MathUtils.clamp((now - transition.started) / 320, 0, 1);
      this.controls.target.lerpVectors(transition.from, transition.to, t * t * (3 - 2 * t));
      this.camera.position.copy(transition.position);
      this.camera.lookAt(this.controls.target);
      if (t === 1) { this.focusTransition = null; this.captureHome(); }
    }
  }

  updateFocusMarker(now) {
    if (!this.focusMarker?.visible) return;
    const camera = this.renderCamera;
    const height = camera.isOrthographicCamera ? (camera.top - camera.bottom) / camera.zoom :
      this.focusMarker.position.distanceTo(camera.position) * 2 * Math.tan(THREE.MathUtils.degToRad(camera.fov) / 2);
    this.focusMarker.scale.setScalar(height * 12 / Math.max(1, this.rootElement.clientHeight));
    this.focusMarker.quaternion.copy(camera.quaternion);
    this.focusMarker.material.opacity = THREE.MathUtils.clamp((this.focusMarkerUntil - now) / 650, 0, 1);
    if (now >= this.focusMarkerUntil) this.focusMarker.visible = false;
  }

  setCameraUp(up) {
    this.camera.up.copy(up).normalize();
    // OrbitControls 0.180 caches its up transform. Refresh it after camera roll.
    this.controls._quat.setFromUnitVectors(this.camera.up, new THREE.Vector3(0, 1, 0));
    this.controls._quatInverse.copy(this.controls._quat).invert();
  }

  // 视角平面 = 单个世界系朝上矢量；位置仍由 controls.target 决定，故平面姿态完全由它确定。
  setViewPlane(up) {
    this.viewPlaneUp.copy(up).normalize();
    this.setCameraUp(this.viewPlaneUp);
  }

  resetViewPlane() {
    this.setViewPlane(new THREE.Vector3(0, -1, 0));
  }

  setOrthographicMode(enabled) {
    if (!!this.camera.isOrthographicCamera === enabled) return;
    this.cancelFocus();
    this.clearDamping();
    const old = this.camera;
    const aspect = this.rootElement.clientWidth / Math.max(1, this.rootElement.clientHeight);
    const tangent = Math.tan(THREE.MathUtils.degToRad(50) / 2);
    let camera;
    if (enabled) {
      this.orthoHalfHeight = this.controls.getDistance() * tangent;
      const half = this.orthoHalfHeight;
      camera = new THREE.OrthographicCamera(-half * aspect, half * aspect, half, -half, old.near, old.far);
    } else camera = new THREE.PerspectiveCamera(50, aspect, old.near, old.far);
    camera.position.copy(old.position); camera.quaternion.copy(old.quaternion); camera.up.copy(old.up);
    if (!enabled) {
      const distance = this.orthoHalfHeight / old.zoom / tangent;
      const offset = old.position.clone().sub(this.controls.target).normalize();
      camera.position.copy(this.controls.target).addScaledVector(offset, distance);
    }
    this.camera = camera;
    this.renderCamera = camera.clone();
    this.controls.object = camera;
    this.controls.update(0);
  }

  onKeyDown(e) {
    if (this.intro?.active) return;
    const movement = ['KeyW', 'KeyA', 'KeyS', 'KeyD'].includes(e.code);
    const canvas = this.renderer.domElement;
    if (!this.bounds || this.disposed || e.defaultPrevented || e.isComposing || e.altKey ||
        ((e.ctrlKey || e.metaKey) && !(movement && e.target === canvas)) || isEditingKey(e)) return;
    const toggles = ['KeyU', 'KeyI', 'KeyO', 'KeyP', 'KeyC'];
    if (!movement && !toggles.includes(e.code) &&
        !['KeyG', 'Equal', 'Minus', 'ArrowLeft', 'ArrowRight'].includes(e.code)) return;
    e.preventDefault();
    if (e.repeat && toggles.includes(e.code)) return;
    if (movement) {
      this.cancelFocus();
      this.controls.autoRotate = false;
      this.releaseTime = 0;
      this.lastInteraction = performance.now();
      this.effects.leave();
      this.keyboardEvents.dispatchEvent(new KeyboardEvent('keydown', {
        code: e.code, key: e.key, shiftKey: e.shiftKey, ctrlKey: e.ctrlKey, metaKey: e.metaKey, cancelable: true,
      }));
    } else if (e.code === 'KeyU') {
      this.setCameraUp(this.viewPlaneUp);   // 打开辅助平面即回到当前视角平面朝向
      this.controlPlane.visible = !this.controlPlane.visible;
      this.updateControlPlane();
    }
    else if (e.code === 'KeyI') { this.info.hidden = !this.info.hidden; this.updateInfo(); }
    else if (e.code === 'KeyO') this.setOrthographicMode(!this.camera.isOrthographicCamera);
    else if (e.code === 'KeyP') {
      this.pointCloud = !this.pointCloud;
      this.effects.setPointCloud(this.pointCloud);
      this.spark.maxPixelRadius = this.pointCloud ? 3 : 512;
    } else if (e.code === 'KeyC') {
      this.showCursor = !this.showCursor;
      this.cursor.visible = this.showCursor && this.inside && !!this.pointerHit;
    } else if (e.code === 'Equal' || e.code === 'Minus') {
      this.splatScale = Math.max(0, this.splatScale + (e.code === 'Equal' ? .05 : -.05));
      this.effects.setSplatScale(this.splatScale);
    } else if (e.code === 'KeyG') {
      this.spark.focalAdjustment = Math.max(.1, this.spark.focalAdjustment + .02);
    } else {
      const forward = this.camera.getWorldDirection(new THREE.Vector3());
      this.setViewPlane(this.camera.up.clone().applyAxisAngle(forward, (e.code === 'ArrowLeft' ? 1 : -1) * Math.PI / 128));
      this.controls.update(0);
    }
    this.updateInfo();
  }

  updateInfo() {
    if (this.info.hidden || !this.bounds) return;
    const vector = v => `${v.x.toFixed(3)}, ${v.y.toFixed(3)}, ${v.z.toFixed(3)}`;
    this.info.textContent = `${this.splatMesh.numSplats.toLocaleString()} 粒子 · ${this.camera.isOrthographicCamera ? '正交' : '透视'}视角\n` +
      `${this.pointCloud ? '点云' : '高斯'}模式 · 大小 ${this.splatScale.toFixed(2)} · 焦距系数 ${this.spark.focalAdjustment.toFixed(2)}\n` +
      `距离 ${this.controls.getDistance().toFixed(2)} · ${this.fps || 0} FPS\n` +
      `相机位置 ${vector(this.camera.position)}\n目标位置 ${vector(this.controls.target)}\n` +
      `相机朝上 ${vector(this.camera.up)}\n光标位置 ${this.showCursor && this.cursor.visible ? vector(this.cursor.position) : '—'}\n` +
      `提交渲染 ${this.spark.activeSplats.toLocaleString()} / ${this.splatMesh.numSplats.toLocaleString()}\n` +
      `排序任务 ${this.spark.lastSortTime?.toFixed(2) ?? '—'} ms · 画布 ${this.renderer.domElement.width} × ${this.renderer.domElement.height}`;
  }

  updateControlPlane() {
    if (!this.controlPlane?.visible) return;
    this.controlPlane.position.copy(this.controls.target);
    this.controlPlane.quaternion.setFromUnitVectors(new THREE.Vector3(0, 1, 0), this.camera.up);
  }

  captureHome() {
    this.cancelFocus();
    this.homeDirection.copy(this.camera.position).sub(this.controls.target).normalize();
    this.releaseTime = 0;
    this.pointerReady = false;
    this.effects?.leave();
  }

  clearDamping() {
    const damping = this.controls.enableDamping;
    this.controls.enableDamping = false;
    this.controls.update(0);
    this.controls.enableDamping = damping;
  }

  movePointer(e) {
    if (this.intro?.active) {
      this.pointerReady = false;
      this.inside = false;
      this.cursor.visible = false;
      this.effects?.leave();
      return;
    }
    if (!this.bounds) return;
    const rect = this.renderer.domElement.getBoundingClientRect();
    this.inside = e.clientX >= rect.left && e.clientX <= rect.right &&
      e.clientY >= rect.top && e.clientY <= rect.bottom;
    if (!this.inside) { this.pointerReady = false; this.effects?.leave(); return; }
    this.pointerNdc.set((e.clientX - rect.left) / rect.width * 2 - 1,
      1 - (e.clientY - rect.top) / rect.height * 2);
    const now = performance.now();
    this.renderCamera.updateMatrixWorld();
    this.renderCamera.getWorldDirection(this.axis);
    this.raycaster.setFromCamera(this.pointerNdc, this.renderCamera);
    // Reuse Spark's WASM ray-splat intersection, throttled to avoid a full
    // point-cloud query each frame. Fall back to the orbit target depth.
    if (!this.dragging && now - this.lastPick > 120) {
      const hit = this.raycaster.intersectObject(this.splatMesh, false)[0];
      this.pointerHit = !!hit;
      this.hitPoint.copy(hit?.point || this.controls.target);
      this.lastPick = now;
    }
    this.plane.setFromNormalAndCoplanarPoint(this.axis,
      this.lastPick ? this.hitPoint : this.controls.target);
    if (!this.raycaster.ray.intersectPlane(this.plane, this.pointerPoint)) return;
    const dt = Math.max(.008, (now - (this.previousMove || now)) / 1000);
    if (this.pointerReady) {
      this.pointerVelocity.copy(this.pointerPoint).sub(this.previousPoint).divideScalar(dt);
    } else this.pointerVelocity.set(0, 0, 0);
    this.previousPoint.copy(this.pointerPoint);
    this.previousMove = now;
    this.pointerReady = true;
    this.cursor.position.copy(this.hitPoint);
    this.cursor.visible = !!this.showCursor && !!this.pointerHit;
    // Dragging only deforms the model when the explicit throw mode is selected.
    const throwMode = this.effects.uniforms.mode.value === 4;
    const throwing = this.dragging && this.down?.button === 0;
    const active = throwMode ? throwing : !this.dragging;
    this.effects.setPointer(this.pointerPoint, this.axis,
      throwMode && throwing ? this.pointerVelocity : new THREE.Vector3(), active);
  }

  pulse(kind) {
    if (this.intro?.active) return;
    this.effects?.pulse(kind, this.pointerReady ? this.pointerPoint : this.controls.target);
  }

  start() {
    this.previousFrame = performance.now();
    this.renderer.setAnimationLoop(() => {
      if (this.disposed || document.hidden) return;
      const now = performance.now();
      const dt = Math.min(.05, Math.max(0, (now - this.previousFrame) / 1000));
      this.previousFrame = now;
      this.fps = Math.round(1 / Math.max(dt, .001));
      if (now - (this.lastInfo || 0) > 250) { this.updateInfo(); this.lastInfo = now; }
      if (!this.intro?.active) {
        this.updateFocus(now);
        this.controls.update(dt);
      }
      this.updateControlPlane();
      if (!this.intro?.active && this.returnHome && !this.dragging && !this.controls.autoRotate && this.releaseTime &&
          now - Math.max(this.releaseTime, this.lastInteraction) > 1200) {
        const offset = this.camera.position.clone().sub(this.controls.target);
        const distance = offset.length();
        offset.normalize();
        const rotation = new THREE.Quaternion().setFromUnitVectors(offset, this.homeDirection);
        const step = new THREE.Quaternion().slerp(rotation, 1 - Math.exp(-1.1 * dt));
        offset.applyQuaternion(step);
        this.camera.position.copy(this.controls.target).addScaledVector(offset, distance);
        this.controls.update(0);
        if (offset.distanceToSquared(this.homeDirection) < 1e-7) this.releaseTime = 0;
      }
      this.renderCamera.copy(this.camera);
      this.renderCamera.updateMatrixWorld();
      const want = this.parallax && this.inside && !this.dragging ? this.pointerNdc : new THREE.Vector2();
      this.parallaxOffset.lerp(want, 1 - Math.exp(-5 * dt));
      if (this.bounds) {
        const right = new THREE.Vector3().setFromMatrixColumn(this.camera.matrixWorld, 0);
        const up = new THREE.Vector3().setFromMatrixColumn(this.camera.matrixWorld, 1);
        this.renderCamera.position.addScaledVector(right, this.parallaxOffset.x * this.bounds.radius * .018);
        this.renderCamera.position.addScaledVector(up, this.parallaxOffset.y * this.bounds.radius * .018);
        this.renderCamera.rotateY(-this.parallaxOffset.x * .012);
        this.renderCamera.rotateX(this.parallaxOffset.y * .008);
      }
      if (this.intro?.active) {
        this.effects?.leave();
        this.intro.update(dt);
        this.intro.applyCamera(this.renderCamera);
      } else this.effects?.update(dt);
      this.updateFocusMarker(now);
      this.renderer.render(this.scene, this.renderCamera);
    });
  }

  forceRenderNextFrame() {} // The animation loop always renders.
  getSplatMesh() { return this.splatMesh; }

  async dispose() {
    if (this.disposed) return;
    this.disposed = true;
    this.renderer.setAnimationLoop(null);
    this.intro?.dispose();
    this.resizeObserver.disconnect();
    this.events.forEach(remove => remove());
    this.controls.dispose();
    this.info.remove();
    this.focusStatus.remove();
    this.cancelFocus();
    for (const helper of [this.controlPlane, this.cursor, this.focusMarker]) helper?.traverse(object => {
      object.geometry?.dispose();
      if (Array.isArray(object.material)) object.material.forEach(material => material.dispose());
      else object.material?.dispose();
    });
    await this.spark.disposeAfterSort();
    if (this.splatMesh?.isInitialized) this.splatMesh.dispose();
    this.renderer.dispose();
    this.renderer.forceContextLoss();
    this.renderer.domElement.remove();
  }
}
