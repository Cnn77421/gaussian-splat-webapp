import { SuperSplatPreview } from './supersplat-preview.js';
import { localWorks } from './library-store.js';

// Cover blobs are local, persistent, and never enlarge localStorage preferences.
const database = new Promise(resolve => {
  let request;
  try { request = indexedDB.open('splat-gallery', 1); } catch { resolve(null); return; }
  request.onupgradeneeded = () => request.result.createObjectStore('covers');
  request.onsuccess = () => { request.result.onversionchange = () => request.result.close(); resolve(request.result); };
  request.onerror = () => resolve(null);
});
async function coverStore(key, blob, remove = false) {
  const db = await database;
  if (!db) return null;
  return new Promise(resolve => {
    const transaction = db.transaction('covers', blob || remove ? 'readwrite' : 'readonly');
    const store = transaction.objectStore('covers');
    const request = remove ? store.delete(key) : blob ? store.put(blob, key) : store.get(key);
    transaction.oncomplete = () => resolve(blob || request.result);
    transaction.onerror = transaction.onabort = () => resolve(null);
  });
}
export async function captureCover(handle) {
  const capture = await handle.captureFrame({ width: 480, height: 300, supersample: 1 });
  const bytes = Uint8ClampedArray.from(atob(capture.data), c => c.charCodeAt(0));
  const canvas = document.createElement('canvas');
  canvas.width = capture.width; canvas.height = capture.height;
  canvas.getContext('2d').putImageData(new ImageData(bytes, capture.width, capture.height), 0, 0);
  return new Promise(resolve => canvas.toBlob(resolve, 'image/webp', .85));
}
export class WorkGallery {
  constructor({ dialog, trigger, onSelect, onDelete = () => {}, store, fetcher = (...args) => fetch(...args) }) {
    Object.assign(this, { dialog, trigger, onSelect, onDelete, store, fetcher });
    this.cards = new Map(); this.urls = new Map(); this.generation = 0; this.coverTicket = 0;
    this.backendJobs = []; this.removed = new Set(); this.busy = false;
    trigger.addEventListener('click', () => { dialog.showModal(); this.ensureCovers(); });
    dialog.addEventListener('close', () => { this.cancelCovers(); this.cancelDelete(); });
    dialog.querySelector('[data-close]').addEventListener('click', () => dialog.close());
    dialog.addEventListener('click', event => { if (event.target === dialog) dialog.close(); });
    dialog.querySelector('[data-search]').addEventListener('input', () => this.filter());
    dialog.querySelector('[data-add]').addEventListener('click', () => dialog.querySelector('[data-add-file]').click());
    dialog.querySelector('[data-add-file]').addEventListener('change', event => {
      const files = [...event.target.files]; event.target.value = '';
      this.addFiles(files);
    });
    dialog.querySelector('[data-cancel-delete]').addEventListener('click', () => this.cancelDelete());
    dialog.querySelector('[data-confirm-delete]').addEventListener('click', () => this.deletePending());
  }
  get library() { return this.store || localWorks(); }
  message(text, error = false) {
    const output = this.dialog.querySelector('[data-message]');
    output.textContent = text; output.classList.toggle('error', error);
  }
  setBusy(on) {
    this.busy = on; this.dialog.setAttribute('aria-busy', String(on));
    this.dialog.querySelectorAll('[data-add], .work-open, .work-delete, [data-confirm-delete], [data-cancel-delete]').forEach(button => button.disabled = on);
  }
  filter() {
    const term = this.dialog.querySelector('[data-search]').value.trim().toLowerCase();
    for (const card of this.cards.values()) card.hidden = !card.querySelector('strong').textContent.toLowerCase().includes(term);
    this.emptyState();
  }
  emptyState() {
    const visible = [...this.cards.values()].filter(card => !card.hidden).length;
    this.dialog.querySelector('[data-empty]').hidden = visible > 0;
    this.dialog.querySelector('[data-empty]').textContent = this.cards.size ? '没有匹配的作品' : '还没有作品，添加一个 PLY 模型开始展示。';
  }
  async render(jobs = this.backendJobs, selected = this.selected) {
    const generation = ++this.generation;
    this.backendJobs = jobs;
    let imported = [];
    try { imported = await this.library.list(); } catch (error) { this.message(error.message, true); }
    if (generation !== this.generation || this.disposed) return;
    this.jobs = [...jobs, ...imported].filter(work => !this.removed.has(work.id))
      .sort((a, b) => (b.finishedAt || b.createdAt) - (a.finishedAt || a.createdAt));
    this.cancelCovers();
    this.urls.forEach(url => URL.revokeObjectURL(url)); this.urls.clear(); this.cards.clear();
    const grid = this.dialog.querySelector('[data-grid]'); grid.replaceChildren();
    this.trigger.textContent = `作品库 · ${this.jobs.length}`;
    for (const work of this.jobs) {
      // Separate sibling buttons keep deletion from accidentally opening a work.
      const card = document.createElement('article'); card.className = 'work-card'; card.dataset.id = work.id;
      const open = document.createElement('button'); open.className = 'work-open';
      open.setAttribute('aria-label', `展示 ${work.filename || '未命名作品'}`);
      const picture = document.createElement('div'); picture.className = 'work-cover';
      const hint = document.createElement('span'); hint.textContent = '正在准备模型封面…'; picture.append(hint);
      const title = document.createElement('strong'); title.textContent = work.filename || '未命名作品';
      const detail = document.createElement('small');
      const date = new Date((work.finishedAt || work.createdAt || 0) * 1000).toLocaleDateString('zh-CN');
      detail.textContent = `${date} · ${work.stats?.splatCount?.toLocaleString() || '—'} 个高斯`;
      open.append(picture, title, detail);
      open.addEventListener('click', () => { if (this.busy) return; this.select(work.id); this.dialog.close(); this.onSelect(work); });
      const actions = document.createElement('div'); actions.className = 'work-card-actions';
      const source = document.createElement('span'); source.textContent = work.local ? '本地导入' : '生成作品';
      const remove = document.createElement('button'); remove.className = 'work-delete'; remove.textContent = '删除';
      remove.setAttribute('aria-label', `删除 ${work.filename || '未命名作品'}`);
      remove.addEventListener('click', () => this.requestDelete(work)); actions.append(source, remove);
      card.append(open, actions); grid.append(card); this.cards.set(work.id, card);
      coverStore(work.id).then(blob => { if (generation === this.generation && blob) this.showCover(work.id, blob); });
    }
    this.select(selected); this.filter(); this.setBusy(this.busy);
    if (this.dialog.open && !this.busy) this.ensureCovers();
  }
  select(id) {
    this.selected = id;
    this.cards.forEach((card, key) => {
      card.classList.toggle('selected', key === id);
      card.querySelector('.work-open').setAttribute('aria-pressed', String(key === id));
    });
  }
  showCover(id, blob) {
    const picture = this.cards.get(id)?.querySelector('.work-cover');
    if (!picture || this.removed.has(id)) return;
    if (this.urls.has(id)) URL.revokeObjectURL(this.urls.get(id));
    const url = URL.createObjectURL(blob); this.urls.set(id, url);
    const img = document.createElement('img'); img.src = url; img.alt = this.cards.get(id).querySelector('strong').textContent + '模型封面';
    picture.replaceChildren(img);
  }
  async saveCover(id, handle) {
    const blob = await captureCover(handle);
    if (!blob || this.removed.has(id) || this.disposed) return;
    await coverStore(id, blob);
    // A capture that completes after deletion must not recreate stale cache.
    if (this.removed.has(id)) { await coverStore(id, null, true); return; }
    this.showCover(id, blob);
  }
  async addFiles(files) {
    if (!files.length || this.busy) return;
    this.setBusy(true); this.cancelCovers(); this.cancelDelete();
    let added = 0, duplicates = 0; const failures = [];
    try {
      for (const file of files) {
        this.message(`正在添加 ${file.name}…`);
        let temporary;
        try {
          const header = await file.slice(0, 5).text();
          if (!file.name.toLowerCase().endsWith('.ply') || !/^ply\r?\n/.test(header)) throw new Error('请选择有效的 .ply 文件');
          const fingerprint = `${file.name}:${file.size}:${file.lastModified}`;
          if ((await this.library.list()).some(work => work.fingerprint === fingerprint)) { duplicates++; continue; }
          const id = `local:${crypto.randomUUID()}`;
          temporary = this.addPreview = this.temporaryPreview();
          const src = URL.createObjectURL(file);
          try {
            await temporary.preview.load(src, { filename: file.name, modelKey: `library:${id}`, auxiliary: true });
            if (this.disposed) return;
            const component = temporary.preview.handle.app.root.findByName('gsplat').gsplat;
            const splatCount = component.resource.gsplatData?.numSplats || component.resource.numSplats;
            const cover = await captureCover(temporary.preview.handle);
            const work = { id, local: true, status: 'done', filename: file.name, fingerprint,
              createdAt: Date.now() / 1000, stats: { splatCount, fileSize: file.size }, file };
            // Store only after real PLY decoding succeeds, and wait for commit.
            await this.library.put(work);
            if (cover) await coverStore(id, cover);
            added++;
          } finally { URL.revokeObjectURL(src); }
        } catch (error) { failures.push(`${file.name}：${error.message || error}`); }
        finally { temporary?.dispose(); this.addPreview = null; }
      }
      this.dialog.querySelector('[data-search]').value = '';
      await this.render();
      this.message([added ? `已添加 ${added} 个作品` : '', duplicates ? `${duplicates} 个作品已存在` : '', ...failures].filter(Boolean).join('；'), failures.length > 0);
    } finally { this.setBusy(false); if (this.dialog.open) this.ensureCovers(); }
  }
  requestDelete(work) {
    if (this.busy) return;
    this.pendingDelete = work; this.cancelCovers();
    const confirmation = this.dialog.querySelector('[data-delete-confirmation]');
    confirmation.hidden = false;
    confirmation.querySelector('[data-delete-name]').textContent = work.filename || '未命名作品';
    confirmation.querySelector('[data-delete-description]').textContent = work.local
      ? '将删除此浏览器保存的模型、封面和默认视角，原始 PLY 文件不会改动。'
      : '将删除生成任务、模型和该任务保存的素材，删除后无法恢复。';
    confirmation.querySelector('[data-cancel-delete]').focus();
  }
  cancelDelete() { this.pendingDelete = null; this.dialog.querySelector('[data-delete-confirmation]').hidden = true; }
  async deletePending() {
    const work = this.pendingDelete;
    if (!work || this.busy) return;
    this.setBusy(true); this.message(`正在删除 ${work.filename}…`);
    try {
      if (work.local) await this.library.remove(work.id);
      else {
        const response = await this.fetcher(`/api/jobs?id=${encodeURIComponent(work.id)}`, { method: 'DELETE' });
        if (!response.ok && response.status !== 404) {
          const result = await response.json().catch(() => ({}));
          throw new Error(result.error || `删除失败（HTTP ${response.status}）`);
        }
      }
      this.removed.add(work.id); this.backendJobs = this.backendJobs.filter(job => job.id !== work.id);
      await coverStore(work.id, null, true);
      try { localStorage.removeItem(`splat.view.v2.${encodeURIComponent(work.local ? `library:${work.id}` : `job:${work.id}`)}`); } catch { /* Storage may be disabled. */ }
      this.cancelDelete(); if (this.selected === work.id) this.selected = null;
      await this.onDelete(work);
      await this.render(); this.message(`已删除 ${work.filename}`);
    } catch (error) { this.message(error.message || '删除失败，请重试', true); }
    finally { this.setBusy(false); if (this.dialog.open && !this.pendingDelete) this.ensureCovers(); }
  }
  async getFile(id) { return (await this.library.get(id))?.file; }
  temporaryPreview() {
    const root = document.createElement('div');
    root.style.cssText = 'position:fixed;left:-10000px;top:0;width:480px;height:300px;pointer-events:none';
    root.setAttribute('aria-hidden', 'true'); document.body.append(root);
    const preview = new SuperSplatPreview({ rootElement: root });
    return { preview, dispose: () => { preview.dispose(); root.remove(); } };
  }
  cancelCovers() { ++this.coverTicket; this.coverPreview?.dispose(); this.coverPreview = null; }
  async ensureCovers() {
    if (this.busy || this.pendingDelete || this.disposed) return;
    this.cancelCovers(); const ticket = this.coverTicket;
    for (const work of this.jobs || []) {
      if (ticket !== this.coverTicket || !this.dialog.open) return;
      if (await coverStore(work.id)) continue;
      if (ticket !== this.coverTicket) return;
      const temporary = this.coverPreview = this.temporaryPreview(); let src;
      try {
        const file = work.local ? await this.getFile(work.id) : null;
        if (ticket !== this.coverTicket) return;
        if (work.local && !file) throw new Error('模型已删除');
        src = work.local ? URL.createObjectURL(file) : `/api/artifact?id=${encodeURIComponent(work.id)}`;
        await temporary.preview.load(src, { filename: work.local ? work.filename : 'final.ply', modelKey: work.local ? `library:${work.id}` : `job:${work.id}`, auxiliary: true });
        await new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve)));
        if (ticket !== this.coverTicket) return;
        await this.saveCover(work.id, temporary.preview.handle);
      } catch {
        const hint = this.cards.get(work.id)?.querySelector('.work-cover span'); if (hint) hint.textContent = '点击打开模型';
      } finally { if (work.local && src) URL.revokeObjectURL(src); temporary.dispose(); }
    }
  }
  dispose() { this.disposed = true; this.cancelCovers(); this.addPreview?.dispose(); ++this.generation; this.urls.forEach(url => URL.revokeObjectURL(url)); }
}
