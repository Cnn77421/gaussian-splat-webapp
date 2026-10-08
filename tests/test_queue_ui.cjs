// Exercise the actual page's polling logic with queued/running/failed API replies.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const elements = new Map();
function node() {
  return {
    textContent: '', style: {}, dataset: {}, children: [], attributes: {}, disabled: true,
    addEventListener(name, callback) { (this.listeners ||= {})[name] = callback; },
    removeAttribute(name) { delete this.attributes[name]; },
    setAttribute(name, value) { this.attributes[name] = value; },
    append(...children) { for (const child of children) { child.parent = this; this.children.push(child); } },
    insertBefore(child, before) {
      child.remove(); child.parent = this;
      const index = this.children.indexOf(before);
      this.children.splice(index < 0 ? this.children.length : index, 0, child);
    },
    remove() { if (this.parent) this.parent.children.splice(this.parent.children.indexOf(this), 1); this.parent = null; },
    querySelector() { return this.children.find(child => 'taskEmpty' in child.dataset) || null; },
    classList: { add() {}, remove() {}, toggle() {}, contains() { return false; } },
  };
}
function element(id) {
  if (!elements.has(id)) elements.set(id, node());
  return elements.get(id);
}
let job;
let fetchJob = async () => ({ ok: true, json: async () => job });
let retryResponse = { ok: false, json: async () => ({ sourceMissing: true }) };
let uploadResponse = { ok: true, json: async () => ({ id: 'legacy-retry', status: 'queued', percent: 0 }) };
const retryCalls = [];
const uploadCalls = [];
const timeouts = new Map();
let timerId = 0;
const context = vm.createContext({
  document: { getElementById: element, createElement: node, body: element('body') },
  window: { addEventListener() {} }, location: { search: '', pathname: '/' },
  history: { replaceState() {} }, Date, URL, URLSearchParams, AbortController, TypeError,
  setTimeout(callback) { const id = ++timerId; timeouts.set(id, callback); return id; },
  clearTimeout(id) { timeouts.delete(id); },
  setInterval() { return 1; }, clearInterval() {},
  WorkGallery: class { render() {} select() {} dispose() {} }, SuperSplatPreview: class {},
  fetch: async (url, options) => url.startsWith('/api/jobs/retry?') ? (retryCalls.push({ url, options }), retryResponse) :
    options?.method === 'POST' && url.startsWith('/api/jobs?') ? (uploadCalls.push({ url, options }), uploadResponse) : url.startsWith('/api/job?') ? fetchJob(options) : ({ ok: true, json: async () =>
    url === '/api/health' ? { ok: true, runOoo: true } : { jobs: [] } }),
});
vm.runInContext(fs.readFileSync(path.join(__dirname, '../web/task-history.js'), 'utf8').replace(/^export /gm, ''), context);
const source = fs.readFileSync(path.join(__dirname, '../web/app.js'), 'utf8')
  .replace(/^import .*;$/gm, '').replace(/^export .*;$/gm, '');
vm.runInContext(source, context);
async function poll(value) {
  job = value;
  await vm.runInContext("currentJobId = 'test'; poll()", context);
}
(async () => {
  await poll({ id: 'test', status: 'queued', queuePosition: 2, queuedAt: Date.now() / 1000 - 5,
    message: '等待前面的任务完成', log: [] });
  assert.equal(element('stage').textContent, '排队中');
  assert.match(element('msg').textContent, /排队第 2 位/);
  assert.match(element('elapsed').textContent, /已等待/);
  assert.equal(element('pct').textContent, '等待开始');
  assert.match(element('go').textContent, /排队中/);
  await poll({ id: 'test', status: 'running', percent: 62, stageLabel: '高斯训练',
    message: '训练中', startedAt: Date.now() / 1000 - 5, log: [] });
  assert.equal(element('stage').textContent, '高斯训练');
  assert.equal(element('pct').textContent, '62%');
  assert.match(element('elapsed').textContent, /已用/);
  assert.match(element('go').textContent, /生成中/);
  await poll({ id: 'test', status: 'running', percent: 45, stage: 'Reconstructing',
    message: '普通日志', log: ['63.27% Reconstructing: 正在注册图像', '45.00% Reconstructing: Bundle adjustment report'] });
  assert.equal(element('pct').textContent, '63.27%');
  await poll({ id: 'test', status: 'running', percent: 45, log: [] });
  assert.equal(element('pct').textContent, '63.27%');
  await poll({ id: 'test', status: 'failed', error: '服务停止，任务已中断', log: [] });
  assert.match(element('msg').textContent, /错误：服务停止/);
  assert.equal(element('go').textContent, '开始生成');
  assert.equal(element('retryTask').hidden, false);
  assert.equal(element('retryTask').disabled, false);

  // All backend statuses stay selectable, including identical filenames.
  context.jobsForHistory = ['queued', 'running', 'done', 'failed'].map((status, i) => ({ id: `history-${i}`, status, filename: 'same.mp4', quality: 'high', createdAt: i + 1, percent: 20 }));
  vm.runInContext("taskHistory.update(jobsForHistory, 'history-1')", context);
  assert.equal(element('taskHistory').children.length, 4);
  assert.match(element('taskCount').textContent, /4 个任务/);
  const rows = () => element('taskHistory').children.map(container => container.children[0]);
  const selected = rows().find(row => row.dataset.jobId === 'history-1');
  assert.equal(selected.attributes['aria-pressed'], 'true');
  vm.runInContext("taskHistory.update(jobsForHistory, 'history-1')", context);
  assert.equal(rows().find(row => row.dataset.jobId === 'history-1'), selected);
  const retries = element('taskHistory').children.map(container => container.children[1]);
  assert.equal(retries.filter(button => !button.hidden).length, 1);

  // Missing old input offers a file chooser without requiring a new upload
  // selection in the general creation panel; replacement uses the retry API.
  await vm.runInContext("taskJobs = jobsForHistory; currentJobId = 'history-3'; retryJob('history-3')", context);
  assert.equal(element('retryPrompt').hidden, false);
  assert.match(element('retryMessage').textContent, /same.mp4/);
  const originalTicket = vm.runInContext('selectionToken', context);
  retryResponse = { ok: true, json: async () => ({ id: 'retried', retryOf: 'history-3', status: 'queued', quality: 'high', percent: 0 }) };
  context.replacement = { name: 'same.mp4' };
  await vm.runInContext("retryJob('history-3', replacement)", context);
  assert.equal(retryCalls[1].options.body, context.replacement);
  assert.equal(retryCalls[1].options.headers['X-Filename'], 'same.mp4');
  assert.equal(vm.runInContext('currentJobId', context), 'retried');
  assert.ok(vm.runInContext('selectionToken', context) > originalTicket);

  vm.runInContext("taskHistory.update([{id: 'busy', filename: 'same.mp4', status: 'failed', retryJobId: 'queued-child'}], null)", context);
  assert.equal(element('taskHistory').children[0].children[1].disabled, true);

  // An older backend with a live generation can serve updated static files
  // without restarting: retry reuploads through its original API and quality.
  retryResponse = { ok: false, status: 404, json: async () => ({ error: '未找到' }) };
  await vm.runInContext("taskJobs = jobsForHistory; currentJobId = 'history-3'; retryJob('history-3')", context);
  assert.equal(element('retryPrompt').hidden, false);
  await vm.runInContext("taskJobs = jobsForHistory; retryJob('history-3', replacement)", context);
  assert.equal(uploadCalls[0].url, '/api/jobs?quality=high');
  assert.equal(uploadCalls[0].options.body, context.replacement);
  assert.equal(vm.runInContext('currentJobId', context), 'legacy-retry');

  // Only one request per selection is allowed; old responses after reselecting
  // the same job must never overwrite the new selection's progress.
  let release, calls = 0;
  fetchJob = () => { calls++; return new Promise(resolve => { release = resolve; }); };
  const oldRequest = vm.runInContext("currentJobId = 'race'; ++pollEpoch; poll()", context);
  await vm.runInContext('poll()', context);
  assert.equal(calls, 1);
  fetchJob = async () => ({ ok: true, json: async () => ({ id: 'race', status: 'running', percent: 80.12, log: [] }) });
  await vm.runInContext('++pollEpoch; poll()', context);
  release({ ok: true, json: async () => ({ id: 'race', status: 'running', percent: 30, log: [] }) });
  await oldRequest;
  assert.equal(element('pct').textContent, '80.12%');
  fetchJob = async () => { throw new TypeError('Failed to fetch'); };
  await vm.runInContext('poll()', context);
  assert.equal(element('stage').textContent, '连接中断');
  assert.match(element('msg').textContent, /自动重连/);
  assert.equal(element('pct').textContent, '80.12%');
  fetchJob = async () => ({ ok: true, json: async () => ({ id: 'race', status: 'running', percent: 81.23, stageLabel: '高斯训练' }) });
  await vm.runInContext('poll()', context);
  assert.equal(element('pct').textContent, '81.23%');
  assert.equal(element('stage').textContent, '高斯训练');
  await vm.runInContext('checkHealth()', context);
  fetchJob = options => new Promise((resolve, reject) => {
    options.signal.addEventListener('abort', () => { const error = new Error('timeout'); error.name = 'AbortError'; reject(error); });
  });
  const hung = vm.runInContext('poll()', context);
  assert.equal(timeouts.size, 1);
  [...timeouts.values()][0]();
  await hung;
  assert.equal(element('stage').textContent, '连接中断');
  assert.equal(element('pct').textContent, '81.23%');
  assert.equal(timeouts.size, 0);
  fetchJob = async () => ({ ok: true, json: async () => ({ id: 'race', status: 'running', percent: 82.34, stageLabel: '高斯训练' }) });
  await vm.runInContext('poll()', context);
  assert.equal(element('pct').textContent, '82.34%');
  console.log('Task UI: queue, history, monotonic progress and stale-response regressions passed');
})().catch(error => { console.error(error); process.exitCode = 1; });
