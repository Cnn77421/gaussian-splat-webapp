// SplatApp 前端：上传 → 进度 → 3D 预览。
// 只通过后端 /api/* 交互，前端可整体替换（例如你后期自己的前端）。
import { SuperSplatPreview } from './supersplat-preview.js';
import { WorkGallery } from './work-gallery.js';
import { TaskHistory, normalizeProgress, formatPercent } from './task-history.js';

const $ = (id) => document.getElementById(id);
const el = {
  health: $('health'), drop: $('drop'), file: $('file'), fileInfo: $('fileInfo'),
  plyDrop: $('plyDrop'), plyFile: $('plyFile'), plyInfo: $('plyInfo'),
  quals: $('quals'), go: $('go'), stage: $('stage'), fill: $('fill'),
  pct: $('pct'), elapsed: $('elapsed'), msg: $('msg'), log: $('log'),
  resultBlock: $('resultBlock'), stats: $('stats'), dl: $('dl'),
  viewer: $('viewer'), empty: $('empty'), modelName: $('modelName'),
  previewStatus: $('previewStatus'), presentation: $('presentation'),
  saveView: $('saveView'), restoreView: $('restoreView'), viewMessage: $('viewMessage'), previewImport: $('previewImport'),
  previewDownload: $('previewDownload'),
  retryTask: $('retryTask'), retryPrompt: $('retryPrompt'), retryFile: $('retryFile'), retryMessage: $('retryMessage'),

};

let picked = null;
let currentJobId = null;
let currentWorkId = null;
let selectionToken = 0;
let viewer = null;
let pollTimer = null;
let objectUrl = null;   // 本地 .ply 的 blob: URL，切换时释放
let viewToken = 0;      // 防止并发 openViewer 互相踩
let pollEpoch = 0;
let activePoll = null;
const progressByJob = new Map();
let taskJobs = [];
let retrySourceJob = null;
const retryBusy = new Set();
let retryEndpointAvailable = true;
const taskHistory = new TaskHistory($('taskHistory'), $('taskCount'), selectJob, retryJob);
$('tasksOpen').addEventListener('click', () => {
  setPresentation(false);
  $('taskHistory').focus();
  refreshWorks();
});

function selectJob(id) {
  ++selectionToken;
  currentWorkId = null; currentJobId = id;
  el.resultBlock.hidden = true;
  retrySourceJob = null; el.retryPrompt.hidden = true; el.retryTask.hidden = true;
  el.log.textContent = ''; el.msg.textContent = '正在读取任务…';
  el.stage.textContent = '读取中'; el.fill.style.width = '0%'; el.pct.textContent = '—'; el.elapsed.textContent = '';
  setPresentation(false);
  taskHistory.select(id);
  history.replaceState(null, '', `?job=${encodeURIComponent(id)}`);
  startPolling();
}

function trackProgress(job) {
  const normalized = normalizeProgress(job, progressByJob.get(job.id));
  progressByJob.set(job.id, normalized);
  return normalized;
}

function renderTasks() {
  taskHistory.update(taskJobs.map(job => ({ ...job, retryBusy: retryBusy.has(job.id) })), currentJobId);
}

async function retryJob(id, file = null) {
  if (retryBusy.has(id)) return;
  if (currentJobId !== id) selectJob(id);
  const ticket = selectionToken;
  retryBusy.add(id); renderTasks();
  el.retryTask.disabled = true;
  try {
    const original = taskJobs.find(job => job.id === id);
    const askForSource = () => {
      if (ticket !== selectionToken) return;
      retrySourceJob = id;
      el.retryMessage.textContent = `需要重新选择 ${original?.filename || '原素材'}。重试会沿用原质量档位，并保留此次失败记录。`;
      el.retryPrompt.hidden = false;
    };
    // Static assets update immediately, while a busy older backend must keep
    // running. Use its ordinary upload API until the retry endpoint is loaded.
    if (!retryEndpointAvailable && !file) { askForSource(); return; }
    const options = { method: 'POST', headers: {} };
    if (file) { options.body = file; options.headers['X-Filename'] = encodeURIComponent(file.name); }
    const url = retryEndpointAvailable ? `/api/jobs/retry?id=${encodeURIComponent(id)}`
      : `/api/jobs?quality=${encodeURIComponent(original?.quality || 'fast')}`;
    const response = await fetch(url, options);
    const data = await response.json();
    if (response.status === 404 && data.error === '未找到') {
      retryEndpointAvailable = false;
      if (file) throw new Error('服务刚切换，请再次点击重试并选择素材');
      askForSource(); return;
    }
    if (data.retryJobId && !response.ok) {
      if (ticket === selectionToken) selectJob(data.retryJobId);
      return;
    }
    if (data.sourceMissing && !response.ok) {
      askForSource();
      return;
    }
    if (!response.ok) throw new Error(data.error || '重试失败');
    taskJobs.unshift(trackProgress(data));
    if (ticket === selectionToken) selectJob(data.id);
    refreshWorks();
  } catch (error) {
    if (ticket === selectionToken) { el.msg.textContent = `重试失败：${error.message}`; el.msg.style.color = 'var(--err)'; }
  } finally {
    retryBusy.delete(id); renderTasks();
    if (ticket === selectionToken) el.retryTask.disabled = false;
  }
}
el.retryTask.addEventListener('click', () => { if (currentJobId) retryJob(currentJobId); });
$('retryChoose').addEventListener('click', () => el.retryFile.click());
$('retryCancel').addEventListener('click', () => { retrySourceJob = null; el.retryPrompt.hidden = true; });
el.retryFile.addEventListener('change', () => {
  const file = el.retryFile.files[0], id = retrySourceJob;
  el.retryFile.value = '';
  if (file && id) { el.retryPrompt.hidden = true; retryJob(id, file); }
});

const gallery = new WorkGallery({ dialog: $('gallery'), trigger: $('galleryOpen'), onSelect: async work => {
  const ticket = ++selectionToken;
  clearInterval(pollTimer); currentWorkId = work.id;
  if (work.local) {
    currentJobId = null;
    try {
      const file = await gallery.getFile(work.id);
      if (ticket !== selectionToken) return;
      if (!file) throw new Error('本地作品已不存在，请重新添加');
      prepareLocalPreview(); gallery.select(work.id);
      history.replaceState(null, '', `?work=${encodeURIComponent(work.id)}`);
      await openViewer({ src: URL.createObjectURL(file), label: work.filename, filename: work.filename,
        local: true, modelKey: `library:${work.id}` });
    } catch (error) { gallery.message(error.message, true); el.viewMessage.textContent = error.message; }
  } else {
    selectJob(work.id);
  }
}, onDelete: work => {
  if (currentWorkId !== work.id && currentJobId !== work.id) return;
  retrySourceJob = null; el.retryPrompt.hidden = true; el.retryTask.hidden = true;
  ++selectionToken; ++viewToken;
  const clearTask = !currentJobId || currentJobId === work.id;
  if (clearTask) { clearInterval(pollTimer); pollTimer = null; currentJobId = null; }
  currentWorkId = null;
  viewer?.dispose(); viewer = null; window.__viewer = null;
  if (objectUrl) { URL.revokeObjectURL(objectUrl); objectUrl = null; }
  const query = new URLSearchParams(location.search);
  if (query.get('job') === work.id || query.get('work') === work.id) history.replaceState(null, '', location.pathname);
  el.empty.hidden = false; el.empty.textContent = '作品已删除，选择其他作品或添加 PLY 继续预览';
  el.modelName.textContent = '等待导入模型'; el.previewStatus.textContent = '未加载';
  el.previewDownload.hidden = true; el.previewDownload.removeAttribute('href');
  el.saveView.disabled = el.restoreView.disabled = true; el.viewMessage.textContent = '';
  el.resultBlock.hidden = true; el.dl.removeAttribute('href');
  if (clearTask) { el.log.textContent = ''; el.stage.textContent = '等待开始'; el.msg.textContent = ''; el.fill.style.width = '0%'; el.pct.textContent = '0%'; el.elapsed.textContent = ''; }
} });
el.saveView.addEventListener('click', async () => {
  if (!viewer?.handle?.state.loaded) return;
  el.viewMessage.textContent = viewer.saveDefaultView() ? '已为此模型保存默认视角' : '浏览器无法保存此视角';
  if (currentWorkId) await gallery.saveCover(currentWorkId, viewer.handle).catch(() => {});
});
el.restoreView.addEventListener('click', () => {
  if (!viewer?.handle?.state.loaded) return;
  const restored = viewer.restoreDefaultView();
  if (!restored) viewer.resetDefaultView();
  el.viewMessage.textContent = restored ? '已恢复保存的默认视角' : '已恢复初始视角';
});

// ------------------------------------------------------------ 后端连接
async function readStatus(url) {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 8000);
  try {
    const response = await fetch(url, { cache: 'no-store', signal: controller.signal });
    return { response, data: await response.json() };
  } finally { clearTimeout(timeout); }
}

async function checkHealth() {
  try {
    const { response, data: h } = await readStatus('/api/health');
    const ready = response.ok && h.ok && h.runOoo;
    el.health.textContent = ready ? '后端就绪' : '后端异常';
    el.health.className = 'pill ' + (ready ? 'ok' : 'bad');
  } catch {
    el.health.textContent = '连接中断，正在重连';
    el.health.className = 'pill bad';
  }
}
checkHealth();
const healthTimer = setInterval(checkHealth, 10000);

// ------------------------------------------------------------ 选择文件
el.drop.addEventListener('click', event => {
  if (event.target !== el.file) el.file.click();
});
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
    setPresentation(false);
    const res = await fetch(`/api/jobs?quality=${quality}`, {
      method: 'POST',
      headers: { 'X-Filename': encodeURIComponent(picked.name) },
      body: picked,
    });
    const job = await res.json();
    if (!res.ok) throw new Error(job.error || '提交失败');
    selectJob(job.id);
    el.go.textContent = job.status === 'queued' ? '已提交，排队中…' : '已提交，生成中…';
    refreshWorks();
  } catch (e) {
    el.stage.textContent = '提交失败';
    el.msg.textContent = String(e.message || e);
    el.go.disabled = false;
    el.go.textContent = '开始生成';
  }
});

function startPolling() {
  clearInterval(pollTimer);
  ++pollEpoch;
  pollTimer = setInterval(poll, 1000);
  poll();
}

async function poll() {
  if (!currentJobId) return;
  const jobId = currentJobId;
  const epoch = pollEpoch;
  if (activePoll?.epoch === epoch) return;
  const request = { epoch };
  activePoll = request;
  let job;
  try {
    const { response, data } = await readStatus(`/api/job?id=${encodeURIComponent(jobId)}`);
    job = data;
    if (jobId !== currentJobId || epoch !== pollEpoch) return;
    if (!response.ok) throw new Error(job.error || '任务读取失败');
  } catch (error) {
    if (jobId === currentJobId && epoch === pollEpoch) {
      if (error instanceof TypeError || error.name === 'AbortError') {
        el.stage.textContent = '连接中断';
        el.msg.textContent = '无法连接生成服务，正在自动重连。恢复连接后会继续同步进度。';
        el.health.textContent = '连接中断，正在重连'; el.health.className = 'pill bad';
      } else el.msg.textContent = error.message;
    }
    return;
  } finally {
    if (activePoll === request) activePoll = null;
  }

  if (el.stage.textContent === '连接中断') checkHealth();
  job = trackProgress(job);
  taskJobs = taskJobs.map(item => item.id === job.id ? { ...item, ...job } : item);
  renderTasks();
  el.retryTask.hidden = job.status !== 'failed';
  el.retryTask.disabled = retryBusy.has(job.id) || Boolean(job.retryJobId);

  const queued = job.status === 'queued';
  el.stage.textContent = queued ? '排队中' : (job.stageLabel || '准备中');
  el.fill.style.width = `${job.percent || 0}%`;
  el.pct.textContent = queued ? '等待开始' : formatPercent(job.percent);
  el.msg.textContent = job.error ? `错误：${job.error}` : queued && job.queuePosition
    ? `排队第 ${job.queuePosition} 位 · ${job.message || '等待开始'}` : (job.message || '');
  el.msg.style.color = job.error ? 'var(--err)' : '';

  if (queued) {
    const seconds = Math.max(0, Math.round(Date.now() / 1000 - (job.queuedAt || job.createdAt)));
    el.elapsed.textContent = `已等待 ${String(Math.floor(seconds / 60)).padStart(2, '0')}:${String(seconds % 60).padStart(2, '0')}`;
    el.go.textContent = '已提交，排队中…';
  } else if (job.startedAt) {
    const end = job.finishedAt || (Date.now() / 1000);
    const s = Math.round(end - job.startedAt);
    el.elapsed.textContent = `已用 ${String(Math.floor(s / 60)).padStart(2, '0')}:${String(s % 60).padStart(2, '0')}`;
    if (job.status === 'running') el.go.textContent = '已提交，生成中…';
  }
  el.log.textContent = (job.log || []).slice(-80).join('\n');
  el.log.scrollTop = el.log.scrollHeight;

  if (job.status === 'done') {
    clearInterval(pollTimer);
    el.go.disabled = !picked;
    el.go.textContent = picked ? '再生成一个' : '开始生成';
    showResult(job);
  } else if (job.status === 'failed') {
    clearInterval(pollTimer);
    el.go.disabled = !picked;
    el.go.textContent = '开始生成';
    el.resultBlock.hidden = true;
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
  el.stats.replaceChildren(...rows.map(([key, value]) => {
    const row = document.createElement('div');
    const label = document.createElement('b');
    const detail = document.createElement('div');
    label.textContent = key; detail.textContent = value;
    row.append(label, detail); return row;
  }));
  el.dl.href = `/api/download?id=${job.id}`;
  el.resultBlock.hidden = false;
  loadPreview(job);
  refreshWorks(job.id);
}

// ------------------------------------------------------------ 原版预览
function setPresentation(on) {
  document.body.classList.toggle('presentation-mode', on);
  el.presentation.setAttribute('aria-pressed', String(on));
  el.presentation.textContent = on ? '展开素材与进度' : '进入展示模式';
}
el.presentation.addEventListener('click', () => {
  setPresentation(!document.body.classList.contains('presentation-mode'));
});
el.previewImport.addEventListener('click', () => el.plyFile.click());
for (const drop of [el.drop, el.plyDrop]) {
  drop.addEventListener('keydown', event => {
    if (event.target === drop && (event.key === 'Enter' || event.key === ' ')) {
      event.preventDefault(); drop.click();
    }
  });
}

async function openViewer({ src, label = '3D 模型', filename = 'scene.ply', local = false, download, modelKey = src, sourceView } = {}) {
  const token = ++viewToken;
  viewer?.dispose();
  window.__viewer = null;
  if (objectUrl) URL.revokeObjectURL(objectUrl);
  objectUrl = local ? src : null;
  el.empty.hidden = false;
  el.empty.textContent = `正在打开 ${label}…`;
  el.modelName.textContent = label;
  el.previewStatus.textContent = '加载中';
  el.previewDownload.hidden = true;
  el.saveView.disabled = el.restoreView.disabled = true;
  el.viewMessage.textContent = "";
  el.previewDownload.removeAttribute('href');
  const instance = new SuperSplatPreview({ rootElement: el.viewer });
  viewer = instance;
  // Enlarge the canvas before native startup measures its dimensions.
  setPresentation(true);
  try {
    await instance.load(src, {
      filename, modelKey, sourceView,
      onProgress: value => {
        if (token !== viewToken) return;
        el.empty.hidden = true; // The viewer owns its original loading bar.
        el.previewStatus.textContent = `加载 ${Math.round(value)}%`;
      },
    });
    if (token !== viewToken) return;
    el.empty.hidden = true;
    el.previewStatus.textContent = '可交互';
    el.previewDownload.href = download || src;
    el.previewDownload.download = filename;
    el.previewDownload.hidden = false;
    // Public handle also used by the integration verification page.
    window.__viewer = instance.handle;
    el.saveView.disabled = el.restoreView.disabled = false;
    if (modelKey.startsWith('job:') || modelKey.startsWith('library:')) gallery.saveCover(modelKey.slice(modelKey.indexOf(':') + 1), instance.handle).catch(() => {});
    return instance.handle;
  } catch (error) {
    if (token !== viewToken) return;
    viewer = null;
    window.__viewer = null;
    el.empty.hidden = false;
    el.empty.textContent = '预览加载失败：' + (error.message || error);
    el.previewStatus.textContent = '加载失败';
    if (objectUrl) { URL.revokeObjectURL(objectUrl); objectUrl = null; }
  }
}

function loadPreview(job) {
  currentWorkId = job.id;
  return openViewer({
    src: `/api/artifact?id=${encodeURIComponent(job.id)}`,
    modelKey: `job:${job.id}`,
    sourceView: job.sourceView,
    label: job.filename || '生成的模型', filename: 'final.ply',
    download: `/api/download?id=${encodeURIComponent(job.id)}`,
  });
}

// Existing completed jobs provide a one-click demonstration without retraining.
let worksToken = 0;
let gallerySignature = null;
async function refreshWorks(selectedId) {
  const ticket = ++worksToken;
  let jobs = gallery.backendJobs;
  try {
    const { response, data } = await readStatus('/api/jobs');
    if (response.ok) {
      if (ticket !== worksToken) return;
      taskJobs = (Array.isArray(data) ? data : data.jobs || []).map(trackProgress);
      renderTasks();
      jobs = taskJobs.filter(job => job.status === 'done');
      // Restore an ongoing task when opening the page without an explicit selection.
      if (!currentJobId && !currentWorkId && !selectionToken) {
        const ongoing = taskJobs.find(job => job.status === 'running') || taskJobs.find(job => job.status === 'queued');
        if (ongoing) selectJob(ongoing.id);
      }
    }
  } catch { /* Persisted local PLY remains usable when the backend is offline. */ }
  if (ticket !== worksToken) return;
  const signature = JSON.stringify((jobs || []).map(job => [job.id, job.finishedAt, job.filename]));
  if (signature !== gallerySignature) {
    gallerySignature = signature;
    await gallery.render(jobs, selectedId || currentWorkId || currentJobId);
  } else gallery.select(selectedId || currentWorkId || currentJobId);
}

refreshWorks();
const historyTimer = setInterval(refreshWorks, 3000);

// ------------------------------------------------------------ 导入本地 PLY
el.plyDrop.addEventListener('click', event => {
  if (event.target !== el.plyFile) el.plyFile.click();
});
for (const event of ['dragenter', 'dragover']) {
  el.plyDrop.addEventListener(event, ev => { ev.preventDefault(); el.plyDrop.classList.add('over'); });
}
for (const event of ['dragleave', 'drop']) {
  el.plyDrop.addEventListener(event, () => el.plyDrop.classList.remove('over'));
}
el.plyDrop.addEventListener('drop', event => {
  event.preventDefault();
  openLocalPly(event.dataTransfer.files[0]);
});
el.plyFile.addEventListener('change', () => {
  openLocalPly(el.plyFile.files[0]);
  el.plyFile.value = ''; // Allow reopening the same file after a failed load.
});
function openLocalPly(file) {
  if (!file) return;
  if (!file.name.toLowerCase().endsWith('.ply')) {
    el.plyInfo.textContent = '请选择 .ply 高斯模型文件';
    return;
  }
  el.plyInfo.textContent = `${file.name} · ${(file.size / 1048576).toFixed(1)} MB`;
  ++selectionToken; currentWorkId = null;
  prepareLocalPreview();
  return openViewer({ src: URL.createObjectURL(file), label: file.name, filename: file.name, local: true, modelKey: `file:${file.name}:${file.size}:${file.lastModified}` });
}

function prepareLocalPreview() {
  retrySourceJob = null; el.retryPrompt.hidden = true; el.retryTask.hidden = true;
  clearInterval(pollTimer);
  pollTimer = null;
  currentJobId = null;
  ++pollEpoch;
  taskHistory.select(null);
  history.replaceState(null, '', location.pathname);
  gallery.select(null);
  el.resultBlock.hidden = true;
  el.dl.removeAttribute('href');
  el.stage.textContent = '本地模型预览';
  el.msg.textContent = '未创建生成任务';
  el.msg.style.color = '';
  el.log.textContent = '';
  el.fill.style.width = '0%';
  el.pct.textContent = '—';
  el.elapsed.textContent = '';
  el.go.disabled = !picked;
  el.go.textContent = '开始生成';
}

const urlJob = new URLSearchParams(location.search).get('job');
const urlWork = new URLSearchParams(location.search).get('work');
if (urlJob) { currentWorkId = currentJobId = urlJob; startPolling(); }
else if (urlWork?.startsWith('local:')) {
  gallery.library.get(urlWork).then(work => {
    if (work && !currentWorkId && !selectionToken) gallery.onSelect(work);
    else if (!work) el.viewMessage.textContent = '本地作品已不存在，请重新添加';
  }).catch(error => { el.viewMessage.textContent = error.message; });
}
window.addEventListener('pagehide', () => {
  ++viewToken;
  gallery.dispose();
  viewer?.dispose();
  if (objectUrl) URL.revokeObjectURL(objectUrl);
  clearInterval(pollTimer);
  ++pollEpoch;
  clearInterval(historyTimer);
  clearInterval(healthTimer);
});
export { openViewer, openLocalPly };
