/**
 * Seed-deterministic infinite chunk maze generator, Wiki-faithful per-level
 * architecture/props, cross-chunk seam solver, AABB circle collision resolver,
 * and Canvas 2D procedural texture fallback.
 *
 * Pure ES module (safe to import directly in Node.js without DOM or Three.js).
 * Mirrors a future Godot 4.3 ChunkGenerator for zero-bandwidth terrain sync.
 *
 * Source: The Backrooms Wiki (Fandom) — https://backrooms.fandom.com/wiki/Backrooms_Wiki
 * License: CC-BY-SA-3.0 — https://creativecommons.org/licenses/by-sa/3.0/
 */

import { getLevelData } from "./lore_data.js";

export const CHUNK_CELLS = 8;
export const CELL_SIZE = 3.0;
export const CHUNK_WORLD_SIZE = CHUNK_CELLS * CELL_SIZE; // 24.0 meters

export const CELL_TYPES = Object.freeze({
  EMPTY: "EMPTY",
  WALL: "WALL",
  PILLAR: "PILLAR",
  GLITCH_WALL: "GLITCH_WALL",
  OUTLET_WALL: "OUTLET_WALL",
  DOOR: "DOOR",
  STAIRS: "STAIRS",
  MANILA_WALL: "MANILA_WALL",
  PUDDLE: "PUDDLE",
  CAR: "CAR",
  PIPE: "PIPE",
  KEY_PEDESTAL: "KEY_PEDESTAL",
});

export const SOLID_CELL_TYPES = new Set([
  CELL_TYPES.WALL,
  CELL_TYPES.PILLAR,
  CELL_TYPES.GLITCH_WALL,
  CELL_TYPES.OUTLET_WALL,
  CELL_TYPES.MANILA_WALL,
  CELL_TYPES.CAR,
]);

/**
 * FNV-1a 32-bit unsigned hash from arbitrary seed string.
 */
export function hashStringToSeed(str) {
  let h = 0x811c9dc5;
  const text = String(str ?? "1999");
  for (let i = 0; i < text.length; i += 1) {
    h ^= text.charCodeAt(i);
    h = Math.imul(h, 0x01000193) >>> 0;
  }
  return h >>> 0 || 1999;
}

/**
 * Deterministic 32-bit unsigned coordinate hash.
 */
export function hashCoords(worldSeed, levelId, cx, cz, salt = 0) {
  let h = (Number(worldSeed) || 1999) >>> 0;
  const key = `${levelId}:${cx}:${cz}:${salt}`;
  for (let i = 0; i < key.length; i += 1) {
    h ^= key.charCodeAt(i);
    h = Math.imul(h, 0x01000193) >>> 0;
  }
  h ^= h >>> 16;
  h = Math.imul(h, 0x85ebca6b) >>> 0;
  h ^= h >>> 13;
  h = Math.imul(h, 0xc2b2ae35) >>> 0;
  h ^= h >>> 16;
  return h >>> 0;
}

/**
 * Mulberry32 fast deterministic PRNG returning [0, 1).
 */
export function createMulberry32(seed) {
  let state = seed >>> 0;
  return function nextRandom() {
    state = (state + 0x6d2b79f5) >>> 0;
    let t = Math.imul(state ^ (state >>> 15), 1 | state);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

export function chunkKey(levelId, cx, cz) {
  return `${levelId}:${cx}:${cz}`;
}

/**
 * Symmetric cross-chunk border opening query.
 * Guarantees neighboring chunks (ax, az) and (bx, bz) always agree on open
 * border slots, preventing sealed walls across chunk seams.
 */
export function isBorderOpening(worldSeed, levelId, ax, az, bx, bz, slot = 0) {
  const swap = ax > bx || (ax === bx && az > bz);
  const c1x = swap ? bx : ax;
  const c1z = swap ? bz : az;
  const c2x = swap ? ax : bx;
  const c2z = swap ? az : bz;

  if (levelId === "level_0") {
    const edgeHash = hashCoords(worldSeed, `level_0:edge:${c1x}:${c1z}:${c2x}:${c2z}`, 0, 0, 91);
    const interiorCount = CHUNK_CELLS - 2;
    const isOriginToManilaEdge = c1x === 0 && c1z === 0 && c2x === 1 && c2z === 0;
    if (isOriginToManilaEdge) {
      // Keep staggered openings well-separated around the guaranteed slot=4 Manila link
      const door1 = 1 + (edgeHash % 2);
      const hasSecond = ((edgeHash >>> 8) % 10) < 5;
      return slot === 4 || slot === door1 || (hasSecond && slot === 6);
    }
    const door1 = 1 + (edgeHash % interiorCount);
    const hasSecond = ((edgeHash >>> 8) % 10) < 5;
    const door2 = 1 + ((door1 - 1 + 2 + ((edgeHash >>> 12) % 3)) % interiorCount);
    return slot === door1 || (hasSecond && slot === door2);
  }

  if (
    ((ax === 0 && az === 0) || (bx === 0 && bz === 0)) &&
    slot >= 0 &&
    slot <= 2
  ) {
    return true;
  }

  if (slot === 2 || slot === 5) {
    return true;
  }
  const h = hashCoords(worldSeed, `${levelId}:seam:${c1x}:${c1z}:${c2x}:${c2z}`, slot, 0, 77);
  return h % 10 < 5;
}

function makeEmptyGrid() {
  return Array.from({ length: CHUNK_CELLS }, () =>
    Array.from({ length: CHUNK_CELLS }, () => CELL_TYPES.EMPTY)
  );
}

function makeWallStyleGrid() {
  return Array.from({ length: CHUNK_CELLS }, () =>
    Array.from({ length: CHUNK_CELLS }, () => "solid")
  );
}

function carveCorridor(grid, x0, z0, x1, z1) {
  let x = x0;
  let z = z0;
  grid[z][x] = CELL_TYPES.EMPTY;
  while (x !== x1) {
    x += x < x1 ? 1 : -1;
    grid[z][x] = CELL_TYPES.EMPTY;
  }
  while (z !== z1) {
    z += z < z1 ? 1 : -1;
    grid[z][x] = CELL_TYPES.EMPTY;
  }
}

function applyCrossChunkSeams(grid, worldSeed, levelId, cx, cz) {
  for (let lx = 0; lx < CHUNK_CELLS; lx += 1) {
    if (isBorderOpening(worldSeed, levelId, cx, cz, cx, cz - 1, lx)) {
      if (SOLID_CELL_TYPES.has(grid[0][lx])) grid[0][lx] = CELL_TYPES.EMPTY;
      if (SOLID_CELL_TYPES.has(grid[1][lx])) grid[1][lx] = CELL_TYPES.EMPTY;
    }
    if (isBorderOpening(worldSeed, levelId, cx, cz, cx, cz + 1, lx)) {
      if (SOLID_CELL_TYPES.has(grid[CHUNK_CELLS - 1][lx])) grid[CHUNK_CELLS - 1][lx] = CELL_TYPES.EMPTY;
      if (SOLID_CELL_TYPES.has(grid[CHUNK_CELLS - 2][lx])) grid[CHUNK_CELLS - 2][lx] = CELL_TYPES.EMPTY;
    }
  }
  for (let lz = 0; lz < CHUNK_CELLS; lz += 1) {
    if (isBorderOpening(worldSeed, levelId, cx, cz, cx - 1, cz, lz)) {
      if (SOLID_CELL_TYPES.has(grid[lz][0])) grid[lz][0] = CELL_TYPES.EMPTY;
      if (SOLID_CELL_TYPES.has(grid[lz][1])) grid[lz][1] = CELL_TYPES.EMPTY;
    }
    if (isBorderOpening(worldSeed, levelId, cx, cz, cx + 1, cz, lz)) {
      if (SOLID_CELL_TYPES.has(grid[lz][CHUNK_CELLS - 1])) grid[lz][CHUNK_CELLS - 1] = CELL_TYPES.EMPTY;
      if (SOLID_CELL_TYPES.has(grid[lz][CHUNK_CELLS - 2])) grid[lz][CHUNK_CELLS - 2] = CELL_TYPES.EMPTY;
    }
  }
}

function makeSolidGrid() {
  return Array.from({ length: CHUNK_CELLS }, () =>
    Array.from({ length: CHUNK_CELLS }, () => CELL_TYPES.WALL)
  );
}

function cellKey(lx, lz) {
  return `${lx}:${lz}`;
}

function isInBounds(lx, lz) {
  return lx >= 0 && lx < CHUNK_CELLS && lz >= 0 && lz < CHUNK_CELLS;
}

function isInteriorCell(lx, lz) {
  return lx >= 1 && lx < CHUNK_CELLS - 1 && lz >= 1 && lz < CHUNK_CELLS - 1;
}

function isWalkableCell(grid, lx, lz) {
  return isInBounds(lx, lz) && !SOLID_CELL_TYPES.has(grid[lz][lx]);
}

const DIRS_4 = [
  [1, 0],
  [-1, 0],
  [0, 1],
  [0, -1],
];

function getLevel0BorderOpenings(worldSeed, cx, cz) {
  const openings = [];
  for (let i = 0; i < CHUNK_CELLS; i += 1) {
    if (isBorderOpening(worldSeed, "level_0", cx, cz, cx, cz - 1, i)) openings.push({ lx: i, lz: 0 });
    if (isBorderOpening(worldSeed, "level_0", cx, cz, cx, cz + 1, i)) openings.push({ lx: i, lz: CHUNK_CELLS - 1 });
    if (isBorderOpening(worldSeed, "level_0", cx, cz, cx - 1, cz, i)) openings.push({ lx: 0, lz: i });
    if (isBorderOpening(worldSeed, "level_0", cx, cz, cx + 1, cz, i)) openings.push({ lx: CHUNK_CELLS - 1, lz: i });
  }
  return openings;
}

function wouldCreate2x2Open(grid, lx, lz) {
  const isOpenAt = (gx, gz) =>
    (gx === lx && gz === lz) || isWalkableCell(grid, gx, gz);
  for (let dz = -1; dz <= 0; dz += 1) {
    for (let dx = -1; dx <= 0; dx += 1) {
      if (
        isOpenAt(lx + dx, lz + dz) &&
        isOpenAt(lx + dx + 1, lz + dz) &&
        isOpenAt(lx + dx, lz + dz + 1) &&
        isOpenAt(lx + dx + 1, lz + dz + 1)
      ) {
        return true;
      }
    }
  }
  return false;
}

function computeWalkableBfs(grid, startX, startZ) {
  const visited = Array.from({ length: CHUNK_CELLS }, () => Array(CHUNK_CELLS).fill(false));
  const dist = Array.from({ length: CHUNK_CELLS }, () => Array(CHUNK_CELLS).fill(-1));
  if (!isWalkableCell(grid, startX, startZ)) {
    return { visited, dist };
  }
  const queue = [[startX, startZ]];
  visited[startZ][startX] = true;
  dist[startZ][startX] = 0;
  for (let head = 0; head < queue.length; head += 1) {
    const [x, z] = queue[head];
    const dNext = dist[z][x] + 1;
    for (const [dx, dz] of DIRS_4) {
      const nx = x + dx;
      const nz = z + dz;
      if (isWalkableCell(grid, nx, nz) && !visited[nz][nx]) {
        visited[nz][nx] = true;
        dist[nz][nx] = dNext;
        queue.push([nx, nz]);
      }
    }
  }
  return { visited, dist };
}

function checkLevel0Connectivity(grid, startX, startZ, borderOpenings, interactables = []) {
  if (!isWalkableCell(grid, startX, startZ)) return false;
  const { visited } = computeWalkableBfs(grid, startX, startZ);

  for (const op of borderOpenings) {
    if (!visited[op.lz]?.[op.lx]) return false;
  }
  for (const item of interactables) {
    if (item.lx == null || item.lz == null) continue;
    const ix = item.lx;
    const iz = item.lz;
    if (isWalkableCell(grid, ix, iz)) {
      if (!visited[iz][ix]) return false;
    } else {
      const adjOk = DIRS_4.some(([dx, dz]) => isWalkableCell(grid, ix + dx, iz + dz) && visited[iz + dz][ix + dx]);
      if (!adjOk) return false;
    }
  }
  return true;
}

function connectTargetWeighted(grid, startX, startZ, targetX, targetZ, protectedSolid, allowPerimeterKeys) {
  const { visited } = computeWalkableBfs(grid, startX, startZ);
  if (visited[targetZ]?.[targetX]) return;

  const INF = 1e9;
  const bestCost = Array.from({ length: CHUNK_CELLS }, () => Array(CHUNK_CELLS).fill(INF));
  const prevCell = Array.from({ length: CHUNK_CELLS }, () => Array(CHUNK_CELLS).fill(null));
  const pq = [];

  for (let lz = 0; lz < CHUNK_CELLS; lz += 1) {
    for (let lx = 0; lx < CHUNK_CELLS; lx += 1) {
      if (visited[lz][lx]) {
        bestCost[lz][lx] = 0;
        pq.push({ x: lx, z: lz, cost: 0, dir: -1 });
      }
    }
  }
  if (pq.length === 0) {
    grid[targetZ][targetX] = CELL_TYPES.EMPTY;
    return;
  }

  while (pq.length > 0) {
    let minIdx = 0;
    for (let i = 1; i < pq.length; i += 1) {
      if (pq[i].cost < pq[minIdx].cost) minIdx = i;
    }
    const cur = pq.splice(minIdx, 1)[0];
    if (cur.cost > bestCost[cur.z][cur.x]) continue;
    if (cur.x === targetX && cur.z === targetZ) break;

    for (let d = 0; d < DIRS_4.length; d += 1) {
      const nx = cur.x + DIRS_4[d][0];
      const nz = cur.z + DIRS_4[d][1];
      if (!isInBounds(nx, nz)) continue;
      const nKey = cellKey(nx, nz);
      if (protectedSolid.has(nKey)) continue;

      const isTarget = nx === targetX && nz === targetZ;
      if (
        !isInteriorCell(nx, nz) &&
        !isTarget &&
        !allowPerimeterKeys.has(nKey) &&
        !isWalkableCell(grid, nx, nz)
      ) {
        continue;
      }

      const carveCost = isWalkableCell(grid, nx, nz) ? 0.1 : 10.0;
      const turnPenalty = cur.dir !== -1 && cur.dir === d ? 2.4 : 0.8;
      const nextCost = cur.cost + carveCost + turnPenalty;
      if (nextCost < bestCost[nz][nx]) {
        bestCost[nz][nx] = nextCost;
        prevCell[nz][nx] = [cur.x, cur.z];
        pq.push({ x: nx, z: nz, cost: nextCost, dir: d });
      }
    }
  }

  if (bestCost[targetZ][targetX] < INF) {
    let cx = targetX;
    let cz = targetZ;
    while (cx != null && cz != null) {
      if (!protectedSolid.has(cellKey(cx, cz)) && grid[cz][cx] === CELL_TYPES.WALL) {
        grid[cz][cx] = CELL_TYPES.EMPTY;
      }
      const p = prevCell[cz][cx];
      if (!p) break;
      cx = p[0];
      cz = p[1];
    }
  }
}

function assignLevel0WallStyles(grid, wallStyles, cx, cz, chunkHash, shiftEpoch, rng) {
  let archedCount = 0;
  let hasPillar = false;

  for (let lz = 0; lz < CHUNK_CELLS; lz += 1) {
    for (let lx = 0; lx < CHUNK_CELLS; lx += 1) {
      const ct = grid[lz][lx];
      if (ct === CELL_TYPES.PILLAR) {
        wallStyles[lz][lx] = "l0_pillar";
        hasPillar = true;
      } else if (ct === CELL_TYPES.MANILA_WALL) {
        wallStyles[lz][lx] = "manila_wall";
      } else if (ct === CELL_TYPES.GLITCH_WALL || ct === CELL_TYPES.OUTLET_WALL) {
        wallStyles[lz][lx] = "solid";
      } else {
        wallStyles[lz][lx] = "solid";
      }
    }
  }

  const colonnadePreferred = chunkHash % 3 === 2 || (cx === 0 && cz === 0 && shiftEpoch === 0);
  const thinXCandidates = [];

  for (let lz = 1; lz < CHUNK_CELLS - 1; lz += 1) {
    for (let lx = 1; lx < CHUNK_CELLS - 1; lx += 1) {
      if (grid[lz][lx] !== CELL_TYPES.WALL) continue;
      if (cx === 0 && cz === 0 && shiftEpoch === 0 && lx === 3 && lz === 3) continue;

      const leftSolid = SOLID_CELL_TYPES.has(grid[lz][lx - 1]);
      const rightSolid = SOLID_CELL_TYPES.has(grid[lz][lx + 1]);
      const northSolid = SOLID_CELL_TYPES.has(grid[lz - 1][lx]);
      const southSolid = SOLID_CELL_TYPES.has(grid[lz + 1][lx]);

      if (leftSolid && rightSolid && !northSolid && !southSolid) {
        thinXCandidates.push([lx, lz]);
        if (colonnadePreferred && archedCount < 2 && rng() < 0.38) {
          wallStyles[lz][lx] = "arched_divider";
          archedCount += 1;
        } else {
          wallStyles[lz][lx] = "thin_x";
        }
      } else if (northSolid && southSolid && !leftSolid && !rightSolid) {
        wallStyles[lz][lx] = rng() < 0.72 ? "thin_z" : "solid";
      }
    }
  }

  if (cx === 0 && cz === 0 && shiftEpoch === 0 && archedCount === 0) {
    if (thinXCandidates.length > 0) {
      const [ax, az] = thinXCandidates[0];
      wallStyles[az][ax] = "arched_divider";
      archedCount = 1;
    } else {
      for (let lz = 1; lz < CHUNK_CELLS - 1 && archedCount === 0; lz += 1) {
        for (let lx = 1; lx < CHUNK_CELLS - 1; lx += 1) {
          if (grid[lz][lx] !== CELL_TYPES.WALL || (lx === 3 && lz === 3)) continue;
          const leftSolid = SOLID_CELL_TYPES.has(grid[lz][lx - 1]);
          const rightSolid = SOLID_CELL_TYPES.has(grid[lz][lx + 1]);
          const northOpen = !SOLID_CELL_TYPES.has(grid[lz - 1][lx]);
          const southOpen = !SOLID_CELL_TYPES.has(grid[lz + 1][lx]);
          if ((leftSolid || rightSolid) && northOpen && southOpen) {
            wallStyles[lz][lx] = "arched_divider";
            archedCount = 1;
            break;
          }
        }
      }
    }
  }

  return { archedCount, hasPillar };
}

function extractChunkWalls(grid, wallStyles, cx, cz, levelData, zoneTag) {
  const walls = [];
  for (let lz = 0; lz < CHUNK_CELLS; lz += 1) {
    for (let lx = 0; lx < CHUNK_CELLS; lx += 1) {
      const cellType = grid[lz][lx];
      if (!SOLID_CELL_TYPES.has(cellType)) continue;

      const style = wallStyles[lz][lx] || "solid";
      let rect;
      if (cellType === CELL_TYPES.PILLAR || style === "parking_pillar" || style === "l0_pillar") {
        const inset = style === "parking_pillar" ? 0.90 : 1.02;
        rect = cellWorldRect(cx, cz, lx, lz, inset, inset);
      } else if (cellType === CELL_TYPES.CAR) {
        rect = cellWorldRect(cx, cz, lx, lz, 0.38, 0.38);
      } else if (style === "thin_x" || style === "arched_divider") {
        rect = cellWorldRect(cx, cz, lx, lz, 0, 1.31);
      } else if (style === "thin_z") {
        rect = cellWorldRect(cx, cz, lx, lz, 1.31, 0);
      } else {
        rect = cellWorldRect(cx, cz, lx, lz, 0, 0);
      }

      walls.push({
        lx,
        lz,
        cellType,
        wallStyle: style,
        zoneLabel: style === "parking_pillar" ? zoneTag : null,
        minX: rect.minX,
        maxX: rect.maxX,
        minZ: rect.minZ,
        maxZ: rect.maxZ,
        height:
          cellType === CELL_TYPES.CAR
            ? 1.45
            : levelData.environment.ceilingHeight,
      });
    }
  }
  return walls;
}

function buildLevel0DerivedData({ grid, wallStyles, cx, cz, chunkHash, levelData, interactables, shiftEpoch }) {
  const rng = createMulberry32((chunkHash ^ 0x9e3779b9) >>> 0);
  const walls = extractChunkWalls(grid, wallStyles, cx, cz, levelData, "L0");
  const props = [];
  const propColliders = [];
  const lights = [];

  const interactKeys = new Set();
  for (const item of interactables) {
    if (item.lx != null && item.lz != null) interactKeys.add(cellKey(item.lx, item.lz));
  }

  // Off-grid staggered drywall wing walls creating visual blind corners & doorway baffles
  let wingCount = 0;
  for (let lz = 1; lz < CHUNK_CELLS - 1 && wingCount < 4; lz += 1) {
    for (let lx = 1; lx < CHUNK_CELLS - 1 && wingCount < 4; lx += 1) {
      const cell = grid[lz][lx];
      if (SOLID_CELL_TYPES.has(cell) || cell === CELL_TYPES.STAIRS || cell === CELL_TYPES.DOOR) continue;
      if (interactKeys.has(cellKey(lx, lz))) continue;
      if (cx === 0 && cz === 0 && ((lx === 0 && lz === 0) || (lx === 1 && lz === 0) || (lx === 2 && lz === 3))) continue;
      if (((lx * 7 + lz * 13 + (chunkHash >>> 4)) % 10) >= 3) continue;

      const leftSolid = SOLID_CELL_TYPES.has(grid[lz][lx - 1]) && (wallStyles[lz][lx - 1] || "solid") === "solid";
      const rightSolid = SOLID_CELL_TYPES.has(grid[lz][lx + 1]) && (wallStyles[lz][lx + 1] || "solid") === "solid";
      const northSolid = SOLID_CELL_TYPES.has(grid[lz - 1][lx]) && (wallStyles[lz - 1][lx] || "solid") === "solid";
      const southSolid = SOLID_CELL_TYPES.has(grid[lz + 1][lx]) && (wallStyles[lz + 1][lx] || "solid") === "solid";

      const r = cellWorldRect(cx, cz, lx, lz);
      let wx = null;
      let wz = null;
      let ww = 0;
      let wd = 0;

      if ((northSolid !== southSolid) && !leftSolid && !rightSolid) {
        ww = 0.28;
        wd = 1.04;
        wx = r.centerX + (rng() < 0.5 ? -0.35 : 0.35);
        wz = northSolid ? r.minZ + wd * 0.5 : r.maxZ - wd * 0.5;
      } else if ((leftSolid !== rightSolid) && !northSolid && !southSolid) {
        ww = 1.04;
        wd = 0.28;
        wz = r.centerZ + (rng() < 0.5 ? -0.35 : 0.35);
        wx = leftSolid ? r.minX + ww * 0.5 : r.maxX - ww * 0.5;
      }

      if (wx !== null && wz !== null) {
        props.push({
          kind: "LEVEL0_WING_WALL",
          x: wx,
          z: wz,
          w: ww,
          d: wd,
          height: levelData.environment.ceilingHeight,
        });
        propColliders.push({
          kind: "LEVEL0_WING_WALL",
          minX: wx - ww * 0.5,
          maxX: wx + ww * 0.5,
          minZ: wz - wd * 0.5,
          maxZ: wz + wd * 0.5,
          height: levelData.environment.ceilingHeight,
        });
        wingCount += 1;
      }
    }
  }

  // Scattered knee-height electrical outlets on true solid wall faces & carpet furniture indents
  let outletCount = 0;
  let indentCount = 0;
  for (let lz = 0; lz < CHUNK_CELLS; lz += 1) {
    for (let lx = 0; lx < CHUNK_CELLS; lx += 1) {
      const cell = grid[lz][lx];
      if (SOLID_CELL_TYPES.has(cell) || cell === CELL_TYPES.STAIRS || cell === CELL_TYPES.DOOR) continue;

      const r = cellWorldRect(cx, cz, lx, lz);
      if (isInteriorCell(lx, lz)) {
        const solidFace = (nx, nz) =>
          isInBounds(nx, nz) &&
          grid[nz][nx] === CELL_TYPES.WALL &&
          (wallStyles[nz][nx] || "solid") === "solid";
        const forceOutlet = outletCount === 0 && cx === 0 && cz === 0 && solidFace(lx + 1, lz);
        if (forceOutlet || ((lx * 5 + lz * 11 + chunkHash) % 4 === 0)) {
          if (solidFace(lx, lz - 1)) {
            props.push({ kind: "WALL_OUTLET", x: r.centerX, z: r.minZ + 0.02, rotY: 0 });
            outletCount += 1;
          } else if (solidFace(lx, lz + 1)) {
            props.push({ kind: "WALL_OUTLET", x: r.centerX, z: r.maxZ - 0.02, rotY: Math.PI });
            outletCount += 1;
          } else if (solidFace(lx - 1, lz)) {
            props.push({ kind: "WALL_OUTLET", x: r.minX + 0.02, z: r.centerZ, rotY: Math.PI * 0.5 });
            outletCount += 1;
          } else if (solidFace(lx + 1, lz)) {
            props.push({ kind: "WALL_OUTLET", x: r.maxX - 0.02, z: r.centerZ, rotY: -Math.PI * 0.5 });
            outletCount += 1;
          }
        }
      }

      const openDeg = DIRS_4.reduce((acc, [dx, dz]) => acc + (isWalkableCell(grid, lx + dx, lz + dz) ? 1 : 0), 0);
      const isDeadEnd = openDeg === 1;
      const forceIndent = cx === 0 && cz === 0 && indentCount < 2;
      if (forceIndent || rng() < (isDeadEnd ? 0.34 : 0.12)) {
        props.push({
          kind: "CARPET_INDENT",
          x: r.centerX + (rng() - 0.5) * 0.55,
          z: r.centerZ + (rng() - 0.5) * 0.55,
          w: 0.72 + rng() * 0.62,
          d: 0.62 + rng() * 0.62,
          rotY: rng() * Math.PI,
        });
        indentCount += 1;
      }
    }
  }
  if (outletCount === 0) {
    const sw = walls.find((w) => w.cellType === CELL_TYPES.WALL && w.wallStyle === "solid");
    if (sw) {
      props.push({ kind: "WALL_OUTLET", x: (sw.minX + sw.maxX) * 0.5, z: sw.minZ - 0.02, rotY: Math.PI });
    }
  }

  // Inconsistently placed fluorescent ceiling troffers (5-7 per chunk, >= 4 in chunk 0,0)
  const lightCandidates = [];
  for (let lz = 0; lz < CHUNK_CELLS; lz += 1) {
    for (let lx = 0; lx < CHUNK_CELLS; lx += 1) {
      if (!SOLID_CELL_TYPES.has(grid[lz][lx])) {
        const deg = DIRS_4.reduce((acc, [dx, dz]) => acc + (isWalkableCell(grid, lx + dx, lz + dz) ? 1 : 0), 0);
        lightCandidates.push({ lx, lz, deg });
      }
    }
  }
  const targetLights = Math.min(lightCandidates.length, cx === 0 && cz === 0 && shiftEpoch === 0 ? 6 : 5 + (chunkHash % 3));
  for (let i = 0; i < lightCandidates.length && lights.length < targetLights; i += 1) {
    const c = lightCandidates[(i * 5 + (chunkHash % Math.max(1, lightCandidates.length))) % lightCandidates.length];
    if (c.deg === 1 && (i % 3 === 0) && lights.length >= 2) continue; // Keep occasional dead-ends darker
    const r = cellWorldRect(cx, cz, c.lx, c.lz);
    if (lights.some((lt) => Math.hypot(lt.x - r.centerX, lt.z - r.centerZ) < 4.0)) continue;
    lights.push({
      x: r.centerX + (rng() - 0.5) * 0.6,
      y: levelData.environment.ceilingHeight - 0.04,
      z: r.centerZ + (rng() - 0.5) * 0.6,
      rotY: rng() < 0.42 ? Math.PI * 0.5 : 0,
      flickerPhase: ((c.lx * 7 + c.lz * 13 + Math.abs(cx + cz)) % 17) * 0.37,
    });
  }
  const minLights = cx === 0 && cz === 0 ? 4 : 3;
  for (const c of lightCandidates) {
    if (lights.length >= minLights) break;
    const r = cellWorldRect(cx, cz, c.lx, c.lz);
    if (lights.some((lt) => Math.hypot(lt.x - r.centerX, lt.z - r.centerZ) < 2.2)) continue;
    lights.push({
      x: r.centerX + (rng() - 0.5) * 0.45,
      y: levelData.environment.ceilingHeight - 0.04,
      z: r.centerZ + (rng() - 0.5) * 0.45,
      rotY: rng() < 0.35 ? Math.PI * 0.5 : 0,
      flickerPhase: ((c.lx + c.lz) % 11) * 0.4,
    });
  }

  return { walls, props, propColliders, lights };
}

function cellWorldRect(cx, cz, lx, lz, insetX = 0, insetZ = insetX) {
  const minX = (cx * CHUNK_CELLS + lx) * CELL_SIZE + insetX;
  const maxX = (cx * CHUNK_CELLS + lx + 1) * CELL_SIZE - insetX;
  const minZ = (cz * CHUNK_CELLS + lz) * CELL_SIZE + insetZ;
  const maxZ = (cz * CHUNK_CELLS + lz + 1) * CELL_SIZE - insetZ;
  return {
    minX,
    maxX,
    minZ,
    maxZ,
    centerX: (minX + maxX) * 0.5,
    centerZ: (minZ + maxZ) * 0.5,
  };
}

/**
 * Pure deterministic chunk generator. Identical inputs always yield identical
 * deep JSON output across browser, Node tests, and Godot port reference.
 */
export function generateChunkData(levelId, cx, cz, worldSeed = 1999, shiftEpoch = 0) {
  const levelData = getLevelData(levelId);
  const seedNum = Number(worldSeed) || 1999;
  const epoch = levelId === "level_0" ? Math.max(0, Number(shiftEpoch) || 0) : 0;
  const chunkHash = hashCoords(seedNum, levelId, cx, cz, epoch * 131);
  const rng = createMulberry32(chunkHash);
  let grid = levelId === "level_0" ? makeSolidGrid() : makeEmptyGrid();
  const wallStyles = makeWallStyleGrid();
  let lights = [];
  const interactables = [];
  let props = [];
  let propColliders = [];
  let prebuiltWalls = null;
  const zoneTag = `${String.fromCharCode(65 + Math.abs(cx * 3 + cz) % 6)}${Math.abs(cx + cz * 2) % 9 + 1}`;

  if (levelId === "level_0") {
    const borderOpenings = getLevel0BorderOpenings(seedNum, cx, cz);
    const protectedSolid = new Set();
    const requiredOpen = [];
    const allowPerimeterKeys = new Set();

    for (const op of borderOpenings) {
      grid[op.lz][op.lx] = CELL_TYPES.EMPTY;
      requiredOpen.push([op.lx, op.lz]);
      allowPerimeterKeys.add(cellKey(op.lx, op.lz));
    }

    const isOrigin = cx === 0 && cz === 0;
    const isInitialOrigin = isOrigin && epoch === 0;
    const isManilaChunk = !isOrigin && ((cx === 1 && cz === 0) || hashCoords(seedNum, "level_0", cx, cz, 0) % 13 === 0);

    if (isOrigin) {
      grid[0][0] = CELL_TYPES.EMPTY;
      grid[0][1] = CELL_TYPES.EMPTY;
      grid[1][1] = CELL_TYPES.EMPTY;
      allowPerimeterKeys.add(cellKey(0, 0));
      allowPerimeterKeys.add(cellKey(1, 0));
      requiredOpen.push([0, 0], [1, 0], [1, 1], [2, 5]);
      grid[5][2] = CELL_TYPES.STAIRS;

      if (isInitialOrigin) {
        protectedSolid.add(cellKey(3, 3));
        protectedSolid.add(cellKey(5, 1));
        protectedSolid.add(cellKey(6, 6));
        grid[3][2] = CELL_TYPES.EMPTY;
        requiredOpen.push([2, 3], [4, 1], [5, 6]);
        grid[1][5] = CELL_TYPES.GLITCH_WALL;
        grid[6][6] = CELL_TYPES.OUTLET_WALL;
      }

      const stairsRect = cellWorldRect(cx, cz, 2, 5);
      interactables.push({
        id: `l0_stairs_${cx}_${cz}`,
        type: "STAIRS",
        triggerType: "STAIRWELL",
        label: "上り階段 → Level 1 (Eキー)",
        x: stairsRect.centerX,
        z: stairsRect.centerZ,
        lx: 2,
        lz: 5,
        context: { targetLevelId: "level_1" },
      });

      if (isInitialOrigin) {
        const glitchRect = cellWorldRect(cx, cz, 5, 1);
        interactables.push({
          id: `l0_glitch_${cx}_${cz}`,
          type: "GLITCH_WALL",
          triggerType: "NOCLIP_WALL",
          label: "不安定な壁面 (Nキーでノークリップ)",
          x: glitchRect.centerX,
          z: glitchRect.centerZ,
          lx: 5,
          lz: 1,
          context: {},
        });
      }
    } else if (isManilaChunk) {
      for (let mz = 3; mz <= 5; mz += 1) {
        for (let mx = 3; mx <= 5; mx += 1) {
          if (mx === 4 && mz === 4) {
            grid[mz][mx] = CELL_TYPES.EMPTY;
          } else if (mx === 3 && mz === 4) {
            grid[mz][mx] = CELL_TYPES.DOOR;
          } else {
            grid[mz][mx] = CELL_TYPES.MANILA_WALL;
            protectedSolid.add(cellKey(mx, mz));
          }
        }
      }
      grid[4][2] = CELL_TYPES.EMPTY;
      requiredOpen.push([2, 4]);
      const mr = cellWorldRect(cx, cz, 4, 4);
      interactables.push({
        id: `l0_manila_${cx}_${cz}`,
        type: "MANILA_PORTAL",
        triggerType: "MANILA_ENTER",
        label: "The Manila Room へ入る (Eキー)",
        x: mr.centerX,
        z: mr.centerZ,
        lx: 4,
        lz: 4,
        context: {},
      });
    }

    // Phase A: Corner-Biased Growing-Tree Maze Carver on interior [1..6, 1..6]
    let seedX = isOrigin ? 1 : 1 + (chunkHash % 4);
    let seedZ = isOrigin ? 1 : 1 + ((chunkHash >>> 4) % 4);
    if (protectedSolid.has(cellKey(seedX, seedZ))) {
      seedX = 1;
      seedZ = 1;
    }
    grid[seedZ][seedX] = CELL_TYPES.EMPTY;

    const active = [{ x: seedX, z: seedZ, lastDx: 0, lastDz: 0 }];
    while (active.length > 0) {
      const pickNewest = rng() < 0.76;
      const aIdx = pickNewest ? active.length - 1 : Math.floor(rng() * active.length);
      const cur = active[aIdx];

      const cand = [];
      for (const [dx, dz] of DIRS_4) {
        const nx = cur.x + dx;
        const nz = cur.z + dz;
        if (!isInteriorCell(nx, nz)) continue;
        if (protectedSolid.has(cellKey(nx, nz))) continue;
        if (grid[nz][nx] !== CELL_TYPES.WALL) continue;

        let openInteriorNbr = 0;
        for (const [ox, oz] of DIRS_4) {
          const ax = nx + ox;
          const az = nz + oz;
          if (isInteriorCell(ax, az) && !SOLID_CELL_TYPES.has(grid[az][ax])) {
            openInteriorNbr += 1;
          }
        }
        if (openInteriorNbr > 1) continue;
        if (wouldCreate2x2Open(grid, nx, nz)) continue;

        // Weight 90-degree turns 3.2x higher than continuing straight
        const isTurn = cur.lastDx !== 0 || cur.lastDz !== 0 ? (dx !== cur.lastDx || dz !== cur.lastDz) : true;
        cand.push({ nx, nz, dx, dz, weight: isTurn ? 3.2 : 1.0 });
      }

      if (cand.length === 0) {
        active.splice(aIdx, 1);
        continue;
      }

      const totalW = cand.reduce((s, c) => s + c.weight, 0);
      let roll = rng() * totalW;
      let chosen = cand[cand.length - 1];
      for (const c of cand) {
        roll -= c.weight;
        if (roll <= 0) {
          chosen = c;
          break;
        }
      }
      grid[chosen.nz][chosen.nx] = CELL_TYPES.EMPTY;
      active.push({ x: chosen.nx, z: chosen.nz, lastDx: chosen.dx, lastDz: chosen.dz });
    }

    // Phase B: Guarantee full weighted shortest-path connectivity to borders & exits
    for (const [tx, tz] of requiredOpen) {
      connectTargetWeighted(grid, seedX, seedZ, tx, tz, protectedSolid, allowPerimeterKeys);
    }

    // Phase C: Intentional dead-end alcove stubs + single optional loop + room archetype detail
    const stubCandidates = [];
    for (let lz = 1; lz < CHUNK_CELLS - 1; lz += 1) {
      for (let lx = 1; lx < CHUNK_CELLS - 1; lx += 1) {
        if (grid[lz][lx] !== CELL_TYPES.WALL || protectedSolid.has(cellKey(lx, lz))) continue;
        const openNbrs = DIRS_4.reduce((s, [dx, dz]) => s + (isWalkableCell(grid, lx + dx, lz + dz) ? 1 : 0), 0);
        if (openNbrs === 1 && !wouldCreate2x2Open(grid, lx, lz)) {
          stubCandidates.push([lx, lz]);
        }
      }
    }
    let deadEndsAdded = 0;
    for (let i = 0; i < stubCandidates.length && deadEndsAdded < 3; i += 1) {
      const pick = stubCandidates[(i + Math.floor(rng() * stubCandidates.length)) % stubCandidates.length];
      const [lx, lz] = pick;
      if (grid[lz][lx] === CELL_TYPES.WALL) {
        const openNbrs = DIRS_4.reduce((s, [dx, dz]) => s + (isWalkableCell(grid, lx + dx, lz + dz) ? 1 : 0), 0);
        if (openNbrs === 1 && !wouldCreate2x2Open(grid, lx, lz)) {
          grid[lz][lx] = CELL_TYPES.EMPTY;
          deadEndsAdded += 1;
        }
      }
    }

    // Optional single micro-loop where two branches meet across 1 wall
    const { dist: bfsDist } = computeWalkableBfs(grid, seedX, seedZ);
    for (let lz = 2; lz < CHUNK_CELLS - 2; lz += 1) {
      let looped = false;
      for (let lx = 2; lx < CHUNK_CELLS - 2; lx += 1) {
        if (grid[lz][lx] !== CELL_TYPES.WALL || protectedSolid.has(cellKey(lx, lz))) continue;
        const nsOpen = isWalkableCell(grid, lx, lz - 1) && isWalkableCell(grid, lx, lz + 1) && SOLID_CELL_TYPES.has(grid[lz][lx - 1]) && SOLID_CELL_TYPES.has(grid[lz][lx + 1]);
        const ewOpen = isWalkableCell(grid, lx - 1, lz) && isWalkableCell(grid, lx + 1, lz) && SOLID_CELL_TYPES.has(grid[lz - 1][lx]) && SOLID_CELL_TYPES.has(grid[lz + 1][lx]);
        if (nsOpen && Math.abs(bfsDist[lz - 1][lx] - bfsDist[lz + 1][lx]) >= 6 && !wouldCreate2x2Open(grid, lx, lz)) {
          grid[lz][lx] = CELL_TYPES.EMPTY;
          looped = true;
          break;
        }
        if (ewOpen && Math.abs(bfsDist[lz][lx - 1] - bfsDist[lz][lx + 1]) >= 6 && !wouldCreate2x2Open(grid, lx, lz)) {
          grid[lz][lx] = CELL_TYPES.EMPTY;
          looped = true;
          break;
        }
      }
      if (looped) break;
    }

    // Small irregular retail pocket on archetype 1/2 chunks + optional structural pillar
    if (!isInitialOrigin && chunkHash % 3 !== 0) {
      for (let lz = 2; lz <= 4; lz += 1) {
        let pocketDone = false;
        for (let lx = 2; lx <= 4; lx += 1) {
          const cells = [[lx, lz], [lx + 1, lz], [lx, lz + 1], [lx + 1, lz + 1]];
          if (cells.some(([px, pz]) => protectedSolid.has(cellKey(px, pz)))) continue;
          const anyTouch = cells.some(([px, pz]) => isWalkableCell(grid, px, pz));
          if (!anyTouch) continue;
          for (const [px, pz] of cells) {
            if (grid[pz][px] === CELL_TYPES.WALL) grid[pz][px] = CELL_TYPES.EMPTY;
          }
          if (
            chunkHash % 3 === 1 &&
            !SOLID_CELL_TYPES.has(grid[lz][lx]) &&
            !(isOrigin && lx === 2 && lz === 5)
          ) {
            grid[lz][lx] = CELL_TYPES.PILLAR;
            if (!checkLevel0Connectivity(grid, seedX, seedZ, borderOpenings, interactables)) {
              grid[lz][lx] = CELL_TYPES.EMPTY;
            }
          }
          pocketDone = true;
          break;
        }
        if (pocketDone) break;
      }
    }

    // Eliminate any accidental 8-cell straight corridors along highway tracks {1, 6}
    const isAllConnectedAfterWall = () => {
      const { visited } = computeWalkableBfs(grid, seedX, seedZ);
      for (let z = 0; z < CHUNK_CELLS; z += 1) {
        for (let x = 0; x < CHUNK_CELLS; x += 1) {
          if (isWalkableCell(grid, x, z) && !visited[z][x]) return false;
        }
      }
      return checkLevel0Connectivity(grid, seedX, seedZ, borderOpenings, interactables);
    };
    const trySealTrack = (coords) => {
      for (const [lx, lz] of coords) {
        if (grid[lz][lx] !== CELL_TYPES.EMPTY || protectedSolid.has(cellKey(lx, lz))) continue;
        if (isOrigin && ((lx === 2 && lz === 3) || (lx === 1 && lz === 1))) continue;
        grid[lz][lx] = CELL_TYPES.WALL;
        if (isAllConnectedAfterWall()) return true;
        grid[lz][lx] = CELL_TYPES.EMPTY;
      }
      return false;
    };
    for (const trackIdx of [1, 6]) {
      let fullRow = true;
      for (let lx = 0; lx < CHUNK_CELLS; lx += 1) {
        if (SOLID_CELL_TYPES.has(grid[trackIdx][lx])) { fullRow = false; break; }
      }
      if (fullRow) {
        trySealTrack([3, 4, 2, 5, 1, 6].map((lx) => [lx, trackIdx]));
      }
      let fullCol = true;
      for (let lz = 0; lz < CHUNK_CELLS; lz += 1) {
        if (SOLID_CELL_TYPES.has(grid[lz][trackIdx])) { fullCol = false; break; }
      }
      if (fullCol) {
        trySealTrack([3, 4, 2, 5, 1, 6].map((lz) => [trackIdx, lz]));
      }
    }

    // Glitch Wall placement for epoch > 0 origin or periodic % 5 chunks
    if (!isInitialOrigin && !isManilaChunk && (isOrigin || chunkHash % 5 === 0)) {
      for (let lz = 1; lz < CHUNK_CELLS - 1; lz += 1) {
        let placed = false;
        for (let lx = 1; lx < CHUNK_CELLS - 1; lx += 1) {
          if (grid[lz][lx] !== CELL_TYPES.WALL || protectedSolid.has(cellKey(lx, lz))) continue;
          const adjWalk = DIRS_4.some(([dx, dz]) => isWalkableCell(grid, lx + dx, lz + dz));
          if (adjWalk) {
            grid[lz][lx] = CELL_TYPES.GLITCH_WALL;
            const gRect = cellWorldRect(cx, cz, lx, lz);
            interactables.push({
              id: `l0_glitch_${cx}_${cz}`,
              type: "GLITCH_WALL",
              triggerType: "NOCLIP_WALL",
              label: "歪んだ壁面境界 (Nキーでノークリップ)",
              x: gRect.centerX,
              z: gRect.centerZ,
              lx,
              lz,
              context: {},
            });
            placed = true;
            break;
          }
        }
        if (placed) break;
      }
    }

    // Guarantee required initial (0,0) features: arched_divider + l0_pillar
    if (isInitialOrigin) {
      let hasArchSpot = false;
      for (let lz = 1; lz < CHUNK_CELLS - 1 && !hasArchSpot; lz += 1) {
        for (let lx = 1; lx < CHUNK_CELLS - 1; lx += 1) {
          if (
            grid[lz][lx] === CELL_TYPES.WALL &&
            !(lx === 3 && lz === 3) &&
            SOLID_CELL_TYPES.has(grid[lz][lx - 1]) &&
            SOLID_CELL_TYPES.has(grid[lz][lx + 1]) &&
            !SOLID_CELL_TYPES.has(grid[lz - 1][lx]) &&
            !SOLID_CELL_TYPES.has(grid[lz + 1][lx])
          ) {
            hasArchSpot = true;
            break;
          }
        }
      }
      if (!hasArchSpot) {
        for (let lz = 2; lz <= 5 && !hasArchSpot; lz += 1) {
          for (let lx = 2; lx <= 5; lx += 1) {
            if ((lx === 3 && lz === 3) || protectedSolid.has(cellKey(lx, lz))) continue;
            if (
              grid[lz][lx] === CELL_TYPES.WALL &&
              SOLID_CELL_TYPES.has(grid[lz][lx - 1]) &&
              SOLID_CELL_TYPES.has(grid[lz][lx + 1]) &&
              !protectedSolid.has(cellKey(lx, lz - 1)) &&
              !protectedSolid.has(cellKey(lx, lz + 1))
            ) {
              const prevN = grid[lz - 1][lx];
              const prevS = grid[lz + 1][lx];
              if (grid[lz - 1][lx] === CELL_TYPES.WALL) grid[lz - 1][lx] = CELL_TYPES.EMPTY;
              if (grid[lz + 1][lx] === CELL_TYPES.WALL) grid[lz + 1][lx] = CELL_TYPES.EMPTY;
              if (checkLevel0Connectivity(grid, 0, 0, borderOpenings, interactables)) {
                hasArchSpot = true;
                break;
              }
              grid[lz - 1][lx] = prevN;
              grid[lz + 1][lx] = prevS;
            }
          }
        }
      }

      // Ensure at least 1 l0_pillar on an interior cell without breaking connectivity
      let hasPillar = false;
      for (let lz = 1; lz < CHUNK_CELLS - 1 && !hasPillar; lz += 1) {
        for (let lx = 1; lx < CHUNK_CELLS - 1; lx += 1) {
          if (grid[lz][lx] === CELL_TYPES.PILLAR) {
            hasPillar = true;
            break;
          }
        }
      }
      if (!hasPillar) {
        for (let lz = 1; lz < CHUNK_CELLS - 1 && !hasPillar; lz += 1) {
          for (let lx = 1; lx < CHUNK_CELLS - 1; lx += 1) {
            if (
              (lx === 3 && lz === 3) ||
              (lx === 2 && lz === 3) ||
              (lx === 1 && lz === 1) ||
              protectedSolid.has(cellKey(lx, lz)) ||
              (lx === 2 && lz === 5)
            ) {
              continue;
            }
            if (grid[lz][lx] === CELL_TYPES.WALL) {
              grid[lz][lx] = CELL_TYPES.PILLAR;
              if (checkLevel0Connectivity(grid, 0, 0, borderOpenings, interactables)) {
                hasPillar = true;
                break;
              }
              grid[lz][lx] = CELL_TYPES.WALL;
            }
          }
        }
      }
    }

    assignLevel0WallStyles(grid, wallStyles, cx, cz, chunkHash, epoch, rng);
    const derived = buildLevel0DerivedData({
      grid,
      wallStyles,
      cx,
      cz,
      chunkHash,
      levelData,
      interactables,
      shiftEpoch: epoch,
    });
    prebuiltWalls = derived.walls;
    props = derived.props;
    propColliders = derived.propColliders;
    lights = derived.lights;
  } else if (levelId === "manila_room") {
    // Hermetically sealed 9m x 9m (x in [0,9], z in [0,9]) anomaly room inside Level 0.
    // East/South walls at lx=3, lz=3 leave lx=7 & lz=7 open for cross-chunk seam compatibility
    // while West/North/Corner enclosing walls in (-1,0), (0,-1), (-1,-1) seal x=0 & z=0.
    if (cx === 0 && cz === 0) {
      for (let lz = 0; lz <= 2; lz += 1) {
        for (let lx = 0; lx <= 2; lx += 1) {
          grid[lz][lx] = CELL_TYPES.EMPTY;
        }
      }
      for (let i = 0; i <= 3; i += 1) {
        grid[i][3] = CELL_TYPES.MANILA_WALL;
        wallStyles[i][3] = "manila_wall";
        grid[3][i] = CELL_TYPES.MANILA_WALL;
        wallStyles[3][i] = "manila_wall";
      }

      const restRect = cellWorldRect(cx, cz, 1, 1);
      interactables.push({
        id: "manila_rest_anchor",
        type: "MANILA_REST_ZONE",
        triggerType: "MANILA_REST",
        label: "マニラ室で静かに留まる／休息する → Level 1 / 2 (Eキー、または30秒滞在)",
        x: restRect.centerX,
        z: restRect.centerZ,
        lx: 1,
        lz: 1,
        context: {},
      });
      interactables.push({
        id: "manila_back_l0",
        type: "EXIT_DOOR",
        triggerType: "EXIT_DOOR",
        label: "黄色い廊下へ戻る → Level 0 (Eキー)",
        x: 4.5,
        z: 8.85,
        lx: 1,
        lz: 2,
        context: { targetLevelId: "level_0" },
      });

      // Outlet flush on interior East wall (x=9.0, facing -X)
      props.push({ kind: "WALL_OUTLET", x: 8.98, z: 4.5, rotY: -Math.PI / 2 });

      // Strictly ONE singular dull orange overhead fixture inside the Manila Room
      lights.push({
        x: 4.5,
        y: levelData.environment.ceilingHeight - 0.08,
        z: 4.5,
        rotY: 0,
        flickerPhase: 0.42,
      });
    } else if (cx === -1 && cz === 0) {
      for (let lz = 0; lz <= 3; lz += 1) {
        grid[lz][7] = CELL_TYPES.MANILA_WALL;
        wallStyles[lz][7] = "manila_wall";
      }
    } else if (cx === 0 && cz === -1) {
      for (let lx = 0; lx <= 3; lx += 1) {
        grid[7][lx] = CELL_TYPES.MANILA_WALL;
        wallStyles[7][lx] = "manila_wall";
      }
    } else if (cx === -1 && cz === -1) {
      grid[7][7] = CELL_TYPES.MANILA_WALL;
      wallStyles[7][7] = "manila_wall";
    }
  } else if (levelId === "level_1") {
    // Wide concrete parking deck with structural pillars, curbs, arrows, ramps & puddles
    for (let lz = 0; lz < CHUNK_CELLS; lz += 1) {
      for (let lx = 0; lx < CHUNK_CELLS; lx += 1) {
        if ((lx === 1 || lx === 5) && (lz === 1 || lz === 5)) {
          grid[lz][lx] = CELL_TYPES.PILLAR;
          wallStyles[lz][lx] = "parking_pillar";
        } else if (Math.abs(cx * 3 + cz) % 4 === 2 && lz === 4 && lx >= 2 && lx <= 5) {
          grid[lz][lx] = CELL_TYPES.WALL;
          wallStyles[lz][lx] = "solid";
        } else if (rng() < 0.045) {
          grid[lz][lx] = CELL_TYPES.CAR;
        } else if (rng() < 0.13) {
          grid[lz][lx] = CELL_TYPES.PUDDLE;
        }
      }
    }
    carveCorridor(grid, 2, 0, 2, 7);
    carveCorridor(grid, 0, 2, 7, 2);
    applyCrossChunkSeams(grid, seedNum, levelId, cx, cz);

    if (cx === 0 && cz === 0) {
      for (let lz = 0; lz <= 2; lz += 1) {
        for (let lx = 0; lx <= 2; lx += 1) {
          grid[lz][lx] = CELL_TYPES.EMPTY;
        }
      }
      grid[5][1] = CELL_TYPES.PILLAR;
      wallStyles[5][1] = "parking_pillar";
      grid[5][5] = CELL_TYPES.PILLAR;
      wallStyles[5][5] = "parking_pillar";
      grid[5][4] = CELL_TYPES.WALL;
      wallStyles[5][4] = "solid";
      grid[1][3] = CELL_TYPES.CAR;
      grid[5][2] = CELL_TYPES.STAIRS;
      grid[2][5] = CELL_TYPES.STAIRS;
      grid[4][4] = CELL_TYPES.KEY_PEDESTAL;
      grid[4][6] = CELL_TYPES.OUTLET_WALL;
      wallStyles[4][6] = "solid";
      grid[2][3] = CELL_TYPES.PUDDLE;
      grid[3][3] = CELL_TYPES.PUDDLE;
      grid[4][2] = CELL_TYPES.PUDDLE;

      const s0 = cellWorldRect(cx, cz, 2, 5);
      interactables.push({
        id: "l1_stairs_l0",
        type: "STAIRS",
        triggerType: "STAIRWELL",
        label: "下り階段 → Level 0 (Eキー)",
        x: s0.centerX,
        z: s0.centerZ,
        lx: 2,
        lz: 5,
        context: { targetLevelId: "level_0" },
      });

      const s2 = cellWorldRect(cx, cz, 5, 2);
      interactables.push({
        id: "l1_stairs_l2",
        type: "STAIRS",
        triggerType: "STAIRWELL",
        label: "保守階段 → Level 2 (Eキー)",
        x: s2.centerX,
        z: s2.centerZ,
        lx: 5,
        lz: 2,
        context: { targetLevelId: "level_2" },
      });

      const kp = cellWorldRect(cx, cz, 4, 4);
      interactables.push({
        id: "l1_key_pedestal",
        type: "KEY_PICKUP",
        triggerType: "PICKUP_KEY",
        label: "Object 2: Level Key を拾う (Eキー)",
        x: kp.centerX,
        z: kp.centerZ,
        lx: 4,
        lz: 4,
        context: {},
      });

      const outRect = cellWorldRect(cx, cz, 6, 4);
      interactables.push({
        id: "l1_outlet_noclip",
        type: "OUTLET_WALL",
        triggerType: "OUTLET_NOCLIP",
        label: "コンセント付き壁面 (Nキー: Wiki上Level 188候補／試作版は隣接階層へ)",
        x: outRect.centerX,
        z: outRect.centerZ,
        lx: 6,
        lz: 4,
        context: {},
      });

      // Fake Exit sign above blank wall & sloped parking ramp (File:Level 1.jpg & lore)
      props.push({ kind: "FAKE_EXIT_SIGN", x: outRect.centerX, z: outRect.minZ - 0.04 });
      props.push({ kind: "PARKING_RAMP", x: 4.5, z: 21.0 });

      // Decorative Warehouse wood door (North face) & jet-black Maintenance Hall door (South face)
      const subWall = cellWorldRect(cx, cz, 4, 5);
      props.push({ kind: "WAREHOUSE_DOOR", x: subWall.centerX, z: subWall.minZ - 0.05, rotY: Math.PI });
      props.push({ kind: "MAINT_DOOR", x: subWall.centerX, z: subWall.maxZ + 0.05, rotY: 0 });

      // Protruding rusty rebar near structural concrete bases
      props.push({ kind: "REBAR_CLUSTER", x: 6.1, z: 16.5, rotY: 0.4 });
      props.push({ kind: "REBAR_CLUSTER", x: 15.1, z: 16.4, rotY: 1.9 });
    } else if (cx === 1 && cz === 0) {
      for (let lz = 2; lz <= 4; lz += 1) {
        for (let lx = 1; lx <= 6; lx += 1) {
          grid[lz][lx] = CELL_TYPES.EMPTY;
        }
      }
      grid[3][3] = CELL_TYPES.WALL;
      wallStyles[3][3] = "solid";
      grid[3][2] = CELL_TYPES.DOOR;
      grid[3][5] = CELL_TYPES.DOOR;

      const arrLeft = cellWorldRect(cx, cz, 1, 2);
      const arrRight = cellWorldRect(cx, cz, 2, 4);
      props.push({ kind: "FLOOR_ARROW", x: arrLeft.centerX, z: arrLeft.centerZ, rotY: Math.PI * 0.5 });
      props.push({ kind: "FLOOR_ARROW", x: arrRight.centerX, z: arrRight.centerZ, rotY: 0 });

      const hintRect = cellWorldRect(cx, cz, 1, 4);
      interactables.push({
        id: "l1_hub_stairs_note",
        type: "STAIRS",
        triggerType: "LORE_HINT",
        label: "Hub手順: 階段2階分往復→左→右の分岐→Door[B]→Door[A] (Eキーで確認)",
        x: hintRect.centerX,
        z: hintRect.centerZ,
        lx: 1,
        lz: 4,
        context: {
          msg: "Wiki準拠ルート: 階段を2階分上ってすぐ下り、分岐を左→右へ進んだ先の Door [B] を通ってから Door [A] を起動します。",
        },
      });

      const bRect = cellWorldRect(cx, cz, 2, 3);
      const aRect = cellWorldRect(cx, cz, 5, 3);
      interactables.push({
        id: "l1_hub_door_b",
        type: "HUB_DOOR_B",
        triggerType: "HUB_SEQ_STEP_B",
        label: "Door [B] を通過する (Hub手順 1/2 - Eキー)",
        x: bRect.centerX,
        z: bRect.centerZ,
        lx: 2,
        lz: 3,
        context: { doorLabel: "B" },
      });
      interactables.push({
        id: "l1_hub_door_a",
        type: "HUB_DOOR_A",
        triggerType: "HUB_SEQUENCE",
        label: "Door [A] へ入る → The Hub (Hub手順 2/2 - Eキー)",
        x: aRect.centerX,
        z: aRect.centerZ,
        lx: 5,
        lz: 3,
        context: { doorLabel: "A" },
      });
    } else if (chunkHash % 9 === 0) {
      grid[4][4] = CELL_TYPES.KEY_PEDESTAL;
      const kp = cellWorldRect(cx, cz, 4, 4);
      interactables.push({
        id: `l1_key_${cx}_${cz}`,
        type: "KEY_PICKUP",
        triggerType: "PICKUP_KEY",
        label: "Object 2: Level Key を拾う (Eキー)",
        x: kp.centerX,
        z: kp.centerZ,
        lx: 4,
        lz: 4,
        context: {},
      });
    }

    // Emit concrete-floor Hydrolitis & False Puddle meshes, scattered rebar, sub-area doors, and pedestal colliders
    for (let lz = 0; lz < CHUNK_CELLS; lz += 1) {
      for (let lx = 0; lx < CHUNK_CELLS; lx += 1) {
        const cell = grid[lz][lx];
        if (cell === CELL_TYPES.KEY_PEDESTAL) {
          const kp = cellWorldRect(cx, cz, lx, lz);
          propColliders.push({
            kind: "KEY_PEDESTAL",
            minX: kp.centerX - 0.38,
            maxX: kp.centerX + 0.38,
            minZ: kp.centerZ - 0.38,
            maxZ: kp.centerZ + 0.38,
            height: 0.92,
          });
        } else if (cell === CELL_TYPES.PUDDLE) {
          const r = cellWorldRect(cx, cz, lx, lz);
          const isOriginNormal = cx === 0 && cz === 0 && ((lx === 3 && lz === 2) || (lx === 2 && lz === 4));
          const isOriginFalse = cx === 0 && cz === 0 && lx === 3 && lz === 3;
          const isFalsePuddle = isOriginFalse ? true : isOriginNormal ? false : rng() < 0.24;
          props.push({
            kind: "PUDDLE",
            x: r.centerX,
            z: r.centerZ,
            radius: 0.95 + rng() * 0.35,
            yOffset: 0.012 + ((lx * 3 + lz * 5) % 5) * 0.002,
            isFalsePuddle,
          });
        } else if (cell === CELL_TYPES.WALL && wallStyles[lz][lx] === "solid" && !(cx === 0 && cz === 0 && lx === 4 && lz === 5)) {
          if (lz > 0 && !SOLID_CELL_TYPES.has(grid[lz - 1][lx]) && rng() < 0.45) {
            const r = cellWorldRect(cx, cz, lx, lz);
            props.push({
              kind: rng() < 0.5 ? "MAINT_DOOR" : "WAREHOUSE_DOOR",
              x: r.centerX,
              z: r.minZ - 0.05,
              rotY: Math.PI,
            });
          }
        } else if (!SOLID_CELL_TYPES.has(cell) && cell !== CELL_TYPES.PUDDLE && cell !== CELL_TYPES.STAIRS && rng() < 0.05) {
          const r = cellWorldRect(cx, cz, lx, lz);
          props.push({ kind: "REBAR_CLUSTER", x: r.centerX + 0.7, z: r.centerZ - 0.7, rotY: rng() * Math.PI * 2 });
        }
      }
    }

    // Parking bay yellow wheel stops, floor directional arrows, orange barriers, ceiling beams & pipes
    for (const lx of [2, 6]) {
      const rStop = cellWorldRect(cx, cz, lx, 3);
      props.push({ kind: "WHEEL_STOP", x: rStop.centerX, z: rStop.centerZ, rotY: 0 });
      const rArr = cellWorldRect(cx, cz, lx, 2);
      props.push({ kind: "FLOOR_ARROW", x: rArr.centerX, z: rArr.centerZ, rotY: 0 });
    }
    if ((cx + cz) % 2 === 0) {
      const b = cellWorldRect(cx, cz, 4, 1);
      props.push({ kind: "TRAFFIC_BARRIER", x: b.centerX, z: b.centerZ, rotY: 0 });
      propColliders.push({
        kind: "TRAFFIC_BARRIER",
        minX: b.centerX - 0.74,
        maxX: b.centerX + 0.74,
        minZ: b.centerZ - 0.28,
        maxZ: b.centerZ + 0.28,
        height: 0.84,
      });
    }
    const baseChunkX = cx * CHUNK_WORLD_SIZE;
    const baseChunkZ = cz * CHUNK_WORLD_SIZE;
    props.push({ kind: "OVERHEAD_BEAM", x: baseChunkX + 12.0, z: baseChunkZ + 4.5 });
    props.push({ kind: "OVERHEAD_BEAM", x: baseChunkX + 12.0, z: baseChunkZ + 16.5 });
    props.push({ kind: "CEILING_PIPE", x: baseChunkX + 12.0, z: baseChunkZ + 7.5, color: 0xb84a27 });
    props.push({ kind: "CEILING_PIPE", x: baseChunkX + 12.0, z: baseChunkZ + 13.5, color: 0x9aa2ab });

    for (const [lx, lz] of [[2, 2], [6, 2], [2, 6], [6, 6]]) {
      if (!SOLID_CELL_TYPES.has(grid[lz][lx])) {
        const r = cellWorldRect(cx, cz, lx, lz);
        lights.push({
          x: r.centerX,
          y: levelData.environment.ceilingHeight - 0.14,
          z: r.centerZ,
          rotY: 0,
          flickerPhase: ((lx * 5 + lz * 11) % 13) * 0.4,
        });
      }
    }
  } else if (levelId === "the_hub") {
    // Subterranean semi-circular arched concrete highway tunnel nexus (Tunnel.webp & Now THIS is the hub.png)
    const isMainEWTunnel = cz % 2 === 0;
    const isCrossNSTunnel = cx % 2 === 0;

    for (let lz = 0; lz < CHUNK_CELLS; lz += 1) {
      for (let lx = 0; lx < CHUNK_CELLS; lx += 1) {
        const inEW = isMainEWTunnel && lz <= 3;
        const inNS = isCrossNSTunnel && lx >= 2 && lx <= 5;
        if (!inEW && !inNS) {
          grid[lz][lx] = CELL_TYPES.WALL;
          wallStyles[lz][lx] = "hub_concrete";
        }
      }
    }

    if (isMainEWTunnel) {
      carveCorridor(grid, 0, 1, 7, 1);
      carveCorridor(grid, 0, 2, 7, 2);
    }
    if (isCrossNSTunnel) {
      carveCorridor(grid, 3, 0, 3, 7);
      carveCorridor(grid, 4, 0, 4, 7);
    }
    applyCrossChunkSeams(grid, seedNum, levelId, cx, cz);

    const chunkOriginX = cx * CHUNK_WORLD_SIZE;
    const chunkOriginZ = cz * CHUNK_WORLD_SIZE;

    if (isMainEWTunnel) {
      props.push({
        kind: "TUNNEL_ARCH",
        centerX: chunkOriginX + 12.0,
        centerZ: chunkOriginZ + 6.0,
        length: CHUNK_WORLD_SIZE,
        radius: 6.2,
        axis: "x",
      });
      props.push({
        kind: "HIGHWAY_ROAD",
        centerX: chunkOriginX + 12.0,
        centerZ: chunkOriginZ + 6.0,
        length: CHUNK_WORLD_SIZE,
        width: 7.4,
        axis: "x",
      });
      props.push({ kind: "SIDEWALK_CURB", x: chunkOriginX + 12.0, z: chunkOriginZ + 1.15, length: CHUNK_WORLD_SIZE, width: 2.3, axis: "x" });
      props.push({ kind: "SIDEWALK_CURB", x: chunkOriginX + 12.0, z: chunkOriginZ + 10.85, length: CHUNK_WORLD_SIZE, width: 2.3, axis: "x" });
      props.push({ kind: "OVERHEAD_PIPE", x: chunkOriginX + 12.0, z: chunkOriginZ + 4.8, y: 5.55, length: CHUNK_WORLD_SIZE, axis: "x" });
      props.push({ kind: "OVERHEAD_PIPE", x: chunkOriginX + 12.0, z: chunkOriginZ + 7.2, y: 5.55, length: CHUNK_WORLD_SIZE, axis: "x" });
      props.push({ kind: "LIGHT_TRACK", x: chunkOriginX + 12.0, z: chunkOriginZ + 4.1, y: 5.48, length: CHUNK_WORLD_SIZE, axis: "x" });
      props.push({ kind: "LIGHT_TRACK", x: chunkOriginX + 12.0, z: chunkOriginZ + 7.9, y: 5.48, length: CHUNK_WORLD_SIZE, axis: "x" });
      props.push({ kind: "TRAFFIC_GANTRY", x: chunkOriginX + 12.0, z: chunkOriginZ + 6.0, axis: "x" });
      props.push({ kind: "VENT_FAN", x: chunkOriginX + 18.0, z: chunkOriginZ + 4.7, y: 5.2, axis: "x" });
      props.push({ kind: "VENT_FAN", x: chunkOriginX + 18.0, z: chunkOriginZ + 7.3, y: 5.2, axis: "x" });
      props.push({ kind: "BLUE_TUNNEL_SIGN", x: chunkOriginX + 9.0, z: chunkOriginZ + 0.35, axis: "x" });

      for (const alx of [1, 5]) {
        const ax = chunkOriginX + (alx + 0.5) * CELL_SIZE;
        props.push({ kind: "WALL_ALCOVE", x: ax, z: chunkOriginZ + 0.14, rotY: 0 });
        props.push({ kind: "WALL_ALCOVE", x: ax, z: chunkOriginZ + 11.86, rotY: Math.PI });
      }
      if (cx === 0 && cz === 0) {
        props.push({ kind: "WALL_TV", x: chunkOriginX + 15.0, z: chunkOriginZ + 0.55, rotY: 0 });
        props.push({ kind: "WALL_TV", x: chunkOriginX + 21.0, z: chunkOriginZ + 11.45, rotY: Math.PI });
      } else if (chunkHash % 2 === 0) {
        props.push({ kind: "WALL_TV", x: chunkOriginX + 12.0, z: chunkOriginZ + 0.55, rotY: 0 });
      }

      // Seal EW arch walls outside NS cross-tunnel openings so players cannot walk through curved concrete
      const ewWallRanges = isCrossNSTunnel
        ? [[chunkOriginX, chunkOriginX + 6.0], [chunkOriginX + 18.0, chunkOriginX + CHUNK_WORLD_SIZE]]
        : [[chunkOriginX, chunkOriginX + CHUNK_WORLD_SIZE]];
      for (const [minX, maxX] of ewWallRanges) {
        propColliders.push({
          kind: "HUB_TUNNEL_WALL",
          minX,
          maxX,
          minZ: chunkOriginZ - 0.35,
          maxZ: chunkOriginZ + 0.12,
          height: levelData.environment.ceilingHeight,
        });
        propColliders.push({
          kind: "HUB_TUNNEL_WALL",
          minX,
          maxX,
          minZ: chunkOriginZ + 11.88,
          maxZ: chunkOriginZ + 12.35,
          height: levelData.environment.ceilingHeight,
        });
      }

      // Twin orange-yellow overhead arch lighting rows
      for (const lx of [1, 4, 6]) {
        const px = chunkOriginX + (lx + 0.5) * CELL_SIZE;
        lights.push({ x: px, y: 5.4, z: chunkOriginZ + 4.1, rotY: 0, flickerPhase: lx * 0.3 });
        lights.push({ x: px, y: 5.4, z: chunkOriginZ + 7.9, rotY: 0, flickerPhase: lx * 0.5 });
      }
    } else if (isCrossNSTunnel) {
      props.push({
        kind: "TUNNEL_ARCH",
        centerX: chunkOriginX + 12.0,
        centerZ: chunkOriginZ + 12.0,
        length: CHUNK_WORLD_SIZE,
        radius: 6.2,
        axis: "z",
      });
      props.push({
        kind: "HIGHWAY_ROAD",
        centerX: chunkOriginX + 12.0,
        centerZ: chunkOriginZ + 12.0,
        length: CHUNK_WORLD_SIZE,
        width: 7.4,
        axis: "z",
      });
      props.push({ kind: "OVERHEAD_PIPE", x: chunkOriginX + 10.8, z: chunkOriginZ + 12.0, y: 5.55, length: CHUNK_WORLD_SIZE, axis: "z" });
      props.push({ kind: "OVERHEAD_PIPE", x: chunkOriginX + 13.2, z: chunkOriginZ + 12.0, y: 5.55, length: CHUNK_WORLD_SIZE, axis: "z" });
      props.push({ kind: "LIGHT_TRACK", x: chunkOriginX + 10.1, z: chunkOriginZ + 12.0, y: 5.48, length: CHUNK_WORLD_SIZE, axis: "z" });
      props.push({ kind: "LIGHT_TRACK", x: chunkOriginX + 13.9, z: chunkOriginZ + 12.0, y: 5.48, length: CHUNK_WORLD_SIZE, axis: "z" });
      props.push({ kind: "TRAFFIC_GANTRY", x: chunkOriginX + 12.0, z: chunkOriginZ + 12.0, axis: "z" });
      if (chunkHash % 3 === 0) {
        props.push({ kind: "WALL_TV", x: chunkOriginX + 6.55, z: chunkOriginZ + 15.0, rotY: Math.PI / 2 });
      }
      propColliders.push({
        kind: "HUB_TUNNEL_WALL",
        minX: chunkOriginX + 5.65,
        maxX: chunkOriginX + 6.12,
        minZ: chunkOriginZ,
        maxZ: chunkOriginZ + CHUNK_WORLD_SIZE,
        height: levelData.environment.ceilingHeight,
      });
      propColliders.push({
        kind: "HUB_TUNNEL_WALL",
        minX: chunkOriginX + 17.88,
        maxX: chunkOriginX + 18.35,
        minZ: chunkOriginZ,
        maxZ: chunkOriginZ + CHUNK_WORLD_SIZE,
        height: levelData.environment.ceilingHeight,
      });
      lights.push({ x: chunkOriginX + 10.1, y: 5.4, z: chunkOriginZ + 12.0, rotY: 0, flickerPhase: 0.4 });
      lights.push({ x: chunkOriginX + 13.9, y: 5.4, z: chunkOriginZ + 12.0, rotY: 0, flickerPhase: 0.7 });
    } else {
      lights.push({ x: chunkOriginX + 12.0, y: 5.0, z: chunkOriginZ + 12.0, rotY: 0, flickerPhase: 0.2 });
    }

    if (cx === 0 && cz === 0) {
      for (let lz = 0; lz <= 3; lz += 1) {
        for (let lx = 0; lx <= 2; lx += 1) {
          grid[lz][lx] = CELL_TYPES.EMPTY;
        }
      }
      grid[0][2] = CELL_TYPES.KEY_PEDESTAL;
      grid[0][5] = CELL_TYPES.DOOR;
      grid[3][6] = CELL_TYPES.DOOR;
      grid[3][3] = CELL_TYPES.DOOR;

      const kRect = cellWorldRect(cx, cz, 2, 0);
      interactables.push({
        id: "hub_key_pedestal",
        type: "KEY_PICKUP",
        triggerType: "PICKUP_KEY",
        label: "紛失された Object 2: Level Key を拾う (Eキー)",
        x: kRect.centerX,
        z: chunkOriginZ + 0.72,
        lx: 2,
        lz: 0,
        context: {},
      });
      propColliders.push({
        kind: "KEY_PEDESTAL",
        minX: kRect.centerX - 0.36,
        maxX: kRect.centerX + 0.36,
        minZ: chunkOriginZ + 0.72 - 0.36,
        maxZ: chunkOriginZ + 0.72 + 0.36,
        height: 0.92,
      });

      const d0 = cellWorldRect(cx, cz, 5, 0);
      interactables.push({
        id: "hub_door_level_0",
        type: "HUB_LEVEL_DOOR",
        triggerType: "HUB_DOOR",
        label: "金属扉 [Level 0: 淡黄色扉] (Level Key必要 - Eキー)",
        x: d0.centerX,
        z: d0.minZ + 0.55,
        lx: 5,
        lz: 0,
        context: { targetLevelId: "level_0", doorTint: 0xe6c85c },
      });

      const d1 = cellWorldRect(cx, cz, 6, 3);
      interactables.push({
        id: "hub_door_level_1",
        type: "HUB_LEVEL_DOOR",
        triggerType: "HUB_DOOR",
        label: "金属扉 [Level 1: 灰色鉄扉] (Level Key必要 - Eキー)",
        x: d1.centerX,
        z: d1.maxZ - 0.55,
        lx: 6,
        lz: 3,
        context: { targetLevelId: "level_1", doorTint: 0x8d959e },
      });

      const d2 = cellWorldRect(cx, cz, 3, 3);
      interactables.push({
        id: "hub_door_level_2",
        type: "HUB_LEVEL_DOOR",
        triggerType: "HUB_DOOR",
        label: "金属扉 [Level 2: 暗鉄鋼扉] (Level Key必要 - Eキー)",
        x: d2.centerX,
        z: d2.maxZ - 0.55,
        lx: 3,
        lz: 3,
        context: { targetLevelId: "level_2", doorTint: 0x7c746c },
      });
    } else if (cx === 0 && cz === 1) {
      grid[2][2] = CELL_TYPES.DOOR;
      grid[4][5] = CELL_TYPES.DOOR;
      const d37 = cellWorldRect(cx, cz, 2, 2);
      interactables.push({
        id: "hub_lore_door_37",
        type: "LORE_DOOR",
        triggerType: "LORE_HINT",
        label: "特注扉 [Level 37: White Tile] (試作版未実装 - Eキーで確認)",
        x: d37.minX + 0.55,
        z: d37.centerZ,
        lx: 2,
        lz: 2,
        context: {
          loreLevel: "level_37",
          doorStyle: "l37_tile",
          msg: "The Hub の Level 37 扉：白タイル彫刻デザイン（Wiki上 Sublimity への連絡路）。",
        },
      });
      const d154 = cellWorldRect(cx, cz, 5, 4);
      interactables.push({
        id: "hub_lore_door_154",
        type: "LORE_DOOR",
        triggerType: "LORE_HINT",
        label: "特注扉 [Level 154: Neon Express] (試作版未実装 - Eキーで確認)",
        x: d154.maxX - 0.55,
        z: d154.centerZ,
        lx: 5,
        lz: 4,
        context: {
          loreLevel: "level_154",
          doorStyle: "l154_neon",
          msg: "The Hub の Level 154 扉：ネオン列車駅の意匠（Wiki上 Neon Express への連絡路）。",
        },
      });
    }
  } else if (levelId === "level_2") {
    // Claustrophobic low-ceiling industrial maintenance shafts: concrete walls + older wooden areas + rusted pipe tiers
    for (let lz = 0; lz < CHUNK_CELLS; lz += 1) {
      for (let lx = 0; lx < CHUNK_CELLS; lx += 1) {
        const r = rng();
        if (r < 0.54) {
          grid[lz][lx] = CELL_TYPES.WALL;
          wallStyles[lz][lx] = !(cx === 0 && cz === 0) && rng() < 0.16 ? "l2_wood" : "solid";
        }
      }
    }
    carveCorridor(grid, 1, 0, 1, 7);
    carveCorridor(grid, 5, 0, 5, 7);
    carveCorridor(grid, 0, 1, 7, 1);
    carveCorridor(grid, 0, 5, 7, 5);
    applyCrossChunkSeams(grid, seedNum, levelId, cx, cz);

    if (cx === 0 && cz === 0) {
      for (let lz = 0; lz <= 2; lz += 1) {
        for (let lx = 0; lx <= 2; lx += 1) {
          grid[lz][lx] = CELL_TYPES.EMPTY;
        }
      }
      grid[3][3] = CELL_TYPES.WALL;
      wallStyles[3][3] = "l2_wood";
      grid[2][5] = CELL_TYPES.DOOR;
      grid[5][2] = CELL_TYPES.DOOR;
      grid[5][6] = CELL_TYPES.DOOR;
      grid[1][4] = CELL_TYPES.GLITCH_WALL;
      wallStyles[1][4] = "solid";

      const f1 = cellWorldRect(cx, cz, 5, 2);
      interactables.push({
        id: "l2_fire_exit_l1",
        type: "EXIT_DOOR",
        triggerType: "EXIT_DOOR",
        label: "非常口 (Fire Exit) → Level 1 (Eキー)",
        x: f1.centerX,
        z: f1.centerZ,
        lx: 5,
        lz: 2,
        context: { targetLevelId: "level_1" },
      });

      const crawlRect = cellWorldRect(cx, cz, 2, 5);
      interactables.push({
        id: "l2_crawlspace_l1",
        type: "CRAWLSPACE_EXIT",
        triggerType: "EXIT_DOOR",
        label: "狭い這い穴（帯電配線に注意） → Level 1 (Eキー)",
        x: crawlRect.centerX,
        z: crawlRect.centerZ,
        lx: 2,
        lz: 5,
        context: { targetLevelId: "level_1" },
      });

      const phiRect = cellWorldRect(cx, cz, 6, 5);
      interactables.push({
        id: "l2_phi_door",
        type: "LORE_DOOR",
        triggerType: "LORE_HINT",
        label: "金色の「Φ」扉 → Level Phi (試作版未実装 - Eキーで確認)",
        x: phiRect.centerX,
        z: phiRect.centerZ,
        lx: 6,
        lz: 5,
        context: {
          doorStyle: "gold_phi",
          msg: "金色の「Φ」が刻まれた扉。Fandom Wiki 上は Level Phi へ通じる出口です。",
        },
      });

      const gl = cellWorldRect(cx, cz, 4, 1);
      interactables.push({
        id: "l2_glitch_wall",
        type: "GLITCH_WALL",
        triggerType: "NOCLIP_WALL",
        label: "不安定配管壁 (Nキーでノークリップ → Level 1)",
        x: gl.centerX,
        z: gl.centerZ,
        lx: 4,
        lz: 1,
        context: {},
      });
    }

    // 4 continuous overhead pipes along the 4 carved corridors (reduces ~28 small segments to 4)
    const l2OriginX = cx * CHUNK_WORLD_SIZE;
    const l2OriginZ = cz * CHUNK_WORLD_SIZE;
    for (const lane of [1, 5]) {
      const laneOffset = (lane + 0.5) * CELL_SIZE + 0.52;
      props.push({ kind: "OVERHEAD_PIPE", x: l2OriginX + laneOffset, z: l2OriginZ + 12.0, y: 2.46, length: CHUNK_WORLD_SIZE, axis: "z" });
      props.push({ kind: "OVERHEAD_PIPE", x: l2OriginX + 12.0, z: l2OriginZ + laneOffset, y: 2.46, length: CHUNK_WORLD_SIZE, axis: "x" });
    }

    // Add wall-hugging chamfered concrete ribs (+ colliders) & corridor-facing multi-tier side pipes
    for (let lz = 0; lz < CHUNK_CELLS; lz += 1) {
      for (let lx = 0; lx < CHUNK_CELLS; lx += 1) {
        const cell = grid[lz][lx];
        if (SOLID_CELL_TYPES.has(cell) || cell === CELL_TYPES.DOOR) continue;
        const onCorridor = lx === 1 || lx === 5 || lz === 1 || lz === 5;
        if (!onCorridor) continue;

        const r = cellWorldRect(cx, cz, lx, lz);
        const axis = lx === 1 || lx === 5 ? "z" : "x";
        const leftSolid = lx > 0 && SOLID_CELL_TYPES.has(grid[lz][lx - 1]);
        const rightSolid = lx < CHUNK_CELLS - 1 && SOLID_CELL_TYPES.has(grid[lz][lx + 1]);
        const northSolid = lz > 0 && SOLID_CELL_TYPES.has(grid[lz - 1][lx]);
        const southSolid = lz < CHUNK_CELLS - 1 && SOLID_CELL_TYPES.has(grid[lz + 1][lx]);

        if ((lx + lz) % 2 === 0) {
          const sides = [];
          if (axis === "z") {
            if (leftSolid) sides.push(-1);
            if (rightSolid) sides.push(1);
          } else {
            if (northSolid) sides.push(-1);
            if (southSolid) sides.push(1);
          }
          if (sides.length > 0) {
            props.push({ kind: "CHAMFER_RIB", x: r.centerX, z: r.centerZ, axis, sides });
            const isZ = axis === "z";
            for (const side of sides) {
              const px = r.centerX + (isZ ? side * 1.38 : 0);
              const pz = r.centerZ + (isZ ? 0 : side * 1.38);
              propColliders.push({
                kind: "CHAMFER_PILASTER",
                minX: px - (isZ ? 0.13 : 0.16),
                maxX: px + (isZ ? 0.13 : 0.16),
                minZ: pz - (isZ ? 0.16 : 0.13),
                maxZ: pz + (isZ ? 0.16 : 0.13),
                height: levelData.environment.ceilingHeight,
              });
            }
          }
        }

        if (leftSolid) props.push({ kind: "SIDE_PIPE_RUN", x: r.minX + 0.16, z: r.centerZ, axis: "z", hasValve: (lx + lz) % 3 === 0 });
        if (rightSolid) props.push({ kind: "SIDE_PIPE_RUN", x: r.maxX - 0.16, z: r.centerZ, axis: "z", hasValve: false });
        if (northSolid) props.push({ kind: "SIDE_PIPE_RUN", x: r.centerX, z: r.minZ + 0.16, axis: "x", hasValve: (lx + lz) % 4 === 0 });
        if (southSolid) props.push({ kind: "SIDE_PIPE_RUN", x: r.centerX, z: r.maxZ - 0.16, axis: "x", hasValve: false });
        if (lx === 5 && lz === 1) {
          props.push({ kind: "STEAM_VENT", x: r.centerX, z: r.centerZ });
        }
      }
    }

    const dimPt = cellWorldRect(cx, cz, 1, 1);
    lights.push({
      x: dimPt.centerX,
      y: levelData.environment.ceilingHeight - 0.1,
      z: dimPt.centerZ,
      rotY: 0,
      flickerPhase: (Math.abs(cx * 3 + cz * 7) % 11) * 0.5,
    });
  }

  const walls = prebuiltWalls || extractChunkWalls(grid, wallStyles, cx, cz, levelData, zoneTag);

  return {
    key: chunkKey(levelId, cx, cz),
    levelId,
    cx,
    cz,
    worldSeed: seedNum,
    shiftEpoch: epoch,
    chunkHash,
    grid,
    walls,
    propColliders,
    lights,
    interactables,
    props,
  };
}

/**
 * Manages active chunks within loadRadius, evicts chunks beyond unloadRadius,
 * and drives Level 0 behind-the-gaze non-Euclidean corridor & chunk shifts.
 */
export class ChunkManager {
  constructor({
    levelId = "level_0",
    worldSeed = 1999,
    loadRadius = 2,
    unloadRadius = 3,
    onChunkLoad = null,
    onChunkUnload = null,
    onChunkReload = null,
  } = {}) {
    this.levelId = levelId;
    this.worldSeed = Number(worldSeed) || 1999;
    this.loadRadius = loadRadius;
    this.unloadRadius = Math.max(unloadRadius, loadRadius);
    this.onChunkLoad = onChunkLoad;
    this.onChunkUnload = onChunkUnload;
    this.onChunkReload = onChunkReload;
    this.chunks = new Map();
    this.chunkShiftEpochs = new Map();
    this.visitedChunks = new Set();
    this.nonEuclideanShiftCount = 0;
  }

  worldToChunk(x, z) {
    return {
      cx: Math.floor(x / CHUNK_WORLD_SIZE),
      cz: Math.floor(z / CHUNK_WORLD_SIZE),
    };
  }

  update(playerX, playerZ) {
    const { cx: pcx, cz: pcz } = this.worldToChunk(playerX, playerZ);
    this.visitedChunks.add(chunkKey(this.levelId, pcx, pcz));
    const loadedKeys = [];
    const unloadedKeys = [];

    for (let dz = -this.loadRadius; dz <= this.loadRadius; dz += 1) {
      for (let dx = -this.loadRadius; dx <= this.loadRadius; dx += 1) {
        const cx = pcx + dx;
        const cz = pcz + dz;
        const key = chunkKey(this.levelId, cx, cz);
        if (!this.chunks.has(key)) {
          const epoch = this.levelId === "level_0" ? (this.chunkShiftEpochs.get(key) || 0) : 0;
          const chunkData = generateChunkData(this.levelId, cx, cz, this.worldSeed, epoch);
          this.chunks.set(key, chunkData);
          loadedKeys.push(key);
          if (typeof this.onChunkLoad === "function") {
            this.onChunkLoad(chunkData);
          }
        }
      }
    }

    for (const [key, chunkData] of this.chunks.entries()) {
      const dist = Math.max(
        Math.abs(chunkData.cx - pcx),
        Math.abs(chunkData.cz - pcz)
      );
      if (dist > this.unloadRadius || chunkData.levelId !== this.levelId) {
        if (
          this.levelId === "level_0" &&
          chunkData.levelId === "level_0" &&
          this.visitedChunks.has(key)
        ) {
          this.chunkShiftEpochs.set(key, (this.chunkShiftEpochs.get(key) || 0) + 1);
        }
        this.chunks.delete(key);
        unloadedKeys.push(key);
        if (typeof this.onChunkUnload === "function") {
          this.onChunkUnload(chunkData);
        }
      }
    }

    return {
      pcx,
      pcz,
      loadedKeys,
      unloadedKeys,
      activeCount: this.chunks.size,
    };
  }

  /**
   * Non-Euclidean Level 0 mutation strictly outside player gaze:
   *  Priority 1 ("rear_chunk"): regenerate a previously visited adjacent chunk
   *    completely behind the player.
   *  Priority 2 ("local_corridor"): rewire interior corridor walls behind the
   *    player inside the current chunk while preserving full connectivity.
   */
  tryNonEuclideanShift(playerX, playerZ, forwardX, forwardZ, opts = {}) {
    const emptyRes = { shifted: false, mode: null, chunkKey: null, shiftEpoch: 0, changedCells: [] };
    if (this.levelId !== "level_0") return emptyRes;

    const fLen = Math.hypot(forwardX, forwardZ) || 1;
    const fx = forwardX / fLen;
    const fz = forwardZ / fLen;
    const isPointVisible = typeof opts.isPointVisible === "function" ? opts.isPointVisible : null;
    const { cx: pcx, cz: pcz } = this.worldToChunk(playerX, playerZ);

    const isSampleRear = (px, pz, maxDot) => {
      const dx = px - playerX;
      const dz = pz - playerZ;
      const d = Math.hypot(dx, dz) || 1;
      if ((dx / d) * fx + (dz / d) * fz >= maxDot) return false;
      if (isPointVisible && isPointVisible(px, pz)) return false;
      return true;
    };

    // Priority 1: Regenerate a previously visited rear neighbor chunk at next epoch
    const rearCandidates = [];
    for (const chunk of this.chunks.values()) {
      if (chunk.levelId !== "level_0" || !this.visitedChunks.has(chunk.key)) continue;
      if (Math.max(Math.abs(chunk.cx - pcx), Math.abs(chunk.cz - pcz)) !== 1) continue;
      const centerDistSq =
        (chunk.cx * CHUNK_WORLD_SIZE + 12 - playerX) ** 2 +
        (chunk.cz * CHUNK_WORLD_SIZE + 12 - playerZ) ** 2;
      rearCandidates.push({ chunk, epoch: chunk.shiftEpoch || 0, centerDistSq });
    }
    rearCandidates.sort((a, b) => a.epoch - b.epoch || a.centerDistSq - b.centerDistSq);

    for (const { chunk } of rearCandidates) {
      const minX = chunk.cx * CHUNK_WORLD_SIZE;
      const maxX = minX + CHUNK_WORLD_SIZE;
      const minZ = chunk.cz * CHUNK_WORLD_SIZE;
      const maxZ = minZ + CHUNK_WORLD_SIZE;
      const nearX = Math.max(minX, Math.min(playerX, maxX));
      const nearZ = Math.max(minZ, Math.min(playerZ, maxZ));
      if (Math.hypot(playerX - nearX, playerZ - nearZ) < 4.0) continue;

      const midX = (minX + maxX) * 0.5;
      const midZ = (minZ + maxZ) * 0.5;
      const rearPts = [
        [minX, minZ],
        [maxX, minZ],
        [minX, maxZ],
        [maxX, maxZ],
        [midX, midZ],
      ];
      if (!rearPts.every(([px, pz]) => isSampleRear(px, pz, -0.25))) continue;
      if (isPointVisible) {
        const edgePts = [[midX, minZ], [midX, maxZ], [minX, midZ], [maxX, midZ]];
        if (edgePts.some(([px, pz]) => isPointVisible(px, pz))) continue;
      }

      const nextEpoch = (this.chunkShiftEpochs.get(chunk.key) || 0) + 1;
      this.chunkShiftEpochs.set(chunk.key, nextEpoch);
      const nextChunk = generateChunkData("level_0", chunk.cx, chunk.cz, this.worldSeed, nextEpoch);
      this.chunks.set(chunk.key, nextChunk);
      this.nonEuclideanShiftCount += 1;
      if (typeof this.onChunkReload === "function") {
        this.onChunkReload(nextChunk, chunk);
      }
      return {
        shifted: true,
        mode: "rear_chunk",
        chunkKey: chunk.key,
        shiftEpoch: nextEpoch,
        changedCells: [],
      };
    }

    // Priority 2: Rewire unseen rear interior corridors inside the current chunk
    const curKey = chunkKey("level_0", pcx, pcz);
    const curChunk = this.chunks.get(curKey);
    if (!curChunk) return emptyRes;

    const plx = Math.max(0, Math.min(CHUNK_CELLS - 1, Math.floor((playerX - pcx * CHUNK_WORLD_SIZE) / CELL_SIZE)));
    const plz = Math.max(0, Math.min(CHUNK_CELLS - 1, Math.floor((playerZ - pcz * CHUNK_WORLD_SIZE) / CELL_SIZE)));
    if (!isWalkableCell(curChunk.grid, plx, plz)) return emptyRes;

    const protectedKeys = new Set();
    const hasManila = curChunk.grid.some((row) => row.includes(CELL_TYPES.MANILA_WALL));
    if (pcx === 0 && pcz === 0) {
      for (const k of ["0:0", "1:0", "2:3", "3:3", "2:5", "5:1", "6:6"]) protectedKeys.add(k);
    }
    if (hasManila) {
      for (let mz = 3; mz <= 5; mz += 1) {
        for (let mx = 3; mx <= 5; mx += 1) protectedKeys.add(cellKey(mx, mz));
      }
    }
    for (const it of curChunk.interactables) {
      if (it.lx != null && it.lz != null) protectedKeys.add(cellKey(it.lx, it.lz));
    }

    const closable = [];
    const openable = [];
    for (let lz = 1; lz < CHUNK_CELLS - 1; lz += 1) {
      for (let lx = 1; lx < CHUNK_CELLS - 1; lx += 1) {
        if (protectedKeys.has(cellKey(lx, lz))) continue;
        if (Math.max(Math.abs(lx - plx), Math.abs(lz - plz)) < 2) continue;

        const ct = curChunk.grid[lz][lx];
        if (ct !== CELL_TYPES.EMPTY && ct !== CELL_TYPES.WALL) continue;

        const r = cellWorldRect(pcx, pcz, lx, lz);
        if (Math.hypot(r.centerX - playerX, r.centerZ - playerZ) < 5.0) continue;

        const cellPts = [
          [r.minX, r.minZ],
          [r.maxX, r.minZ],
          [r.minX, r.maxZ],
          [r.maxX, r.maxZ],
          [r.centerX, r.centerZ],
        ];
        if (!cellPts.every(([px, pz]) => isSampleRear(px, pz, -0.42))) continue;

        if (ct === CELL_TYPES.EMPTY) {
          closable.push({ lx, lz });
        } else if (DIRS_4.some(([dx, dz]) => isWalkableCell(curChunk.grid, lx + dx, lz + dz))) {
          openable.push({ lx, lz, creates2x2: wouldCreate2x2Open(curChunk.grid, lx, lz) });
        }
      }
    }

    const borderOpenings = getLevel0BorderOpenings(this.worldSeed, pcx, pcz);
    const hasNoOrphanPockets = (testGrid) => {
      const { visited } = computeWalkableBfs(testGrid, plx, plz);
      for (let z = 0; z < CHUNK_CELLS; z += 1) {
        for (let x = 0; x < CHUNK_CELLS; x += 1) {
          if (isWalkableCell(testGrid, x, z) && !visited[z][x]) return false;
        }
      }
      return true;
    };
    const isMutatedGridValid = (testGrid) =>
      checkLevel0Connectivity(testGrid, plx, plz, borderOpenings, curChunk.interactables) &&
      hasNoOrphanPockets(testGrid);

    const rotOffset = this.nonEuclideanShiftCount + Math.abs(plx * 7 + plz * 13);
    const rotateList = (arr) =>
      arr.length <= 1 ? arr : arr.map((_, idx) => arr[(idx + (rotOffset % arr.length)) % arr.length]);

    const rotClose = rotateList(closable);
    const rotOpen = rotateList([
      ...openable.filter((o) => !o.creates2x2),
      ...openable.filter((o) => o.creates2x2),
    ]);

    let chosenGrid = null;
    let changedCells = [];

    for (const cl of rotClose) {
      for (const op of rotOpen) {
        if (Math.abs(cl.lx - op.lx) + Math.abs(cl.lz - op.lz) === 1) continue;
        const testGrid = curChunk.grid.map((row) => [...row]);
        testGrid[cl.lz][cl.lx] = CELL_TYPES.WALL;
        testGrid[op.lz][op.lx] = CELL_TYPES.EMPTY;
        if (isMutatedGridValid(testGrid)) {
          chosenGrid = testGrid;
          changedCells = [
            { lx: cl.lx, lz: cl.lz, from: CELL_TYPES.EMPTY, to: CELL_TYPES.WALL },
            { lx: op.lx, lz: op.lz, from: CELL_TYPES.WALL, to: CELL_TYPES.EMPTY },
          ];
          break;
        }
      }
      if (chosenGrid) break;
    }

    if (!chosenGrid) {
      for (const op of rotOpen) {
        const testGrid = curChunk.grid.map((row) => [...row]);
        testGrid[op.lz][op.lx] = CELL_TYPES.EMPTY;
        if (isMutatedGridValid(testGrid)) {
          chosenGrid = testGrid;
          changedCells = [{ lx: op.lx, lz: op.lz, from: CELL_TYPES.WALL, to: CELL_TYPES.EMPTY }];
          break;
        }
      }
    }
    if (!chosenGrid) {
      for (const cl of rotClose) {
        const testGrid = curChunk.grid.map((row) => [...row]);
        testGrid[cl.lz][cl.lx] = CELL_TYPES.WALL;
        if (isMutatedGridValid(testGrid)) {
          chosenGrid = testGrid;
          changedCells = [{ lx: cl.lx, lz: cl.lz, from: CELL_TYPES.EMPTY, to: CELL_TYPES.WALL }];
          break;
        }
      }
    }

    if (!chosenGrid) return emptyRes;

    const nextEpoch = (curChunk.shiftEpoch || 0) + 1;
    this.chunkShiftEpochs.set(curKey, nextEpoch);
    const nextHash = hashCoords(this.worldSeed, "level_0", pcx, pcz, nextEpoch * 131);
    const nextStyles = makeWallStyleGrid();
    assignLevel0WallStyles(chosenGrid, nextStyles, pcx, pcz, nextHash, nextEpoch, createMulberry32(nextHash));

    const levelData = getLevelData("level_0");
    const derived = buildLevel0DerivedData({
      grid: chosenGrid,
      wallStyles: nextStyles,
      cx: pcx,
      cz: pcz,
      chunkHash: nextHash,
      levelData,
      interactables: curChunk.interactables,
      shiftEpoch: nextEpoch,
    });

    const updatedChunk = {
      ...curChunk,
      chunkHash: nextHash,
      shiftEpoch: nextEpoch,
      grid: chosenGrid,
      walls: derived.walls,
      propColliders: derived.propColliders,
      lights: derived.lights,
      props: derived.props,
    };
    this.chunks.set(curKey, updatedChunk);
    this.nonEuclideanShiftCount += 1;
    if (typeof this.onChunkReload === "function") {
      this.onChunkReload(updatedChunk, curChunk);
    }

    return {
      shifted: true,
      mode: "local_corridor",
      chunkKey: curKey,
      shiftEpoch: nextEpoch,
      changedCells,
    };
  }

  /**
   * Resolve circle-vs-AABB collision across the 3x3 chunk neighborhood
   * (walls + propColliders), respecting vertical feetY clearance for jumpable obstacles.
   * Performs 2 separation passes for crisp corner sliding.
   */
  resolveCollision(x, z, radius = 0.42, feetY = 0) {
    let px = x;
    let pz = z;
    let collided = false;
    const hitCellTypes = [];
    let nearbyGlitchWall = null;

    const { cx: pcx, cz: pcz } = this.worldToChunk(px, pz);
    const candidateWalls = [];
    for (let dz = -1; dz <= 1; dz += 1) {
      for (let dx = -1; dx <= 1; dx += 1) {
        const chunk = this.chunks.get(chunkKey(this.levelId, pcx + dx, pcz + dz));
        if (chunk) {
          for (const w of chunk.walls) {
            if (feetY < (w.height ?? 99) - 0.06) {
              candidateWalls.push(w);
            }
          }
          if (chunk.propColliders) {
            for (const pc of chunk.propColliders) {
              if (feetY < (pc.height ?? 99) - 0.06) {
                candidateWalls.push(pc);
              }
            }
          }
        }
      }
    }

    for (let pass = 0; pass < 2; pass += 1) {
      for (const wall of candidateWalls) {
        const closestX = Math.max(wall.minX, Math.min(px, wall.maxX));
        const closestZ = Math.max(wall.minZ, Math.min(pz, wall.maxZ));
        const dx = px - closestX;
        const dz = pz - closestZ;
        const distSq = dx * dx + dz * dz;

        if (
          (wall.cellType === CELL_TYPES.GLITCH_WALL ||
            wall.cellType === CELL_TYPES.OUTLET_WALL) &&
          distSq <= 1.55 * 1.55
        ) {
          nearbyGlitchWall = wall;
        }

        if (distSq < radius * radius) {
          collided = true;
          const tag = wall.cellType || wall.kind || "PROP";
          if (!hitCellTypes.includes(tag)) {
            hitCellTypes.push(tag);
          }
          if (distSq > 1e-10) {
            const dist = Math.sqrt(distSq);
            const overlap = radius - dist;
            px += (dx / dist) * overlap;
            pz += (dz / dist) * overlap;
          } else {
            const dLeft = px - wall.minX;
            const dRight = wall.maxX - px;
            const dTop = pz - wall.minZ;
            const dBottom = wall.maxZ - pz;
            const m = Math.min(dLeft, dRight, dTop, dBottom);
            if (m === dLeft) px = wall.minX - radius;
            else if (m === dRight) px = wall.maxX + radius;
            else if (m === dTop) pz = wall.minZ - radius;
            else pz = wall.maxZ + radius;
          }
        }
      }
    }

    return {
      x: px,
      z: pz,
      collided,
      hitCellTypes,
      nearbyGlitchWall,
    };
  }

  findNearestInteractable(x, z, maxDist = 2.9) {
    const { cx: pcx, cz: pcz } = this.worldToChunk(x, z);
    let best = null;
    let bestDist = maxDist;

    for (let dz = -1; dz <= 1; dz += 1) {
      for (let dx = -1; dx <= 1; dx += 1) {
        const chunk = this.chunks.get(chunkKey(this.levelId, pcx + dx, pcz + dz));
        if (!chunk) continue;
        for (const item of chunk.interactables) {
          const d = Math.hypot(item.x - x, item.z - z);
          if (d <= bestDist) {
            bestDist = d;
            best = { ...item, distance: d };
          }
        }
      }
    }
    return best;
  }

  reset(newLevelId, newWorldSeed = this.worldSeed) {
    const unloadedKeys = [];
    for (const [key, chunkData] of this.chunks.entries()) {
      unloadedKeys.push(key);
      if (typeof this.onChunkUnload === "function") {
        this.onChunkUnload(chunkData);
      }
    }
    this.chunks.clear();
    this.chunkShiftEpochs.clear();
    this.visitedChunks.clear();
    this.nonEuclideanShiftCount = 0;
    this.levelId = newLevelId;
    this.worldSeed = Number(newWorldSeed) || 1999;
    return unloadedKeys;
  }
}

/**
 * Returns candidate URLs for loading textures from either root-served or
 * src-served HTTP servers, before falling back to procedural Canvas textures.
 */
export function resolveTextureCandidates(levelId, slot) {
  const levelData = getLevelData(levelId);
  const spec = levelData.textures?.[slot];
  if (!spec) return [];
  const candidates = [];
  if (spec.bundledPath) candidates.push(spec.bundledPath);
  if (spec.datasetPath) candidates.push(`../${spec.datasetPath}`);
  return candidates;
}

/**
 * Generates high-contrast procedural fallback textures when offline or under
 * file:// origin restrictions. Returns null safely in non-DOM (Node.js) mode.
 */
export function createProceduralTextureCanvas(
  style,
  width = 256,
  height = 256,
  seed = 1337
) {
  if (typeof document === "undefined") {
    return null;
  }
  const canvas = document.createElement("canvas");
  canvas.width = width;
  canvas.height = height;
  const ctx = canvas.getContext("2d");
  const rng = createMulberry32(seed);

  if (style === "level0_wallpaper") {
    ctx.fillStyle = "#c9b465";
    ctx.fillRect(0, 0, width, height);
    for (let x = 0; x < width; x += 32) {
      ctx.fillStyle = x % 64 === 0 ? "rgba(155, 134, 58, 0.35)" : "rgba(220, 200, 120, 0.22)";
      ctx.fillRect(x, 0, 14, height);
      ctx.strokeStyle = "rgba(128, 108, 42, 0.45)";
      ctx.lineWidth = 2;
      for (let y = 16; y < height; y += 32) {
        ctx.beginPath();
        ctx.moveTo(x + 8, y + 8);
        ctx.lineTo(x + 16, y);
        ctx.lineTo(x + 24, y + 8);
        ctx.stroke();
      }
    }
    const grad = ctx.createLinearGradient(0, height * 0.72, 0, height);
    grad.addColorStop(0, "rgba(70, 56, 24, 0)");
    grad.addColorStop(1, "rgba(65, 52, 20, 0.45)");
    ctx.fillStyle = grad;
    ctx.fillRect(0, height * 0.72, width, height * 0.28);
  } else if (style === "level0_carpet") {
    ctx.fillStyle = "#8a7846";
    ctx.fillRect(0, 0, width, height);
    for (let i = 0; i < 3200; i += 1) {
      const x = Math.floor(rng() * width);
      const y = Math.floor(rng() * height);
      ctx.fillStyle = rng() > 0.5 ? "rgba(108,92,48,0.45)" : "rgba(62,53,26,0.4)";
      ctx.fillRect(x, y, 2, 2);
    }
  } else if (style === "level0_ceiling") {
    ctx.fillStyle = "#d9d2b0";
    ctx.fillRect(0, 0, width, height);
    ctx.strokeStyle = "#8e886c";
    ctx.lineWidth = 3;
    for (let i = 0; i <= width; i += 64) {
      ctx.beginPath();
      ctx.moveTo(i, 0);
      ctx.lineTo(i, height);
      ctx.stroke();
      ctx.beginPath();
      ctx.moveTo(0, i);
      ctx.lineTo(width, i);
      ctx.stroke();
    }
  } else if (style === "manila_wallpaper") {
    ctx.fillStyle = "#c49b5c";
    ctx.fillRect(0, 0, width, height);
    ctx.strokeStyle = "rgba(110, 74, 30, 0.35)";
    ctx.lineWidth = 2;
    for (let y = 0; y < height; y += 32) {
      for (let x = 0; x < width; x += 32) {
        ctx.strokeRect(x + 4, y + 4, 24, 24);
      }
    }
  } else if (style === "level1_concrete") {
    ctx.fillStyle = "#6e7378";
    ctx.fillRect(0, 0, width, height);
    for (let i = 0; i < 2400; i += 1) {
      ctx.fillStyle = rng() > 0.5 ? "rgba(255,255,255,0.06)" : "rgba(0,0,0,0.09)";
      ctx.fillRect(rng() * width, rng() * height, 3, 3);
    }
    ctx.strokeStyle = "rgba(35,38,42,0.7)";
    ctx.lineWidth = 2;
    ctx.beginPath();
    ctx.moveTo(20, 40);
    ctx.lineTo(95, 110);
    ctx.lineTo(130, 195);
    ctx.stroke();
    ctx.fillStyle = "rgba(214, 165, 36, 0.55)";
    ctx.fillRect(0, height - 28, width, 10);
  } else if (style === "level1_asphalt") {
    ctx.fillStyle = "#484c52";
    ctx.fillRect(0, 0, width, height);
    for (let i = 0; i < 2500; i += 1) {
      ctx.fillStyle = rng() > 0.5 ? "rgba(255,255,255,0.05)" : "rgba(0,0,0,0.12)";
      ctx.fillRect(rng() * width, rng() * height, 2, 2);
    }
  } else if (style === "hub_tunnel") {
    ctx.fillStyle = "#5c4a3d";
    ctx.fillRect(0, 0, width, height);
    ctx.strokeStyle = "rgba(30,22,18,0.55)";
    ctx.lineWidth = 2;
    for (let y = 0; y < height; y += 24) {
      const offset = (y / 24) % 2 === 0 ? 0 : 24;
      for (let x = -24; x < width; x += 48) {
        ctx.strokeRect(x + offset, y, 48, 24);
      }
    }
  } else if (style === "hub_road") {
    ctx.fillStyle = "#343638";
    ctx.fillRect(0, 0, width, height);
    for (let i = 0; i < 3200; i += 1) {
      ctx.fillStyle = rng() > 0.45 ? "rgba(215,215,210,0.08)" : "rgba(0,0,0,0.22)";
      ctx.fillRect(rng() * width, rng() * height, 2, 2);
    }
  } else if (style === "hub_door") {
    ctx.fillStyle = "#6c737d";
    ctx.fillRect(0, 0, width, height);
    ctx.strokeStyle = "#b8963e";
    ctx.lineWidth = 6;
    ctx.strokeRect(10, 10, width - 20, height - 20);
  } else if (style === "level2_rust_pipe" || style === "level2_floor") {
    ctx.fillStyle = style === "level2_floor" ? "#3b3531" : "#4f3c31";
    ctx.fillRect(0, 0, width, height);
    for (let y = 24; y < height; y += 56) {
      ctx.fillStyle = "#6e3d22";
      ctx.fillRect(0, y, width, 18);
      ctx.fillStyle = "rgba(255,200,150,0.16)";
      ctx.fillRect(0, y + 3, width, 4);
    }
  } else {
    ctx.fillStyle = "#7a7052";
    ctx.fillRect(0, 0, width, height);
  }

  return canvas;
}
