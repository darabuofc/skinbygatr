/** Video and image libraries stored in IndexedDB, so clips and height maps survive reloads and work offline. */
export interface VideoRecord { id: string; name: string; type: string; size: number; blob: Blob; added: number; }
export interface ImageRecord { id: string; name: string; type: string; size: number; blob: Blob; added: number; }

const DB = 'panelmapper';
/** Version 2 added the image store; the upgrade only creates what's missing, so saved videos survive it. */
const VERSION = 2;
const VIDEOS = 'videos';
const IMAGES = 'images';
let dbp: Promise<IDBDatabase> | null = null;

function db(): Promise<IDBDatabase> {
  if (!dbp) {
    dbp = new Promise((resolve, reject) => {
      const r = indexedDB.open(DB, VERSION);
      r.onupgradeneeded = () => {
        for (const name of [VIDEOS, IMAGES]) {
          if (!r.result.objectStoreNames.contains(name)) r.result.createObjectStore(name, { keyPath: 'id' });
        }
      };
      r.onsuccess = () => {
        // Step aside if a newer build needs to upgrade the database, instead of blocking it.
        r.result.onversionchange = () => { r.result.close(); dbp = null; };
        resolve(r.result);
      };
      r.onerror = () => { dbp = null; reject(r.error); };
    });
  }
  return dbp;
}

function run<T>(store: string, mode: IDBTransactionMode, fn: (s: IDBObjectStore) => IDBRequest<T>): Promise<T> {
  return db().then((d) => new Promise<T>((resolve, reject) => {
    const tx = d.transaction(store, mode);
    const req = fn(tx.objectStore(store));
    let result: T;
    req.onsuccess = () => { result = req.result; };
    tx.oncomplete = () => resolve(result);
    tx.onerror = () => reject(tx.error ?? req.error);
    tx.onabort = () => reject(tx.error ?? new Error('aborted'));
  }));
}

export const listVideos = () => run<VideoRecord[]>(VIDEOS, 'readonly', (s) => s.getAll() as IDBRequest<VideoRecord[]>);
export const putVideo = (r: VideoRecord) => run(VIDEOS, 'readwrite', (s) => s.put(r));
export const deleteVideo = (id: string) => run(VIDEOS, 'readwrite', (s) => s.delete(id));

export const listImages = () => run<ImageRecord[]>(IMAGES, 'readonly', (s) => s.getAll() as IDBRequest<ImageRecord[]>);
export const putImage = (r: ImageRecord) => run(IMAGES, 'readwrite', (s) => s.put(r));
export const deleteImage = (id: string) => run(IMAGES, 'readwrite', (s) => s.delete(id));
