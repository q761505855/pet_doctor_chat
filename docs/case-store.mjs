// The UI consumes this async repository independently of the storage provider.
export async function openCaseStore() {
  const db = await new Promise((resolve, reject) => {
    const request = indexedDB.open('pet-doctor-cases', 1);
    request.onupgradeneeded = () => request.result.createObjectStore('cases', { keyPath: 'id' });
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error);
    request.onblocked = () => reject(new Error('请关闭其他问诊室标签页后重试。'));
  });
  db.onversionchange = () => db.close();

  function transaction(mode, action) {
    return new Promise((resolve, reject) => {
      const tx = db.transaction('cases', mode);
      let result;
      let conflict = false;
      const setResult = value => { result = value; };
      const abortConflict = () => { conflict = true; tx.abort(); };
      tx.oncomplete = () => resolve(result);
      tx.onabort = () => reject(conflict
        ? new Error('这份病例已在其他页面更新或删除。请返回病例列表后重新打开。')
        : tx.error ?? new Error('本地存储操作中断，请重试。'));
      action(tx.objectStore('cases'), setResult, abortConflict);
    });
  }

  return {
    list: () => transaction('readonly', (store, done) => {
      store.getAll().onsuccess = event => done(event.target.result.sort((a, b) => b.updatedAt.localeCompare(a.updatedAt)));
    }),
    get: id => transaction('readonly', (store, done) => {
      store.get(id).onsuccess = event => done(event.target.result);
    }),
    add: record => transaction('readwrite', (store, done) => {
      store.add(record);
      done(record);
    }),
    save: record => transaction('readwrite', (store, done, conflict) => {
      store.get(record.id).onsuccess = event => {
        if (event.target.result?.revision !== record.revision) return conflict();
        const updated = { ...record, revision: record.revision + 1, updatedAt: new Date().toISOString() };
        store.put(updated);
        done(updated);
      };
    }),
    remove: (id, revision) => transaction('readwrite', (store, done, conflict) => {
      store.get(id).onsuccess = event => {
        if (event.target.result?.revision !== revision) return conflict();
        store.delete(id);
      };
    })
  };
}
