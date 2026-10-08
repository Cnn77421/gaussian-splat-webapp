// SplatApp 前端：上传 → 进度 → 3D 预览。
// 只通过后端 /api/* 交互，前端可整体替换（例如你后期自己的前端）。
import * as THREE from 'three';
import { SparkViewer, isEditingKey } from './spark-viewer.js';
import { Pane } from 'tweakpane';

const $ = (id) => document.getElementById(id);
const el = {
  health: $('health'), drop: $('drop'), file: $('file'), fileInfo: $('fileInfo'),
  plyDrop: $('plyDrop'), plyFile: $('plyFile'), plyInfo: $('plyInfo'),
  quals: $('quals'), go: $('go'), stage: $('stage'), fill: $('fill'),
  pct: $('pct'), elapsed: $('elapsed'), msg: $('msg'), log: $('log'),
  resultBlock: $('resultBlock'), stats: $('stats'), dl: $('dl'),
  viewer: $('viewer'), viewerPanel: $('viewerPanel'), empty: $('empty'), camFull: $('camFull'),
  fsControls: $('fsControls'),
  camReadout: $('camReadout'), camSpin: $('camSpin'), camReset: $('camReset'),
  camPlaneSave: $('camPlaneSave'), camPlaneReset: $('camPlaneReset'), camPlaneState: $('camPlaneState'),
  camHome: $('camHome'), camParallax: $('camParallax'), fxPane: $('fxPane'),
  fxHint: $('fxHint'), fxEnabled: $('fxEnabled'), fxState: $('fxState'),
};

let picked = null;
let currentJobId = null;
let viewer = null;
let pollTimer = null;
let objectUrl = null;   // 本地 .ply 的 blob: URL，切换时释放
let viewToken = 0;      // 防止并发 openViewer 互相踩

// ------------------------------------------------------------ 后端健康
fetch('/api/health').then((r) => r.json()).then((h) => {
  el.health.textContent = h.ok && h.runOoo ? '后端就绪' : '后端异常';
  el.health.className = 'pill ' + (h.ok && h.runOoo ? 'ok' : 'bad');
}).catch(() => {
  el.health.textContent = '后端不可达';
  el.health.className = 'pill bad';
});

// ------------------------------------------------------------ 选择文件
el.drop.addEventListener('click', () => el.file.click());
['dragenter', 'dragover'].forEach((e) =>
  el.drop.addEventListener(e, (ev) => { ev.preventDefault(); el.drop.classList.add('over'); }));
['dragleave', 'drop'].forEach((e) =>
  el.drop.addEventListener(e, () => el.drop.classList.remove('over')));
el.drop.addEventListener('drop', (ev) => {
  ev.preventDefault();
  if (ev.dataTransfer.files.length) setFile(ev.dataTransfer.files[0]);
});
el.file.addEventListener('change', () => {
  if (el.file.files.length) setFile(el.file.files[0]);
});

function setFile(f) {
  picked = f;
  const mb = (f.size / 1048576).toFixed(1);
  el.fileInfo.textContent = `${f.name} · ${mb} MB`;
  el.go.disabled = false;
}

// ------------------------------------------------------------ 开始生成
el.go.addEventListener('click', async () => {
  if (!picked) return;
  const quality = document.querySelector('input[name=q]:checked').value;
  el.go.disabled = true;
  el.go.textContent = '上传中…';
  el.log.textContent = '';
  el.resultBlock.hidden = true;

  try {
    const res = await fetch(`/api/jobs?quality=${quality}`, {
      method: 'POST',
      headers: { 'X-Filename': encodeURIComponent(picked.name) },
      body: picked,
    });
    const job = await res.json();
    if (!res.ok) throw new Error(job.error || '提交失败');
    currentJobId = job.id;
    history.replaceState(null, '', `?job=${job.id}`);
    el.go.textContent = '已提交，生成中…';
    startPolling();
  } catch (e) {
    el.stage.textContent = '提交失败';
    el.msg.textContent = String(e.message || e);
    el.go.disabled = false;
    el.go.textContent = '开始生成';
  }
});

function startPolling() {
  clearInterval(pollTimer);
  pollTimer = setInterval(poll, 1000);
  poll();
}

async function poll() {
  if (!currentJobId) return;
  let job;
  try {
    job = await (await fetch(`/api/job?id=${currentJobId}`)).json();
  } catch { return; }

  el.stage.textContent = job.stageLabel || '准备中';
  el.fill.style.width = `${job.percent || 0}%`;
  el.pct.textContent = `${(job.percent || 0).toFixed(0)}%`;
  el.msg.textContent = job.error ? `错误：${job.error}` : (job.message || '');
  el.msg.style.color = job.error ? 'var(--err)' : '';

  if (job.startedAt) {
    const end = job.finishedAt || (Date.now() / 1000);
    const s = Math.round(end - job.startedAt);
    el.elapsed.textContent = `已用 ${String(Math.floor(s / 60)).padStart(2, '0')}:${String(s % 60).padStart(2, '0')}`;
  }
  el.log.textContent = (job.log || []).slice(-80).join('\n');
  el.log.scrollTop = el.log.scrollHeight;

  if (job.status === 'done') {
    clearInterval(pollTimer);
    el.go.disabled = false;
    el.go.textContent = '再生成一个';
    showResult(job);
  } else if (job.status === 'failed') {
    clearInterval(pollTimer);
    el.go.disabled = false;
    el.go.textContent = '重试';
  }
}

// ------------------------------------------------------------ 结果与预览
function showResult(job) {
  const s = job.stats || {};
  el.msg.textContent = s.warning ? `质量提示：${s.warning}` : (job.message || '全部处理完成');
  el.msg.style.color = s.warning ? 'var(--warn)' : '';
  const rows = [
    ['任务 ID', job.projectId || '-'],
    ['生成耗时', s.durationMs ? `${(s.durationMs / 1000).toFixed(1)} 秒` : '-'],
    ['Splat 数量', s.splatCount ? s.splatCount.toLocaleString() : '-'],
    ['文件大小', s.fileSize ? `${(s.fileSize / 1048576).toFixed(1)} MB` : '-'],
    ['输入画面', s.inputImages != null ? `${s.registeredImages}/${s.inputImages} 注册` : '-'],
    ['稀疏点云', s.points3d ? s.points3d.toLocaleString() : '-'],
  ];
  el.stats.innerHTML = rows
    .map(([k, v]) => `<div><b>${k}</b><div>${v}</div></div>`).join('');
  el.dl.href = `/api/download?id=${job.id}`;
  el.resultBlock.hidden = false;
  loadPreview(job.id);
}

// ------------------------------------------------------------ 3D 预览
// 预设视角 = 相机相对模型中心的方向向量（世界系）。
// 世界 up = −Y：COLMAP images.bin 54 张注册图实测图像 up 世界均值 (0.04, −0.81, −0.19)，
// 故「高处/俯视」= −Y 方向，「上方」预设必须用 −Y（用 +Y 会跑到场景下方）。
// 源机位真值 = 稳健中心→平均相机光心 = (0.331, −0.299, −0.895)
//（实测 az=atan2(−d.x, d.z)=−160°、po=acos(−d.y)=73°；与本文件预设一致）。
const VIEW_PRESETS = {
  source: [0.331, -0.299, -0.895],  // 源拍摄机位：−Z 侧偏 +X，略高于场景
  front:  [0, -0.30, -1],
  left:   [-1, -0.30, 0],
  right:  [1, -0.30, 0],
  top:    [0, -1, 1e-3],            // 不能传严格 [0,−1,0]：与 lookAt 的 up 平行会退化
  back:   [0, -0.30, 1],
};
const DEFAULT_VIEW = 'source';

// --------------------------------------------------------- 默认视角平面
// 视角平面 = 相机基准「朝上」矢量（世界系），平面姿态由它 + 环绕中心完全决定。
// 用户按 ← / → 倾斜对准后保存，跨会话存在 localStorage（单个 [x,y,z] 数组）。
const VIEW_PLANE_KEY = 'splat.viewPlaneUp';
const WORLD_UP = new THREE.Vector3(0, -1, 0);
let savedViewPlaneUp = null;

function readStoredViewPlane() {
  try {
    const raw = JSON.parse(localStorage.getItem(VIEW_PLANE_KEY) || 'null');
    if (!Array.isArray(raw) || raw.length !== 3 || !raw.every(Number.isFinite)) return null;
    const up = new THREE.Vector3(...raw);
    return up.lengthSq() > 1e-12 ? up.normalize() : null;
  } catch { return null; }   // 无痕模式 / 损坏值：回退默认
}

function writeStoredViewPlane(up) {
  try {
    localStorage.setItem(VIEW_PLANE_KEY, JSON.stringify(up.toArray()));
    return true;
  } catch { return false; }
}

function clearStoredViewPlane() {
  try { localStorage.removeItem(VIEW_PLANE_KEY); } catch { /* 无痕模式忽略 */ }
}

// 套用到相机的平面矢量（调用方拿到的是副本，可安全改写）
function planeUp() { return (savedViewPlaneUp || WORLD_UP).clone(); }

function syncViewPlane() {
  const saved = !!savedViewPlaneUp;
  el.camPlaneState.textContent = saved ? '已保存' : '默认';
  el.camPlaneState.classList.toggle('on', saved);
  el.camPlaneSave.disabled = !viewer;
  el.camPlaneReset.disabled = !saved;
}

function saveDefaultViewPlane() {
  if (!viewer) return;
  savedViewPlaneUp = viewer.camera.up.clone();
  if (!writeStoredViewPlane(savedViewPlaneUp)) savedViewPlaneUp = readStoredViewPlane();
  viewer.setViewPlane(savedViewPlaneUp);
  syncViewPlane();
}

function resetDefaultViewPlane() {
  clearStoredViewPlane();
  savedViewPlaneUp = null;
  viewer?.resetViewPlane();
  syncViewPlane();
}

async function openViewer({ src, label = '', local = false, intro = false } = {}) {
  const token = ++viewToken;
  el.empty.textContent = label ? `正在加载 ${label}…` : '正在加载模型…';
  el.empty.style.display = 'flex';
  el.camReadout.textContent = '--';

  setEffectsReady(false);
  // Also dispose a viewer whose model is still loading during rapid switches.
  if (loadingViewer) {
    const old = loadingViewer; loadingViewer = null;
    await old.dispose();
  }
  if (viewer) {
    const old = viewer;
    viewer = null;
    await old.dispose();
  }
  if (token !== viewToken) { if (local) URL.revokeObjectURL(src); return; }
  if (objectUrl) { URL.revokeObjectURL(objectUrl); objectUrl = null; }
  if (local) objectUrl = src;

  let v;
  try {
    v = new SparkViewer({ rootElement: el.viewer });
    loadingViewer = v;
    await v.addSplatScene(src, {
      intro,
      onProgress: p => {
        if (token === viewToken) el.empty.textContent = `加载模型 ${Math.round(p * 100)}%`;
      },
    });
  } catch (e) {
    await v?.dispose();
    if (loadingViewer === v) loadingViewer = null;
    if (token !== viewToken) return;
    el.empty.textContent = '预览加载失败：' + (e.message || e);
    console.error(e);
    return;
  }
  if (token !== viewToken || v.disposed) {
    await v.dispose();
    return;
  }
  if (loadingViewer === v) loadingViewer = null;

  viewer = v;
  window.__viewer = v;   // 便于调试/集成检查
  v.start();
  el.empty.style.display = 'none';
  applyView(DEFAULT_VIEW);
  v.controls.addEventListener('change', updateCamReadout);
  updateCamReadout();
  syncEffects();
  setEffectsReady(true);
  syncViewPlane();
  updateFxHint();
}

function loadPreview(jobId) {
  openViewer({ src: `/api/artifact?id=${jobId}`, intro: true });
}

// SparkViewer computes a robust 1–99% model bound once per load.
let loadingViewer = null;
function modelBounds() {
  return viewer?.bounds || { center: new THREE.Vector3(), radius: 3 };
}

// 粒子形变面板：状态由本地 FX_DEFAULTS 持有，Tweakpane 只当视图。
// 默认值对齐 splat-effects.js 的 dyno 初值（strength 0.65 / radius 0.28 / 叠加微动关），
// 模式默认「局部排斥」（README「粒子模式」一节的默认说明）。
const FX_INIT = { mode: '1', strength: 0.65, radius: 0.28, ambient: false };
const FX_DEFAULTS = { ...FX_INIT };
const FX_HINTS = {
  0: '模型保持原状。点击画面可触发波纹。',
  1: '鼠标靠近时局部排斥，移开后平滑回归；拖拽只旋转视角。',
  2: '鼠标附近的粒子向中心吸附，移开后回归。',
  3: '粒子沿鼠标周围流动，移开后回归。',
  4: '按住拖拽，鼠标附近的粒子随速度甩动；松手后回归。',
  5: '模型随高度缓慢扭转。',
  6: '鼠标附近形成局部涡旋。',
  7: '模型轻微呼吸起伏。',
  8: '连续空间扰动，让模型保持微小动态。',
  9: '点击模型局部爆散，随后回归；拖拽只旋转视角。',
  10: '点击模型，从点击位置扩散波纹。',
};
// 0–10 与 FX_HINTS 同序；9/10 是点击脉冲，其余是连续形变。
const FX_MODES = Object.entries(FX_HINTS).map(([value, text]) => ({ value, text }));
const FX_DISABLED_HINT =
  '粒子特效已关闭：形变、微动、点击爆散和波纹均停止。开启后恢复原来的模式与参数。';

let pane = null;

function updateFxHint() {
  el.fxState.textContent = el.fxEnabled.checked ? '已开启' : '已关闭';
  el.fxHint.textContent = el.fxEnabled.checked
    ? (FX_HINTS[FX_DEFAULTS.mode] ?? '')
    : FX_DISABLED_HINT;
}

// 面板建好后一次性接线；change 事件在这里手工分派回本地状态。
// 不能依赖任何 DOM 查询：数值输入的同步由 Tweakpane 自己的 Value Binding 负责。
function buildFxPane() {
  pane = new Pane({ container: el.fxPane, title: '粒子形变' });
  // 根视图默认带一个折叠标题按钮，这里由 details 的 summary 担任标题。
  const header = pane.element.querySelector('.tp-rotv_b');
  if (header) header.style.display = 'none';

  pane.addBinding(FX_DEFAULTS, 'mode', {
    label: '模式',
    options: FX_MODES,
    index: 0,
  });
  pane.addBinding(FX_DEFAULTS, 'strength', {
    label: '强度',
    min: 0,
    max: 2,
    step: 0.01,
  });
  pane.addBinding(FX_DEFAULTS, 'radius', {
    label: '范围',
    min: 0.02,
    max: 1.2,
    step: 0.01,
  });
  pane.addBinding(FX_DEFAULTS, 'ambient', { label: '叠加微动' });

  // 「恢复原状」无条件可用：强度/范围/微动与模式都可能偏离初值（与 X 快捷键一致）。
  const reset = pane.addButton({ title: '恢复原状' });
  const explode = pane.addButton({ title: '爆散脉冲' });
  const ripple = pane.addButton({ title: '波纹脉冲' });

  pane.on('change', (ev) => {
    const key = ev.target?.key;
    if (key !== 'mode' && key !== 'strength' && key !== 'radius' && key !== 'ambient') return;
    const value = key === 'mode' ? String(ev.value)
      : key === 'ambient' ? !!ev.value : Number(ev.value);
    // Tweakpane 已先写入绑定对象；相等不表示 GPU 参数已经同步。
    FX_DEFAULTS[key] = value;
    // 禁用期间（无模型/总开关关闭）只记录选择，不写进不存在的 effects。
    if (!viewer?.effects) return;
    syncEffects();
    updateFxHint();
  });

  explode.on('click', () => viewer?.pulse('explosion'));
  ripple.on('click', () => viewer?.pulse('ripple'));
  reset.on('click', resetFxControls);
}

// 「恢复原状」同时服务于面板按钮和 X 快捷键：回到初值并清掉脉冲残留。
function resetFxControls() {
  Object.assign(FX_DEFAULTS, FX_INIT);
  pane?.refresh();   // 把 FX_DEFAULTS 的新值读回视图，不触发写回
  viewer?.effects.reset();
  syncEffects();
  updateFxHint();

}

function setEffectsReady(ready) {
  // 总开关关闭时禁用整个参数面板（Tweakpane 的 disabled 会向子 blade 级联）。
  if (pane) pane.disabled = !ready || !el.fxEnabled.checked;
  [el.fxEnabled, el.camHome, el.camParallax, el.camPlaneSave, el.camPlaneReset]
    .forEach(control => { control.disabled = !ready; });
}
function syncEffects() {
  const effects = viewer?.effects;
  if (!effects) return;
  effects.setEnabled(el.fxEnabled.checked);
  effects.setMode(FX_DEFAULTS.mode);
  effects.setStrength(FX_DEFAULTS.strength);
  effects.setRadius(FX_DEFAULTS.radius);
  effects.setAmbient(FX_DEFAULTS.ambient);
  viewer.returnHome = el.camHome.checked;
  viewer.parallax = el.camParallax.checked;
}
buildFxPane();
// 相机选项仍是页面里的原生控件，单独接线。
[el.camHome, el.camParallax]
  .forEach(control => control.addEventListener('input', () => { syncEffects(); updateFxHint(); }));
el.fxEnabled.addEventListener('input', () => {
  syncEffects(); setEffectsReady(!!viewer?.effects); updateFxHint();
});
setEffectsReady(false);
updateFxHint();

// 把相机放到 center + dir·dist，并同步 OrbitControls 的 target
function applyView(nameOrDir, { distScale = 1 } = {}) {
  if (!viewer || !viewer.camera) return;
  if (viewer.intro?.phase === 'running') return;
  const dir = typeof nameOrDir === 'string'
    ? new THREE.Vector3(...(VIEW_PRESETS[nameOrDir] || VIEW_PRESETS[DEFAULT_VIEW]))
    : nameOrDir.clone();
  const { center, radius } = modelBounds();
  const cam = viewer.camera;
  viewer.clearDamping();
  viewer.setViewPlane(planeUp());   // 世界 up 默认 −Y，可被用户保存的默认视角平面覆盖
  cam.position.copy(center).addScaledVector(dir.normalize(), radius * 2.2 * distScale);
  cam.lookAt(center);
  cam.updateProjectionMatrix();
  const c = viewer.controls;
  if (c) {
    c.target.copy(center);
    c.update();
    viewer.captureHome();
  }
  viewer.forceRenderNextFrame && viewer.forceRenderNextFrame();
}

function updateCamReadout() {
  const c = viewer && viewer.controls;
  if (!c) return;
  const az = THREE.MathUtils.radToDeg(c.getAzimuthalAngle());
  const po = THREE.MathUtils.radToDeg(c.getPolarAngle());
  el.camReadout.textContent =
    `方位 ${az.toFixed(0)}° · 俯仰 ${po.toFixed(0)}° · 距离 ${c.getDistance().toFixed(1)}`;
  el.camSpin.classList.toggle('on', !!c.autoRotate);
}

function toggleSpin() {
  if (viewer?.intro?.active) return;
  const c = viewer && viewer.controls;
  if (!c) return;
  c.autoRotate = !c.autoRotate;
  updateCamReadout();
}

function setView(name) {
  applyView(name);
  document.querySelectorAll('.cbtn[data-view]').forEach((b) =>
    b.classList.toggle('on', b.dataset.view === name));
}

document.querySelectorAll('.cbtn[data-view]').forEach((btn) =>
  btn.addEventListener('click', () => setView(btn.dataset.view)));
el.camReset.addEventListener('click', () => setView(DEFAULT_VIEW));
el.camSpin.addEventListener('click', toggleSpin);
el.camPlaneSave.addEventListener('click', saveDefaultViewPlane);
el.camPlaneReset.addEventListener('click', resetDefaultViewPlane);
// --------------------------------------------------------- 3D 视窗全屏
// 只把中间预览放大到全屏：相机、粒子特效和模型快捷键都保留，Esc 由浏览器直接退出。
const fullscreenSupported = !!(document.fullscreenEnabled ?? document.webkitFullscreenEnabled);
const fullscreenElement = () => document.fullscreenElement || document.webkitFullscreenElement;

function syncFullscreen() {
  const on = fullscreenElement() === el.viewerPanel;
  document.body.classList.toggle('has-fullscreen', on);
  el.camFull.classList.toggle('on', on);
  el.camFull.textContent = on ? '退出全屏' : '全屏';
  el.camFull.title = on ? '退出 3D 视窗全屏（快捷键 F / Esc）' : '3D 视窗全屏（快捷键 F）：只放大中间视窗，视角、粒子特效和快捷键保持可用；Esc 或再按一次 F 退出';
  el.fsControls.hidden = !on;
  if (!on) {
    el.viewerPanel.querySelector('.viewer-toolbar').classList.remove('expanded');
    el.fsControls.textContent = '控制';
  }
  // 全屏时布局从三栏变单栏，容器尺寸变化由 SparkViewer 的 ResizeObserver 接住
  requestAnimationFrame(() => viewer?.resize());
}

function toggleFullscreen() {
  if (!fullscreenSupported) return;
  if (fullscreenElement() === el.viewerPanel) {
    const exit = document.exitFullscreen || document.webkitExitFullscreen;
    exit?.call(document)?.catch?.(() => {});
  } else {
    const request = el.viewerPanel.requestFullscreen || el.viewerPanel.webkitRequestFullscreen;
    request?.call(el.viewerPanel, { navigationUI: 'hide' })?.catch?.(() => {});
  }
}

el.camFull.disabled = !fullscreenSupported;
el.camFull.addEventListener('click', toggleFullscreen);
for (const event of ['fullscreenchange', 'webkitfullscreenchange']) {
  document.addEventListener(event, syncFullscreen);
}
// 全屏时工具栏收成浮层：用这个按钮临时展开调节，画面不被挤压
el.fsControls.addEventListener('click', () => {
  const toolbar = el.viewerPanel.querySelector('.viewer-toolbar');
  const expanded = toolbar.classList.toggle('expanded');
  el.fsControls.textContent = expanded ? '收起工具' : '控制';
});

// 1–6 切换视角，0 回到源视角，R 环绕，X 恢复原状。
const VIEW_KEYS = {
  Digit1: 'source', Digit2: 'front', Digit3: 'left',
  Digit4: 'right', Digit5: 'top', Digit6: 'back', Digit0: 'source',
};
window.addEventListener('keydown', (ev) => {
  if (ev.defaultPrevented || ev.isComposing || ev.altKey || ev.ctrlKey || ev.metaKey ||
      isEditingKey(ev)) return;
  if (VIEW_KEYS[ev.code]) { setView(VIEW_KEYS[ev.code]); ev.preventDefault(); }
  else if (ev.code === 'KeyR') { toggleSpin(); ev.preventDefault(); }
  else if (ev.code === 'KeyU' && ev.shiftKey) { saveDefaultViewPlane(); ev.preventDefault(); }
  else if (ev.code === 'KeyX') { resetFxControls(); ev.preventDefault(); }
  else if (ev.code === 'KeyF' && !ev.shiftKey) { toggleFullscreen(); ev.preventDefault(); }
});
// 初始化已保存的默认视角平面（无保存值时为世界 −Y 朝上）
savedViewPlaneUp = readStoredViewPlane();
syncViewPlane();

// 支持 ?job=<id> 直接恢复任务（刷新页面不丢进度）
const urlJob = new URLSearchParams(location.search).get('job');
if (urlJob) { currentJobId = urlJob; startPolling(); }

// ------------------------------------------------------------ 导入本地 .ply
el.plyDrop.addEventListener('click', () => el.plyFile.click());
['dragenter', 'dragover'].forEach((e) =>
  el.plyDrop.addEventListener(e, (ev) => { ev.preventDefault(); el.plyDrop.classList.add('over'); }));
['dragleave', 'drop'].forEach((e) =>
  el.plyDrop.addEventListener(e, () => el.plyDrop.classList.remove('over')));
el.plyDrop.addEventListener('drop', (ev) => {
  ev.preventDefault();
  if (ev.dataTransfer.files.length) openLocalPly(ev.dataTransfer.files[0]);
});
el.plyFile.addEventListener('change', () => {
  if (el.plyFile.files.length) openLocalPly(el.plyFile.files[0]);
});

function openLocalPly(file) {
  if (!file) return;
  const mb = (file.size / 1048576).toFixed(1);
  el.plyInfo.textContent = `${file.name} · ${mb} MB`;
  // 本地导入与后端任务解耦：停掉轮询、清掉下载入口，避免把本地模型当后端结果
  clearInterval(pollTimer);
  pollTimer = null;
  currentJobId = null;
  el.resultBlock.hidden = true;
  el.dl.removeAttribute('href');
  openViewer({ src: URL.createObjectURL(file), label: file.name, local: true, intro: true });
}

// Allows the browser integration check to exercise rapid model replacements.
export { openViewer };
