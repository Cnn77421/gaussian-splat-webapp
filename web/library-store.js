// PLY imports stay on this device, like the existing local preview workflow.
// Use a separate database so old cover-cache tabs cannot block a schema upgrade.
export class LocalWorkStore {
  constructor(name = 'splat-library') {
    this.database = new Promise((resolve, reject) => {
      const request = indexedDB.open(name, 1);
      request.onupgradeneeded = () => request.result.createObjectStore('works', { keyPath: 'id' });
      request.onsuccess = () => { request.result.onversionchange = () => request.result.close(); resolve(request.result); };
      request.onerror = () => reject(new Error('浏览器无法打开作品存储'));
      request.onblocked = () => reject(new Error('请关闭旧页面后重试'));
    });
    this.database.catch(() => {});
  }
  async request(mode, operation) {
    const db = await this.database;
    return new Promise((resolve, reject) => {
      const transaction = db.transaction('works', mode);
      const request = operation(transaction.objectStore('works'));
      transaction.oncomplete = () => resolve(request.result);
      transaction.onabort = transaction.onerror = () => reject(new Error(
        transaction.error?.name === 'QuotaExceededError' ? '浏览器存储空间不足，请删除不用的本地作品后重试' : '作品存储失败，请重试'));
    });
  }
  async list() { return (await this.request('readonly', store => store.getAll())).map(({ file, ...metadata }) => metadata); }
  get(id) { return this.request('readonly', store => store.get(id)); }
  put(work) { return this.request('readwrite', store => store.put(work)); }
  remove(id) { return this.request('readwrite', store => store.delete(id)); }
}
// Lazy initialization also keeps file-less gallery browsing usable when storage
// has been disabled by the browser.
let store;
export const localWorks = () => store ??= new LocalWorkStore();
