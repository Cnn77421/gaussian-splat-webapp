import * as THREE from './vendor/spark/three.core.js';
import { vectorValid } from './view-preferences.js';
import { OrbitControls } from './vendor/spark/OrbitControls.js';

const MODE_KEY = 'splat.cameraMode';
// SuperSplat rotates PLY by 180 degrees around Z. Convert the previous raw
// COLMAP presets and stored up vectors; model data stays untouched.
const toDisplay = v => new THREE.Vector3(-v.x, -v.y, v.z);
const presets = [
  ['初始视角', null], ['正面', [0, -.3, -1]],
  ['左侧', [-1, -.3, 0]], ['右侧', [1, -.3, 0]],
  ['俯视', [0, -1, .001]], ['背面', [0, -.3, 1]],
];
const read = key => { try { return localStorage.getItem(key); } catch { return null; } };
const write = (key, value) => { try { value === null ? localStorage.removeItem(key) : localStorage.setItem(key, value); return true; } catch { return false; } };
function storedUp(preview) {
  const a = preview.preferences.read().up;
  if (vectorValid(a) && Math.hypot(...a) > 1e-6) return new THREE.Vector3(...a).normalize();
  return new THREE.Vector3(...(preview.modelView?.up || [0, 1, 0])).normalize();
}

export class LegacyViewControls {
  constructor(preview) {
    this.preview = preview;
    this.handle = preview.handle;
    this.app = this.handle.app;
    this.root = preview.root.querySelector('.sse-viewer');
    this.entity = this.app.root.findByName('camera');
    this.active = false;
    this.cleanups = [];
    this.center = new THREE.Vector3();
    const splat = this.app.root.findByName('gsplat');
    const box = preview.subjectBounds || splat.gsplat.customAabb || splat.gsplat.resource.aabb;
    const center = splat.getWorldTransform().transformPoint(box.center);
    this.center.set(center.x, center.y, center.z);
    // A scene reference plane must not follow the movable orbit/pan target.
    // Keep its origin fixed for this model; explicit leveling only rotates it.
    this.planeOrigin = this.center.clone();
    this.radius = Math.max(box.halfExtents.length(), .01);
    this.up = storedUp(this.preview);
    this.pointerNdc = new THREE.Vector2(); this.parallaxOffset = new THREE.Vector2();
    this.parallax = true; this.returnHome = false;
    this.camera = new THREE.PerspectiveCamera(50, 1, .001, 10000);
    this.surface = document.createElement('div');
    this.surface.className = 'legacy-surface';
    this.surface.tabIndex = 0;
    this.surface.setAttribute('role', 'application');
    this.surface.setAttribute('aria-label', '原有视角模型视窗');
    this.surface.hidden = true;
    // Keep native UI above an independent gesture surface, isolating legacy
    // mouse input and picking from the native controllers.
    this.root.insertBefore(this.surface, this.root.querySelector('.sse-sceneLayer'));
    this.controls = new OrbitControls(this.camera, this.surface);
    Object.assign(this.controls, { enabled: false, enableDamping: true, dampingFactor: .065,
      rotateSpeed: .55, zoomSpeed: .8, autoRotateSpeed: .65,
      minPolarAngle: .025, maxPolarAngle: Math.PI - .025,
      minDistance: this.radius * .25, maxDistance: this.radius * 15 });
    this.controls.keys = { LEFT: 'KeyA', UP: 'KeyW', RIGHT: 'KeyD', BOTTOM: 'KeyS' };
    this.keyboard = new EventTarget();
    this.controls.listenToKeyEvents(this.keyboard);
    this.setUp(this.up);
    this.button = document.createElement('button');
    this.button.className = 'sse-panelButton sse-right legacy-camera';
    this.button.textContent = '原有视角';
    this.button.title = '原有视角操作：U 水平面、方向键调平';
    this.button.setAttribute('aria-pressed', 'false');
    const fly = this.root.querySelector('.sse-flyCamera');
    for (const [selector, name] of [['.sse-orbitCamera', '环绕相机'], ['.sse-flyCamera', '飞行相机'],
      ['.sse-settings', '预览设置'], ['.sse-controlsButton', '操作说明'], ['.sse-info', '查看器信息'],
      ['.sse-enterFullscreen', '进入全屏'], ['.sse-exitFullscreen', '退出全屏']]) {
      this.root.querySelector(selector)?.setAttribute('aria-label', name);
    }
    fly.classList.remove('sse-right');
    fly.after(this.button);
    this.panel = document.createElement('details');
    this.panel.className = 'legacy-panel';
    this.panel.open = true;
    this.panel.hidden = true;
    this.panel.innerHTML = `<summary><span>原有视角操作</span><button data-action="exit" class="legacy-exit">退出原有视角</button></summary><div class="legacy-panel-content">
      <div class="legacy-actions legacy-presets"></div>
      <div class="legacy-actions"><button data-action="plane" aria-pressed="false">辅助平面 U</button><button data-action="left">← 调平</button><button data-action="right">调平 →</button></div>
      <div class="legacy-actions"><button data-action="save">保存水平面 ⇧U</button><button data-action="resetPlane">恢复默认水平面</button></div>
      <div class="legacy-actions"><button data-action="spin" aria-pressed="false">自动环绕 R</button><button data-action="ortho" aria-pressed="false">正交视角 O</button><button data-action="info" aria-pressed="false">信息 I</button></div>
      <div class="legacy-options"><label><input type="checkbox" data-option="returnHome"> 松手后缓慢回正</label><label><input type="checkbox" data-option="parallax" checked> 鼠标视差 / 轻微偏航</label></div>
      <p>左键旋转 · 右键平移 · 中键拖动 / 滚轮缩放<br>中键单击定位中心 · WASD 平移 · ⇧WASD 旋转<br>0–6 切换视角 · F 全屏 · Esc 退出此模式</p><output class="legacy-status" aria-live="polite"></output></div>`;
    this.info = document.createElement('output');
    this.info.className = 'legacy-info'; this.info.hidden = true;
    this.root.querySelector('.sse-ui').append(this.panel, this.info);
    presets.forEach(([name], i) => {
      if (i === 0 && preview.modelView?.source === 'camera') name = '源视角';
      const button = document.createElement('button');
      button.textContent = `${i + 1} ${name}`;
      this.panel.querySelector('.legacy-presets').append(button);
      this.listen(button, 'click', () => { this.preset(i); this.surface.focus({ preventScroll: true }); });
    });
    this.listen(this.button, 'click', e => {
      e.stopPropagation();
      if (this.active) this.returnToOrbit();
      else this.enter();
    });
    this.listen(this.panel, 'click', e => {
      // The native UI blurs the active element on any bubbled click. Keep
      // focus on our gesture surface after a legacy action.
      e.stopPropagation();
      const action = e.target.closest('[data-action]')?.dataset.action;
      if (action) {
        e.preventDefault();
        this.action(action);
        if (this.active) this.surface.focus({ preventScroll: true });
      }
    });
    this.listen(this.panel, 'change', e => {
      if (e.target.dataset.option) this[e.target.dataset.option] = e.target.checked;
    });
    // On narrow screens, leave space for the native settings card. The legacy
    // header and its exit button remain available while its controls fold away.
    this.listen(this.root.querySelector('.sse-settings'), 'click', () => {
      if (matchMedia('(max-width: 640px)').matches &&
          this.root.querySelector('.sse-settingsPanel').classList.contains('sse-hidden')) {
        this.panel.open = false;
        if (preview.effects) preview.effects.panel.open = false;
      }
    }, true);
    for (const selector of ['.sse-orbitCamera', '.sse-flyCamera', '.sse-fpsCamera', '.sse-play', '.sse-frame']) {
      this.listen(this.root.querySelector(selector), 'click', () => this.exit(selector === '.sse-flyCamera' ? 'fly' : 'orbit'), true);
    }
    this.listen(this.root.querySelector('.sse-reset'), 'click', e => {
      if (this.active) { e.stopImmediatePropagation(); this.preset(0); }
    }, true);
    this.modeChanged = () => { if (this.active && this.handle.state.cameraMode !== 'orbit') this.exit(this.handle.state.cameraMode); };
    this.handle.events.on('cameraMode:changed', this.modeChanged);
    this.listen(window, 'keydown', e => this.key(e), true);
    this.listen(this.surface, 'pointerdown', e => {
      this.surface.focus({ preventScroll: true });
      this.controls.autoRotate = false; this.sync();
      this.releaseTime = 0; this.lastInteraction = performance.now();
      this.down = { id: e.pointerId, x: e.clientX, y: e.clientY, button: e.button, moved: 0 };
    });
    this.listen(this.surface, 'pointermove', e => {
      this.inside = true;
      const rect = this.surface.getBoundingClientRect();
      this.pointerNdc.set((e.clientX - rect.left) / rect.width * 2 - 1, 1 - (e.clientY - rect.top) / rect.height * 2);
      if (this.down?.id === e.pointerId) this.down.moved = Math.max(this.down.moved, Math.hypot(e.clientX - this.down.x, e.clientY - this.down.y));
    });
    this.listen(this.surface, 'pointerup', e => {
      const down = this.down; this.down = null;
      this.releaseTime = this.lastInteraction = performance.now();
      if (down?.id === e.pointerId && down.button === 1 && down.moved < 4) this.focusAt(e.clientX, e.clientY).catch(() => this.status('定位失败，请重试'));
    });
    this.listen(this.surface, 'auxclick', e => e.preventDefault());
    this.listen(this.surface, 'pointercancel', () => { this.down = null; });
    this.listen(this.surface, 'pointerleave', () => { this.inside = false; });
    this.listen(this.surface, 'wheel', () => { this.lastInteraction = performance.now(); }, { passive: true });
    this.pcStart = this.entity.getPosition().clone(); this.pcEnd = this.pcStart.clone();
    this.pcQuat = this.entity.getRotation().clone();
    this.gridColor = this.app.scene.ambientLight.clone().set(.3, .45, .55, 1);
    this.axisColor = this.gridColor.clone().set(.95, .5, .15, 1);
    this.update = dt => this.tick(dt);
    this.app.on('update', this.update);
    this.sync();
    if (read(MODE_KEY) === 'legacy') this.enter();
  }

  listen(target, event, fn, options) {
    if (!target) return;
    target.addEventListener(event, fn, options);
    this.cleanups.push(() => target.removeEventListener(event, fn, options));
  }
  setUp(up) {
    this.up.copy(up).normalize(); this.camera.up.copy(this.up);
    // The pinned previous OrbitControls caches the up transform.
    this.controls._quat.setFromUnitVectors(this.up, new THREE.Vector3(0, 1, 0));
    this.controls._quatInverse.copy(this.controls._quat).invert();
  }
  enter() {
    if (this.active) { this.surface.focus({ preventScroll: true }); return; }
    const nativePose = this.handle.getCameraState();
    const position = this.entity.getPosition().clone().set(...nativePose.position);
    const rotation = this.entity.getRotation().clone().setFromEulerAngles(...nativePose.angles);
    if (this.camera.isOrthographicCamera) this.orthographic(false);
    this.camera.position.set(position.x, position.y, position.z);
    this.camera.quaternion.set(rotation.x, rotation.y, rotation.z, rotation.w);
    const component = this.entity.camera;
    const aspect = this.root.clientWidth / Math.max(1, this.root.clientHeight);
    this.camera.fov = aspect > 1 ? THREE.MathUtils.radToDeg(2 * Math.atan(Math.tan(THREE.MathUtils.degToRad(nativePose.fov) / 2) / aspect)) : nativePose.fov;
    this.perspectiveFov = this.camera.fov;
    this.setUp(new THREE.Vector3(0, 1, 0).applyQuaternion(this.camera.quaternion));
    const forward = this.camera.getWorldDirection(new THREE.Vector3());
    const distance = Math.max(this.radius * .25, this.handle.getCameraState().distance);
    this.controls.target.copy(this.camera.position).addScaledVector(forward, distance);
    this.controls._sphericalDelta.set(0, 0, 0); this.controls._panOffset.set(0, 0, 0); this.controls._scale = 1;
    this.parallaxOffset.set(0, 0); this.inside = false;
    this.homeDirection = this.camera.position.clone().sub(this.controls.target).normalize();
    this.handle.state.animationPaused = true;
    this.handle.state.cameraMode = 'orbit';
    this.handle.state.inputEnabled = false;
    this.active = true; this.controls.enabled = true;
    if (matchMedia('(max-width: 640px)').matches && this.preview.effects) this.preview.effects.panel.open = false;
    this.surface.hidden = this.panel.hidden = false;
    this.root.classList.add('legacy-active');
    this.controls.update(0); this.surface.focus({ preventScroll: true });
    write(MODE_KEY, 'legacy'); this.sync(); this.tick(0);
  }
  snapshot(mode = 'legacy') {
    this.tick(0);
    const position = this.entity.getPosition(), angles = this.entity.getEulerAngles();
    // PlayCanvas decomposes yaw to ±90°, which can represent an ordinary
    // rear view as pitch >90°. Native controllers clamp pitch every frame.
    // Select the equivalent Euler branch with pitch inside their allowed range.
    if (angles.x > 90 || angles.x < -90) {
      angles.x += angles.x > 90 ? -180 : 180;
      angles.y = 180 - angles.y;
      angles.z += 180;
    }
    const aspect = this.root.clientWidth / Math.max(1, this.root.clientHeight);
    const verticalFov = this.camera.isOrthographicCamera ? THREE.MathUtils.radToDeg(2 * Math.atan(this.camera.top / this.camera.zoom / this.controls.getDistance())) : this.camera.fov;
    return { position: [position.x, position.y, position.z], angles: [angles.x, angles.y, angles.z],
      distance: this.controls.getDistance(), fov: aspect > 1 ? THREE.MathUtils.radToDeg(2 * Math.atan(Math.tan(THREE.MathUtils.degToRad(verticalFov) / 2) * aspect)) : verticalFov,
      mode, up: this.up.toArray(), target: this.controls.target.toArray(), ortho: this.camera.isOrthographicCamera ? this.camera.top / this.camera.zoom : null };
  }
  exit(mode = 'orbit') {
    if (!this.active) return;
    const pose = this.snapshot(mode);
    this.active = false; this.controls.enabled = false;
    this.pickTicket = (this.pickTicket || 0) + 1;
    this.surface.hidden = this.panel.hidden = this.info.hidden = true;
    this.root.classList.remove('legacy-active');
    this.entity.camera.projection = 0;
    this.handle.setCameraState(pose);
    this.preview.onFocus({ target: document.activeElement });
    write(MODE_KEY, null); this.sync();
    this.app.renderNextFrame = true;
  }
  returnToOrbit() {
    this.exit();
    this.handle.state.cameraMode = 'orbit';
    this.preview.root.focus({ preventScroll: true });
  }
  preset(i) {
    this.controls.autoRotate = false;
    this.setUp(storedUp(this.preview));
    const view = i === 0 ? this.preview.modelView : null;
    this.controls.target.copy(view ? new THREE.Vector3(...view.target) : this.center);
    if (view) {
      if (this.camera.isOrthographicCamera) this.orthographic(false);
      this.camera.position.fromArray(view.position);
      this.camera.fov = this.perspectiveFov = view.fov;
      const distance = this.camera.position.distanceTo(this.controls.target);
      this.controls.minDistance = Math.min(this.radius * .25, distance);
      this.controls.maxDistance = Math.max(this.radius * 15, distance);
    } else {
      const direction = toDisplay(new THREE.Vector3(...(presets[i][1] || [0, 0, -1]))).normalize();
      this.camera.position.copy(this.center).addScaledVector(direction, this.radius * 2.2);
    }
    this.camera.lookAt(this.controls.target);
    this.controls._sphericalDelta.set(0, 0, 0); this.controls._panOffset.set(0, 0, 0); this.controls._scale = 1;
    this.controls.update(0); this.sync();
    this.homeDirection = this.camera.position.clone().sub(this.controls.target).normalize();
    this.releaseTime = 0;
  }
  action(name) {
    if (name === 'exit') { this.returnToOrbit(); return; }
    if (name === 'plane') this.planeVisible = !this.planeVisible;
    else if (name === 'left' || name === 'right') {
      const axis = this.camera.getWorldDirection(new THREE.Vector3());
      this.setUp(this.up.clone().applyAxisAngle(axis, (name === 'left' ? 1 : -1) * Math.PI / 128));
      this.controls.update(0);
    } else if (name === 'save') {
      const saved = this.preview.preferences.set({ up: this.up.toArray() });
      this.status(saved ? '已保存此模型的水平面，重新打开仍有效' : '浏览器无法保存，当前水平面仍可使用');
    } else if (name === 'resetPlane') {
      this.preview.preferences.set({ up: null }); this.setUp(storedUp(this.preview)); this.controls.update(0);
      this.status('已恢复默认水平面');
    } else if (name === 'spin') this.controls.autoRotate = !this.controls.autoRotate;
    else if (name === 'ortho') this.orthographic(!this.camera.isOrthographicCamera);
    else if (name === 'info') this.info.hidden = !this.info.hidden;
    this.sync(); this.app.renderNextFrame = true;
  }
  orthographic(enabled) {
    const old = this.camera, tangent = Math.tan(THREE.MathUtils.degToRad(this.perspectiveFov || 50) / 2);
    const half = this.controls.getDistance() * tangent;
    const camera = enabled ? new THREE.OrthographicCamera(-half, half, half, -half, .001, 10000) : new THREE.PerspectiveCamera(this.perspectiveFov || 50, 1, .001, 10000);
    camera.position.copy(old.position); camera.quaternion.copy(old.quaternion); camera.up.copy(old.up);
    if (!enabled) {
      const distance = old.top / old.zoom / tangent;
      camera.position.copy(this.controls.target).addScaledVector(old.position.clone().sub(this.controls.target).normalize(), distance);
    }
    this.camera = camera; this.controls.object = camera;
    this.setUp(this.up); this.controls.update(0);
  }
  key(e) {
    if (this.active && e.code === 'Escape' && !e.isComposing && !e.altKey && !e.ctrlKey && !e.metaKey &&
        this.preview.root.contains(document.activeElement)) {
      e.preventDefault(); e.stopImmediatePropagation();
      if (e.repeat) return;
      if (this.handle.state.isFullscreen) this.handle.exitFullscreen().catch(() => this.status('请使用全屏按钮退出全屏'));
      else this.returnToOrbit();
      return;
    }
    if (!this.active || e.defaultPrevented || e.isComposing || e.altKey ||
      e.target.closest?.('input, select, textarea, [contenteditable], button, summary') || !this.preview.root.contains(document.activeElement)) return;
    const movement = ['KeyW', 'KeyA', 'KeyS', 'KeyD'].includes(e.code);
    if ((e.ctrlKey || e.metaKey) && !(movement && e.target === this.surface)) return;
    const actions = { KeyU: e.shiftKey ? 'save' : 'plane', ArrowLeft: 'left', ArrowRight: 'right', KeyR: 'spin', KeyO: 'ortho', KeyI: 'info' };
    const preset = /^Digit[0-6]$/.test(e.code);
    if (!movement && !actions[e.code] && !preset && e.code !== 'KeyF') return;
    e.preventDefault(); e.stopImmediatePropagation();
    if (movement) {
      this.controls.autoRotate = false;
      this.releaseTime = 0; this.lastInteraction = performance.now();
      this.keyboard.dispatchEvent(new KeyboardEvent('keydown', { code: e.code, key: e.key, shiftKey: e.shiftKey, ctrlKey: e.ctrlKey, metaKey: e.metaKey, cancelable: true }));
      this.sync();
    } else if (e.repeat && !['ArrowLeft', 'ArrowRight'].includes(e.code)) return;
    else if (actions[e.code]) this.action(actions[e.code]);
    else if (preset) this.preset(Math.max(0, Number(e.code.slice(-1)) - 1));
    else {
      const operation = this.handle.state.isFullscreen ? this.handle.exitFullscreen() : this.handle.requestFullscreen();
      operation?.catch?.(() => this.status('浏览器未允许全屏，请使用全屏按钮'));
    }
  }
  async focusAt(x, y) {
    const ticket = this.pickTicket = (this.pickTicket || 0) + 1;
    const rect = this.surface.getBoundingClientRect();
    const hit = await this.preview.picker?.pick((x - rect.left) / rect.width, (y - rect.top) / rect.height);
    if (!hit || !this.active || ticket !== this.pickTicket) return;
    this.controls.target.set(hit.x, hit.y, hit.z);
    this.releaseTime = 0;
    this.controls.update(0); this.status('已定位旋转中心');
  }
  status(text) { this.panel.querySelector('.legacy-status').textContent = text; }
  sync() {
    this.button.classList.toggle('sse-active', this.active);
    this.button.setAttribute('aria-pressed', String(this.active));
    this.button.title = this.active ? '退出原有视角，返回环绕相机' : '原有视角操作：U 水平面、方向键调平';
    if (this.active) this.root.querySelector('.sse-orbitCamera').classList.remove('sse-active');
    else this.root.querySelector('.sse-orbitCamera').classList.toggle('sse-active', this.handle.state.cameraMode === 'orbit');
    for (const [action, value] of Object.entries({ plane: this.planeVisible, spin: this.controls.autoRotate, ortho: this.camera.isOrthographicCamera, info: !this.info.hidden })) {
      this.panel.querySelector(`[data-action="${action}"]`).setAttribute('aria-pressed', String(!!value));
    }
  }
  tick(dt) {
    if (!this.active || this.app.xr.active) return;
    this.controls.update(dt);
    const now = performance.now();
    if (this.returnHome && !this.down && !this.controls.autoRotate && this.releaseTime && now - Math.max(this.releaseTime, this.lastInteraction) > 1200) {
      const offset = this.camera.position.clone().sub(this.controls.target), distance = offset.length();
      offset.normalize();
      const rotation = new THREE.Quaternion().setFromUnitVectors(offset, this.homeDirection);
      offset.applyQuaternion(new THREE.Quaternion().slerp(rotation, 1 - Math.exp(-1.1 * dt)));
      this.camera.position.copy(this.controls.target).addScaledVector(offset, distance);
      this.controls.update(0);
      if (offset.distanceToSquared(this.homeDirection) < 1e-7) this.releaseTime = 0;
    }
    const camera = this.camera, aspect = this.surface.clientWidth / Math.max(1, this.surface.clientHeight);
    if (camera.isOrthographicCamera) { camera.left = -camera.top * aspect; camera.right = camera.top * aspect; }
    else camera.aspect = aspect;
    camera.updateProjectionMatrix(); camera.updateMatrixWorld();
    // Visual parallax affects only the rendered pose, never the control pose.
    this.renderCamera ??= camera.clone();
    if (this.renderCamera.type !== camera.type) this.renderCamera = camera.clone();
    this.renderCamera.copy(camera);
    this.parallaxOffset.lerp(this.parallax && this.inside && !this.down ? this.pointerNdc : new THREE.Vector2(), 1 - Math.exp(-5 * dt));
    const right = new THREE.Vector3().setFromMatrixColumn(camera.matrixWorld, 0);
    const up = new THREE.Vector3().setFromMatrixColumn(camera.matrixWorld, 1);
    this.renderCamera.position.addScaledVector(right, this.parallaxOffset.x * this.radius * .018);
    this.renderCamera.position.addScaledVector(up, this.parallaxOffset.y * this.radius * .018);
    this.renderCamera.rotateY(-this.parallaxOffset.x * .012); this.renderCamera.rotateX(this.parallaxOffset.y * .008);
    const p = this.renderCamera.position, q = this.renderCamera.quaternion, component = this.entity.camera;
    this.entity.setPosition(p.x, p.y, p.z);
    this.pcQuat.set(q.x, q.y, q.z, q.w); this.entity.setRotation(this.pcQuat);
    component.projection = camera.isOrthographicCamera ? 1 : 0;
    component.fov = camera.fov || this.perspectiveFov || 50; component.horizontalFov = false;
    component.orthoHeight = camera.isOrthographicCamera ? camera.top / camera.zoom : this.radius;
    component.nearClip = Math.max(.001, this.radius / 10000);
    component.farClip = Math.max(this.radius * 10, p.distanceTo(this.center) + this.radius * 4);
    if (this.planeVisible) this.grid();
    if (!this.info.hidden) {
      const format = v => v.toArray().map(n => n.toFixed(3)).join(', ');
      this.info.textContent = `${camera.isOrthographicCamera ? '正交' : '透视'}视角 · 距离 ${this.controls.getDistance().toFixed(2)}\n相机位置 ${format(toDisplay(p))}\n目标位置 ${format(toDisplay(this.controls.target))}\n相机朝上 ${format(toDisplay(this.up))}`;
    }
    this.app.renderNextFrame = true;
  }
  grid() {
    const rotation = new THREE.Quaternion().setFromUnitVectors(new THREE.Vector3(0, 1, 0), this.up);
    const point = (x, z) => new THREE.Vector3(x, 0, z).applyQuaternion(rotation).add(this.planeOrigin);
    const extent = this.radius * 2;
    for (let i = -10; i <= 10; i++) {
      const offset = i / 10 * extent;
      for (const [a, b] of [[point(-extent, offset), point(extent, offset)], [point(offset, -extent), point(offset, extent)]]) {
        this.pcStart.set(a.x, a.y, a.z); this.pcEnd.set(b.x, b.y, b.z);
        this.app.drawLine(this.pcStart, this.pcEnd, i === 0 ? this.axisColor : this.gridColor, false);
      }
    }
  }
  dispose() {
    this.active = false; this.pickTicket = (this.pickTicket || 0) + 1;
    this.controls.dispose(); this.app.off('update', this.update);
    this.handle.events.off('cameraMode:changed', this.modeChanged);
    this.cleanups.forEach(cleanup => cleanup());
    this.surface.remove(); this.button.remove(); this.panel.remove(); this.info.remove();
  }
}
