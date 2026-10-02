import { emptyState, validateState } from "./core.js";

export const DATABASE = `pmle-study:${new URL(".", document.baseURI).pathname}`;
const conflict = () => new Error("Otra pestaña ha cambiado tus datos. Pulsa «Recargar datos» antes de continuar.");

export function openStorage() {
  return new Promise((resolve, reject) => {
    let request;
    try { request = indexedDB.open(DATABASE, 1); }
    catch {
      reject(new Error("No se puede abrir el almacenamiento del navegador. Permite los datos de este sitio y vuelve a cargar."));
      return;
    }
    request.onupgradeneeded = () => request.result.createObjectStore("state");
    request.onerror = () => reject(new Error("No se puede abrir el almacenamiento del navegador. Permite los datos de este sitio y vuelve a cargar."));
    request.onblocked = () => reject(new Error("Cierra las otras pestañas de la aplicación para actualizar su almacenamiento."));
    request.onsuccess = () => {
      const db = request.result;
      db.onversionchange = () => db.close();
      resolve(db);
    };
  });
}

export function readStorage(db) {
  return new Promise((resolve, reject) => {
    const tx = db.transaction("state", "readonly");
    const store = tx.objectStore("state");
    const current = store.get("current");
    const backup = store.get("backup");
    tx.oncomplete = () => resolve({ current: current.result === undefined ? emptyState() : current.result, backup: backup.result });
    tx.onabort = tx.onerror = () => reject(new Error("No se pudieron leer tus datos. No se ha borrado nada."));
  });
}

export function writeStorage(db, revision, mutate) {
  return new Promise((resolve, reject) => {
    const tx = db.transaction("state", "readwrite");
    const store = tx.objectStore("state");
    const request = store.get("current");
    let next, failure;
    request.onsuccess = () => {
      try {
        const previous = validateState(request.result === undefined ? emptyState() : request.result);
        if (previous.revision !== revision) throw conflict();
        next = structuredClone(previous);
        mutate(next);
        next.revision++;
        validateState(next);
        store.put(previous, "backup");
        store.put(next, "current");
      } catch (error) {
        failure = error instanceof DOMException
          ? new Error("No se pudo guardar. Comprueba el espacio y los permisos del navegador. Tu último guardado sigue intacto.")
          : error;
        tx.abort();
      }
    };
    tx.oncomplete = () => resolve(next);
    tx.onabort = tx.onerror = () => reject(failure ?? new Error("No se pudo guardar. Comprueba el espacio y los permisos del navegador. Tu último guardado sigue intacto."));
  });
}

export function recoverStorage(db, broken, backup) {
  validateState(backup);
  return new Promise((resolve, reject) => {
    const tx = db.transaction("state", "readwrite");
    const store = tx.objectStore("state");
    const request = store.get("current");
    let failure, restored;
    request.onsuccess = () => {
      if (JSON.stringify(request.result) !== JSON.stringify(broken)) {
        failure = conflict();
        tx.abort();
        return;
      }
      restored = structuredClone(backup);
      restored.revision = Math.max(Date.now(), restored.revision + 1);
      store.put(broken, "damaged");
      store.put(restored, "current");
    };
    tx.oncomplete = () => resolve(restored);
    tx.onabort = tx.onerror = () => reject(failure ?? new Error("No se pudo recuperar la copia. Los datos originales se conservan."));
  });
}
