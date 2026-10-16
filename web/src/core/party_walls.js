// @ts-check
// Walls built against another building (party walls) have no windows and see
// no sky: a point just in front of such a wall lies inside the other
// building's footprint, between its bottom and its roof. Above a lower
// neighbour the same wall is open again. A grid of footprint boxes keeps the
// test to the few buildings near each point.

function inside(x, y, ring) {
  let odd = false;
  for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
    const [xi, yi] = ring[i], [xj, yj] = ring[j];
    if ((yi > y) !== (yj > y) && x < ((xj - xi) * (y - yi)) / (yj - yi) + xi) odd = !odd;
  }
  return odd;
}

/**
 * @param {{ id: number, rings: number[][][], bottom: number, top: number }[]} buildings
 *   outer rings in local metres, absolute bottom and roof elevations
 * @param {number} [cell] size of the index cells (m)
 */
export function coverIndex(buildings, cell = 25) {
  const cells = new Map();
  const key = (cx, cy) => `${cx},${cy}`;
  buildings.forEach((b, k) => {
    let minX = Infinity, maxX = -Infinity, minY = Infinity, maxY = -Infinity;
    for (const ring of b.rings) for (const [x, y] of ring) { minX = Math.min(minX, x); maxX = Math.max(maxX, x); minY = Math.min(minY, y); maxY = Math.max(maxY, y); }
    if (!Number.isFinite(minX)) return;
    for (let cx = Math.floor(minX / cell); cx <= Math.floor(maxX / cell); cx++) {
      for (let cy = Math.floor(minY / cell); cy <= Math.floor(maxY / cell); cy++) {
        const list = cells.get(key(cx, cy));
        if (list) list.push(k); else cells.set(key(cx, cy), [k]);
      }
    }
  });
  return { buildings, cells, cell, key };
}

/**
 * Height spans [bottom, top] of the buildings (other than `ownId`) whose
 * footprint holds the point; empty when the point is in the open.
 * @returns {number[][]}
 */
export function coverAt(index, x, y, ownId) {
  const list = index.cells.get(index.key(Math.floor(x / index.cell), Math.floor(y / index.cell)));
  if (!list) return [];
  const out = [];
  for (const k of list) {
    const b = index.buildings[k];
    if (b.id === ownId) continue;
    if (b.rings.some((ring) => inside(x, y, ring))) out.push([b.bottom, b.top]);
  }
  return out;
}

/** Whether a wall point at absolute height z, with these spans in front of it, is open to the air. */
export function isOpen(z, spans) {
  for (const [bottom, top] of spans) if (z >= bottom && z < top) return false;
  return true;
}
