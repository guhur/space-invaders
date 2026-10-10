/** Plus court parcours à pied entre un point de départ et les N invaders les plus proches. */

export type Point = { lat: number; lng: number };

/** Au-delà, la programmation dynamique exacte (n² · 2ⁿ) devient trop lente pour un téléphone. */
const EXACT_MAX = 12;

export function haversine(a: Point, b: Point): number {
  const rad = Math.PI / 180;
  const dLat = (b.lat - a.lat) * rad;
  const dLng = (b.lng - a.lng) * rad;
  const h = Math.sin(dLat / 2) ** 2 + Math.cos(a.lat * rad) * Math.cos(b.lat * rad) * Math.sin(dLng / 2) ** 2;
  return 2 * 6_371_000 * Math.asin(Math.sqrt(h));
}

export function nearest<T extends Point>(from: Point, candidates: T[], count: number): T[] {
  return candidates
    .map((c) => ({ c, d: haversine(from, c) }))
    .sort((a, b) => a.d - b.d)
    .slice(0, count)
    .map(({ c }) => c);
}

/**
 * Ordre de visite le plus court. L'indice 0 de `points` est le départ, toujours en tête ;
 * avec `loop`, le parcours revient au départ. Renvoie l'ordre (départ inclus) et la longueur en mètres.
 */
export function shortestPath(points: Point[], loop: boolean): { order: number[]; length: number } {
  const n = points.length;
  const d = points.map((a) => points.map((b) => haversine(a, b)));
  const order = n - 1 <= EXACT_MAX ? exact(d, loop) : improve(nearestNeighbour(d), d, loop);
  return { order, length: pathLength(order, d, loop) };
}

function pathLength(order: number[], d: number[][], loop: boolean): number {
  let s = 0;
  for (let i = 1; i < order.length; i++) s += d[order[i - 1]][order[i]];
  return loop && order.length > 1 ? s + d[order.at(-1)!][order[0]] : s;
}

/** Held-Karp : dp[masque][j] = plus court chemin partant de 0, couvrant `masque` et finissant en j. */
function exact(d: number[][], loop: boolean): number[] {
  const m = d.length - 1;
  if (m <= 0) return [0];
  const full = (1 << m) - 1;
  const dp = new Float64Array((full + 1) * m).fill(Infinity);
  const parent = new Int8Array((full + 1) * m).fill(-1);
  for (let j = 0; j < m; j++) dp[(1 << j) * m + j] = d[0][j + 1];

  for (let mask = 1; mask <= full; mask++) {
    for (let j = 0; j < m; j++) {
      const cur = dp[mask * m + j];
      if (!(mask & (1 << j)) || cur === Infinity) continue;
      for (let k = 0; k < m; k++) {
        if (mask & (1 << k)) continue;
        const next = mask | (1 << k);
        const cand = cur + d[j + 1][k + 1];
        if (cand < dp[next * m + k]) {
          dp[next * m + k] = cand;
          parent[next * m + k] = j;
        }
      }
    }
  }

  let end = 0;
  let best = Infinity;
  for (let j = 0; j < m; j++) {
    const total = dp[full * m + j] + (loop ? d[j + 1][0] : 0);
    if (total < best) [best, end] = [total, j];
  }

  const rev: number[] = [];
  for (let mask = full, j = end; j !== -1; ) {
    rev.push(j + 1);
    const p = parent[mask * m + j];
    mask &= ~(1 << j);
    j = p;
  }
  return [0, ...rev.reverse()];
}

function nearestNeighbour(d: number[][]): number[] {
  const order = [0];
  const left = new Set(d.keys());
  left.delete(0);
  while (left.size) {
    const last = order.at(-1)!;
    let next = -1;
    for (const k of left) if (next === -1 || d[last][k] < d[last][next]) next = k;
    order.push(next);
    left.delete(next);
  }
  return order;
}

/** 2-opt puis Or-opt jusqu'à ce que plus rien ne raccourcisse : le départ reste figé en tête. */
function improve(order: number[], d: number[][], loop: boolean): number[] {
  let best = order;
  let bestLen = pathLength(best, d, loop);
  for (let improved = true; improved; ) {
    improved = false;
    for (const cand of neighbours(best)) {
      const len = pathLength(cand, d, loop);
      if (len < bestLen - 1e-6) {
        [best, bestLen, improved] = [cand, len, true];
        break;
      }
    }
  }
  return best;
}

function* neighbours(order: number[]): Generator<number[]> {
  const n = order.length;
  for (let i = 1; i < n - 1; i++)
    for (let j = i + 1; j < n; j++) yield [...order.slice(0, i), ...order.slice(i, j + 1).reverse(), ...order.slice(j + 1)];
  for (let len = 1; len <= 3; len++)
    for (let i = 1; i + len <= n; i++) {
      const seg = order.slice(i, i + len);
      const rest = [...order.slice(0, i), ...order.slice(i + len)];
      for (let k = 1; k <= rest.length; k++) if (k !== i) yield [...rest.slice(0, k), ...seg, ...rest.slice(k)];
    }
}
