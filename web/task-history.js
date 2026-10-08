// Keep progress monotonic even with older servers emitting stage-start log lines.
export function normalizeProgress(job, previous = {}) {
  const clamp = value => Number.isFinite(Number(value)) ? Math.max(0, Math.min(100, Number(value))) : 0;
  let percent = job.status === 'queued' ? 0 : Math.max(clamp(job.percent), clamp(previous.percent));
  let stage = job.stage, stageLabel = job.stageLabel, message = job.message;
  let recovered = false;
  for (const line of job.log || []) {
    const match = /^\s*([\d.]+)%\s+([A-Za-z]+):\s*(.*)$/.exec(line);
    if (!match || job.status === 'queued') continue;
    const value = clamp(match[1]);
    if (value >= percent) {
      recovered = true;
      percent = value; stage = match[2]; message = match[3].trim() || message;
      stageLabel = { Created: '创建任务', ProbingVideo: '读取素材', PlanningFrames: '规划抽帧',
        ExtractingFrames: '抽取画面', ExtractingFeatures: '特征提取', Matching: '特征匹配',
        Reconstructing: '相机重建', ValidatingReconstruction: '校验重建', BridgeBackfill: '桥接补帧',
        TrainingSplats: '高斯训练', Exporting: '导出模型', Completed: '全部完成' }[stage] || stageLabel;
    }
  }
  if (!recovered && clamp(previous.percent) > clamp(job.percent)) {
    stage = previous.stage || stage; stageLabel = previous.stageLabel || stageLabel;
    message = previous.message || message;
  }
  return { ...job, percent: job.status === 'done' ? 100 : percent, stage, stageLabel, message };
}

export function formatPercent(value) { return `${Number(value || 0).toFixed(2).replace(/\.?0+$/, '')}%`; }

export class TaskHistory {
  constructor(root, count, onSelect, onRetry) {
    this.root = root; this.count = count; this.onSelect = onSelect; this.onRetry = onRetry; this.rows = new Map();
  }
  select(id) {
    for (const [key, row] of this.rows) row.button.setAttribute('aria-pressed', String(key === id));
  }
  update(jobs, selectedId) {
    this.count.textContent = `${jobs.length} 个任务`;
    this.root.querySelector('[data-task-empty]')?.remove();
    const ids = new Set(jobs.map(job => job.id));
    for (const [id, row] of this.rows) if (!ids.has(id)) { row.container.remove(); this.rows.delete(id); }
    if (!jobs.length) {
      const empty = document.createElement('p'); empty.dataset.taskEmpty = ''; empty.textContent = '还没有生成任务';
      this.root.append(empty);
    }
    const sorted = [...jobs].sort((a, b) => (b.createdAt || 0) - (a.createdAt || 0));
    sorted.forEach((job, index) => {
      let row = this.rows.get(job.id);
      if (!row) {
        const button = document.createElement('button'); button.type = 'button'; button.className = 'task-row';
        button.dataset.jobId = job.id;
        const container = document.createElement('div'); container.className = 'task-entry';
        const retry = document.createElement('button'); retry.type = 'button'; retry.className = 'task-retry cbtn';
        retry.dataset.retryId = job.id; retry.setAttribute('aria-label', `重试 ${job.filename || job.id} · ${job.id.slice(0, 8)}`);
        retry.addEventListener('click', () => this.onRetry?.(job.id));
        const name = document.createElement('strong'), status = document.createElement('span'), detail = document.createElement('small');
        button.append(name, status, detail);
        button.addEventListener('click', () => this.onSelect(job.id));
        container.append(button, retry);
        row = { container, button, retry, name, status, detail }; this.rows.set(job.id, row);
      }
      const status = { queued: '排队中', running: '生成中', done: '已完成', failed: '失败' }[job.status] || job.status;
      row.name.textContent = job.filename || job.id;
      row.status.textContent = job.status === 'queued' ? `${status}${job.queuePosition ? ` · 第 ${job.queuePosition} 位` : ''}` : `${status} · ${formatPercent(job.percent)}`;
      row.button.dataset.status = job.status;
      row.retry.hidden = job.status !== 'failed';
      row.retry.disabled = Boolean(job.retryJobId || job.retryBusy);
      row.retry.textContent = job.retryBusy ? '提交中…' : job.retryJobId ? '已提交重试' : '重试';
      row.detail.textContent = `${new Date((job.createdAt || 0) * 1000).toLocaleString('zh-CN', { hour12: false })} · ${job.id.slice(0, 8)}`;
      if (this.root.children[index] !== row.container) this.root.insertBefore(row.container, this.root.children[index] || null);
    });
    this.select(selectedId);
  }
}
