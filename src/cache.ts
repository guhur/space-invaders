/** Cache local des réponses de l'API : la carte s'affiche sans attendre le réseau à chaque refresh. */

const NS = "si:";
const PREFIX = `${NS}v1:`;

type Entry<T> = { savedAt: number; data: T };

const keyOf = (name: string) => `${PREFIX}${name}`;

const keys = () => {
  try {
    return Object.keys(localStorage);
  } catch {
    return [];
  }
};

const drop = (names: string[]) => {
  try {
    names.forEach((k) => localStorage.removeItem(k));
  } catch {
    /* le cache est optionnel */
  }
};

/** Une entrée écrite par une version précédente du format ne se relit pas : on la balaye. */
drop(keys().filter((k) => k.startsWith(NS) && !k.startsWith(PREFIX)));

export function readCache<T>(name: string): Entry<T> | null {
  try {
    const raw = localStorage.getItem(keyOf(name));
    if (!raw) return null;
    const entry = JSON.parse(raw) as Entry<T>;
    return typeof entry?.savedAt === "number" && entry.data != null ? entry : null;
  } catch {
    return null;
  }
}

export function writeCache<T>(name: string, data: T): void {
  const raw = JSON.stringify({ savedAt: Date.now(), data } satisfies Entry<T>);
  try {
    localStorage.setItem(keyOf(name), raw);
  } catch {
    // Quota dépassé : un cache vide vaut mieux qu'un cache à moitié écrit.
    drop(keys().filter((k) => k.startsWith(NS)));
    try {
      localStorage.setItem(keyOf(name), raw);
    } catch {
      /* le cache est optionnel */
    }
  }
}
