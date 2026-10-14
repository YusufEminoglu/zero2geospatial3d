// @ts-check
// NSGA-II (Deb, Pratap, Agarwal and Meyarivan 2002, "A fast and elitist
// multiobjective genetic algorithm: NSGA-II", IEEE Trans. Evol. Comput.
// 6(2):182-197, doi:10.1109/4235.996017) with constraint domination,
// simulated binary crossover and polynomial mutation. All objectives are
// minimised. Seeded, so a run can be repeated exactly.

/** mulberry32: small, fast, seedable PRNG returning [0, 1). */
export function makeRng(seed = 1) {
  let a = seed >>> 0;
  return function rng() {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** a dominates b (constraint domination: feasibility first). */
export function dominates(a, b) {
  if (a.violation > 0 || b.violation > 0) return a.violation < b.violation;
  let better = false;
  for (let i = 0; i < a.objectives.length; i++) {
    if (a.objectives[i] > b.objectives[i]) return false;
    if (a.objectives[i] < b.objectives[i]) better = true;
  }
  return better;
}

/** Fast non-dominated sort: array of fronts (arrays of indices); sets .rank. */
export function nonDominatedSort(pop) {
  const n = pop.length;
  const dominatedBy = Array.from({ length: n }, () => []);
  const count = new Array(n).fill(0);
  const fronts = [[]];
  for (let p = 0; p < n; p++) {
    for (let q = 0; q < n; q++) {
      if (p === q) continue;
      if (dominates(pop[p], pop[q])) dominatedBy[p].push(q);
      else if (dominates(pop[q], pop[p])) count[p]++;
    }
    if (count[p] === 0) { pop[p].rank = 0; fronts[0].push(p); }
  }
  let i = 0;
  while (fronts[i].length) {
    const next = [];
    for (const p of fronts[i]) {
      for (const q of dominatedBy[p]) {
        if (--count[q] === 0) { pop[q].rank = i + 1; next.push(q); }
      }
    }
    i++;
    fronts.push(next);
  }
  fronts.pop();
  return fronts;
}

/** Crowding distance within one front; sets .crowding. */
export function crowdingDistance(pop, front) {
  for (const i of front) pop[i].crowding = 0;
  if (front.length <= 2) { for (const i of front) pop[i].crowding = Infinity; return; }
  const m = pop[front[0]].objectives.length;
  for (let k = 0; k < m; k++) {
    const sorted = [...front].sort((a, b) => pop[a].objectives[k] - pop[b].objectives[k]);
    const lo = pop[sorted[0]].objectives[k];
    const hi = pop[sorted[sorted.length - 1]].objectives[k];
    pop[sorted[0]].crowding = Infinity;
    pop[sorted[sorted.length - 1]].crowding = Infinity;
    if (hi - lo <= 0) continue;
    for (let j = 1; j < sorted.length - 1; j++) {
      pop[sorted[j]].crowding += (pop[sorted[j + 1]].objectives[k] - pop[sorted[j - 1]].objectives[k]) / (hi - lo);
    }
  }
}

function better(a, b) {
  if (a.rank !== b.rank) return a.rank < b.rank;
  return a.crowding > b.crowding;
}

function sbx(rng, x1, x2, lo, hi, eta) {
  if (rng() > 0.5 || Math.abs(x1 - x2) < 1e-12) return [x1, x2];
  const u = rng();
  const beta = u <= 0.5 ? Math.pow(2 * u, 1 / (eta + 1)) : Math.pow(1 / (2 * (1 - u)), 1 / (eta + 1));
  const c1 = 0.5 * ((1 + beta) * x1 + (1 - beta) * x2);
  const c2 = 0.5 * ((1 - beta) * x1 + (1 + beta) * x2);
  return [Math.min(hi, Math.max(lo, c1)), Math.min(hi, Math.max(lo, c2))];
}

function polyMutate(rng, x, lo, hi, eta) {
  const span = hi - lo;
  if (span <= 0) return x;
  const u = rng();
  const delta = u < 0.5 ? Math.pow(2 * u, 1 / (eta + 1)) - 1 : 1 - Math.pow(2 * (1 - u), 1 / (eta + 1));
  return Math.min(hi, Math.max(lo, x + delta * span));
}

/**
 * Run NSGA-II.
 * @param {object} problem
 * @param {number[]} problem.lower
 * @param {number[]} problem.upper
 * @param {boolean} [problem.integer] round every variable
 * @param {(x: number[]) => Promise<{ objectives: number[], violation?: number }> | { objectives: number[], violation?: number }} problem.evaluate
 * @param {number[][]} [problem.seeds] starting solutions (e.g. the current design)
 * @param {object} [opts]
 * @returns {Promise<{ population: any[], front: any[], evaluations: number, history: any[] }>}
 */
export async function nsga2(problem, { populationSize = 24, generations = 20, seed = 1, etaC = 15, etaM = 20, crossoverProb = 0.9, onGeneration = null, shouldStop = null } = {}) {
  const rng = makeRng(seed);
  const n = problem.lower.length;
  const pm = 1 / Math.max(1, n);
  const round = (x) => (problem.integer ? x.map((v, i) => Math.min(problem.upper[i], Math.max(problem.lower[i], Math.round(v)))) : x);
  const cache = new Map();
  let evaluations = 0;
  const evaluate = async (x) => {
    const key = x.join(',');
    if (cache.has(key)) return cache.get(key);
    const r = await problem.evaluate(x);
    evaluations++;
    const ind = { x, objectives: r.objectives, violation: Math.max(0, r.violation || 0), extra: r.extra };
    cache.set(key, ind);
    return { ...ind };
  };
  let pop = [];
  for (const s of problem.seeds || []) if (pop.length < populationSize) pop.push(await evaluate(round(s)));
  while (pop.length < populationSize) {
    const x = problem.lower.map((lo, i) => lo + rng() * (problem.upper[i] - lo));
    pop.push(await evaluate(round(x)));
  }
  const history = [];
  const rankAll = (p) => { const fronts = nonDominatedSort(p); for (const f of fronts) crowdingDistance(p, f); return fronts; };
  rankAll(pop);
  for (let g = 0; g < generations; g++) {
    if (shouldStop && shouldStop()) break;
    const tournament = () => { const a = pop[Math.floor(rng() * pop.length)]; const b = pop[Math.floor(rng() * pop.length)]; return better(a, b) ? a : b; };
    const children = [];
    while (children.length < populationSize) {
      const p1 = tournament().x;
      const p2 = tournament().x;
      const c1 = [...p1];
      const c2 = [...p2];
      if (rng() < crossoverProb) {
        for (let i = 0; i < n; i++) [c1[i], c2[i]] = sbx(rng, p1[i], p2[i], problem.lower[i], problem.upper[i], etaC);
      }
      for (let i = 0; i < n; i++) {
        if (rng() < pm) c1[i] = polyMutate(rng, c1[i], problem.lower[i], problem.upper[i], etaM);
        if (rng() < pm) c2[i] = polyMutate(rng, c2[i], problem.lower[i], problem.upper[i], etaM);
      }
      children.push(await evaluate(round(c1)));
      if (children.length < populationSize) children.push(await evaluate(round(c2)));
    }
    // Copies of a parent (no crossover, no mutation) would crowd the front
    // with identical points; keep one of each unless that leaves too few.
    const seen = new Set();
    const unique = [];
    const dupes = [];
    for (const ind of pop.concat(children)) {
      const key = ind.x.join(',');
      if (seen.has(key)) dupes.push(ind); else { seen.add(key); unique.push(ind); }
    }
    const merged = unique.length >= populationSize ? unique : unique.concat(dupes.slice(0, populationSize - unique.length));
    const fronts = rankAll(merged);
    const next = [];
    for (const f of fronts) {
      if (next.length + f.length <= populationSize) { for (const i of f) next.push(merged[i]); continue; }
      const sorted = [...f].sort((a, b) => merged[b].crowding - merged[a].crowding);
      for (const i of sorted.slice(0, populationSize - next.length)) next.push(merged[i]);
      break;
    }
    pop = next;
    rankAll(pop);
    const front = pop.filter((p) => p.rank === 0 && p.violation === 0);
    history.push({ generation: g + 1, evaluations, frontSize: front.length });
    if (onGeneration) await onGeneration({ generation: g + 1, generations, population: pop, front, evaluations });
  }
  const front = pop.filter((p) => p.rank === 0);
  return { population: pop, front, evaluations, history };
}
