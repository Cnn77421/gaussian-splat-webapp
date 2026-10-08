import { ParticleEffects } from './particle-effects.js';
import { LegacyViewControls } from './legacy-view-controls.js';
import { ViewPreferences, poseValid, vectorValid } from './view-preferences.js';
import { calculateModelView, nativeCameraPose } from './model-view.js';

// Native rendering and modes; the host adapter exposes upstream camera snapshots.
let viewerModule;
const abortError = () => new DOMException('模型加载已取消', 'AbortError');

// Brush/COLMAP exports contain distant floaters. Quantile bounds frame the
// subject without rewriting a single splat; native fit/reset then use this same
// customAabb. Sample decoded positions once, not a second copy of the PLY bytes.
function subjectBounds(resource) {
  const data = resource?.gsplatData;
  const props = ['x', 'y', 'z'].map(name => data?.getProp?.(name));
  if (props.some(prop => !prop?.length)) return null;
  const samples = [[], [], []];
  const stride = Math.max(1, Math.floor(props[0].length / 12000));
  for (let i = 0; i < props[0].length; i += stride) {
    if (props.every(prop => Number.isFinite(prop[i]))) {
      props.forEach((prop, axis) => samples[axis].push(prop[i]));
    }
  }
  if (!samples[0].length) return null;
  const box = resource.aabb.clone();
  const center = [], half = [];
  samples.forEach((values, axis) => {
    values.sort((a, b) => a - b);
    const low = values[Math.floor((values.length - 1) * 0.01)];
    const high = values[Math.floor((values.length - 1) * 0.99)];
    center.push((low + high) / 2);
    half.push(Math.max((high - low) * 0.55, 0.01));
  });
  box.center.set(...center); box.halfExtents.set(...half);
  return box;
}

export class SuperSplatPreview {
  constructor({ rootElement }) {
    this.root = document.createElement('div');
    this.root.className = 'supersplat-slot';
    this.root.tabIndex = 0;
    rootElement.appendChild(this.root);
    this.abort = new AbortController();
    this.disposed = false;
    this.handle = null;
  }

  async load(src, { filename = 'scene.ply', settings, modelKey = src, sourceView, auxiliary = false, onProgress = () => {} } = {}) {
    // No URL suffix on blob: URLs or /api/artifact. Name the asset explicitly so
    // the original viewer chooses its PLY parser in both cases.
    this.preferences = new ViewPreferences(modelKey);
    this.modelKey = modelKey;
    const delivery = new Promise(resolve => { this.releaseContents = resolve; });
    const contents = fetch(src, { signal: this.abort.signal }).then(async response => {
      if (!response.ok) throw new Error(`模型读取失败（HTTP ${response.status}）`);
      // Install the host's load/error hooks before the engine starts parsing.
      // A tiny blob can otherwise finish before createViewer resolves.
      await delivery;
      return response;
    });
    // Observe a fetch failure immediately, including while the module or GPU
    // device is still initializing. The engine consumes the same response once.
    let fetchError;
    contents.catch(error => { fetchError = error; this.fail?.(error); });
    try {
      viewerModule ??= import('./vendor/supersplat/host-viewer.js');
      const { createViewer } = await viewerModule;
      if (this.disposed) throw abortError();
      const experience = settings ?? {
          version: 2, tonemapping: 'none', highPrecisionRendering: false,
          background: { color: [0.02, 0.025, 0.03] },
          cameras: [], annotations: [], animTracks: [], startMode: 'default',
          postEffectSettings: {
            sharpness: { enabled: false, amount: 0 },
            bloom: { enabled: false, intensity: 0.1, blurLevel: 2 },
            grading: { enabled: false, brightness: 1, contrast: 1, saturation: 1, tint: [1, 1, 1] },
            vignette: { enabled: false, intensity: 0.5, inner: 0.3, outer: 0.75, curvature: 1 },
            fringing: { enabled: false, intensity: 0.5 },
          },
      };
      this.handle = await createViewer({
        container: this.root, contentUrl: src, contentFilename: filename,
        // Use the same renderer on HTTPS and localhost. WebGPU's per-frame
        // GPU sort can change blending order for equal-depth splats; WebGL2
        // uses the stable CPU sorter while retaining GPU rasterization.
        renderer: 'webgl',
        // Compensate opacity when a splat becomes sub-pixel during movement,
        // reducing sparkle and brightness popping on different screen sizes.
        aa: true,
        contents, lang: 'zh-CN', settings: experience, noanim: !settings,
      });
      if (this.disposed) { this.handle.destroy(); throw abortError(); }
      // Keyboard listeners in the official viewer are window-wide. Host file,
      // quality and gallery controls must retain their native keyboard behavior.
      this.onFocus = event => {
        const inViewer = this.root.contains(event.target);
        this.handle.state.inputEnabled = !this.legacy?.active && (inViewer || !event.target.closest?.('input, select, textarea, button, a, [contenteditable]'));
      };
      this.onPointer = event => {
        if (event.target.tagName === 'CANVAS') this.root.focus({ preventScroll: true });
      };
      if (!auxiliary) {
        document.addEventListener('focusin', this.onFocus);
        this.root.addEventListener('pointerdown', this.onPointer);
        this.onFocus({ target: document.activeElement });
      } else this.handle.state.inputEnabled = false;
      await new Promise((resolve, reject) => {
        const handle = this.handle;
        const cleanup = () => {
          handle.events.off('loaded:changed', loaded);
          handle.events.off('progress:changed', progress);
          handle.app.assets.off('error', error);
          handle.app.root.off('childinsert', frameSubject);
          this.fail = null;
        };
        const loaded = value => { if (value) { cleanup(); resolve(); } };
        const progress = value => onProgress(value);
        const error = value => { cleanup(); reject(new Error(String(value?.message || value))); };
        const frameSubject = entity => {
          if (settings || !entity.gsplat) return;
          const box = subjectBounds(entity.gsplat.resource);
          if (!box) return;
          entity.gsplat.customAabb = box;
          this.subjectBounds = box;
          // The official viewer rotates PLY entities 180 degrees around Z.
          const aspect = this.root.clientWidth / Math.max(1, this.root.clientHeight);
          this.modelView = calculateModelView(entity.gsplat.resource, box, { sourceView, aspect });
          experience.cameras.push({ initial: {
            position: this.modelView.position, target: this.modelView.target,
            fov: aspect > 1 ? 2 * Math.atan(Math.tan(this.modelView.fov * Math.PI / 360) * aspect) * 180 / Math.PI : this.modelView.fov,
          } });
        };
        this.fail = error;
        handle.events.on('loaded:changed', loaded);
        handle.events.on('progress:changed', progress);
        handle.app.assets.on('error', error);
        handle.app.root.on('childinsert', frameSubject);
        handle.events.once('picker:ready', picker => { this.picker = picker; });
        this.releaseContents();
        onProgress(handle.state.progress);
        // A small local asset can finish before createViewer's promise resolves.
        const failed = handle.app.assets.list().find(asset => asset.type === 'gsplat' && asset.loaded && !asset.resource);
        if (fetchError || failed) error(fetchError || 'PLY 格式无法解析');
        else loaded(handle.state.loaded);
      });
      if (this.modelView) {
        const camera = this.handle.app.root.findByName('camera');
        this.handle.setCameraState(nativeCameraPose(this.modelView, camera.getRotation().clone(), this.root.clientWidth / Math.max(1, this.root.clientHeight)));
      }
      this.initialPose = this.handle.getCameraState();
      if (auxiliary) {
        const pose = this.preferences.read().pose;
        if (poseValid(pose)) this.handle.setCameraState({ ...pose, mode: 'orbit' });
        return this.handle;
      }
      this.legacy = new LegacyViewControls(this);
      if (!this.restoreDefaultView() && vectorValid(this.preferences.read().up) && Math.hypot(...this.preferences.read().up) > 1e-6) {
        const wasActive = this.legacy.active;
        this.legacy.enter(); this.legacy.setUp(this.legacy.up.fromArray(this.preferences.read().up));
        this.legacy.controls.update(0); this.legacy.tick(0);
        if (!wasActive) this.legacy.exit('orbit');
      }
      this.effects = new ParticleEffects(this);
      return this.handle;
    } catch (error) {
      this.dispose();
      throw error;
    }
  }

  cameraSnapshot() {
    if (this.legacy?.active) return this.legacy.snapshot();
    const pose = this.handle.getCameraState();
    return { ...pose, mode: ['orbit', 'fly'].includes(pose.mode) ? pose.mode : 'orbit' };
  }
  saveDefaultView() {
    return this.preferences.set({ pose: this.cameraSnapshot() });
  }
  restoreDefaultView() {
    const pose = this.preferences.read().pose;
    if (!poseValid(pose)) return false;
    this.legacy.exit(pose.mode === 'legacy' ? 'orbit' : pose.mode);
    this.handle.setCameraState({ ...pose, mode: pose.mode === 'legacy' ? 'orbit' : pose.mode });
    if (pose.mode === 'legacy') {
      this.legacy.enter();
      if (Array.isArray(pose.up) && pose.up.length === 3 && pose.up.every(Number.isFinite)) this.legacy.setUp(this.legacy.up.fromArray(pose.up));
      if (Array.isArray(pose.target) && pose.target.length === 3 && pose.target.every(Number.isFinite)) this.legacy.controls.target.fromArray(pose.target);
      if (Number.isFinite(pose.ortho) && pose.ortho > 0) { this.legacy.orthographic(true); this.legacy.camera.top = pose.ortho; this.legacy.camera.bottom = -pose.ortho; }
      this.legacy.controls.update(0); this.legacy.tick(0);
    }
    return true;
  }
  resetDefaultView() {
    this.preferences.set({ pose: null });
    this.legacy.exit('orbit');
    this.handle.setCameraState(this.initialPose);
  }

  dispose() {
    if (this.disposed) return;
    this.disposed = true;
    this.abort.abort();
    this.releaseContents?.();
    this.fail?.(abortError());
    this.effects?.dispose();
    this.legacy?.dispose();
    document.removeEventListener('focusin', this.onFocus);
    this.root.removeEventListener('pointerdown', this.onPointer);
    this.handle?.destroy();
    this.root.remove();
  }
}
