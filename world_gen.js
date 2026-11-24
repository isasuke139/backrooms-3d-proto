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
export const L0_SUB_CELLS = 8;
export const L0_SUB_SIZE = CHUNK_WORLD_SIZE / L0_SUB_CELLS; // 3.0 meters
export const L0_WALL_THICK = 0.24;
export const L0_SUB_FOR_MACRO = Object.freeze({ 1: 1, 2: 2, 3: 3, 4: 4, 5: 5, 6: 6 });

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

const DIRS_4 = [
  [1, 0, "E", "W"],
  [-1, 0, "W", "E"],
  [0, 1, "S", "N"],
  [0, -1, "N", "S"],
];

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

/**
 * Generates a high-density 12x12 (2.0m pitch) thin-drywall labyrinth for Level 0
 * with turn-biased Growing-Tree corridors, abundant dead ends, asymmetric pocket,
 * seamless cross-chunk doorways matching `L0_SUB_FOR_MACRO`, and sparse troffers.
 */
function generateLevel0ThinWallMaze({ cx, cz, seedNum, chunkHash, epoch, levelData }) {
  const rng = createMulberry32((chunkHash ^ 0x517cc1b7) >>> 0);
  const grid = makeEmptyGrid();
  const wallStyles = makeWallStyleGrid();
  const originX = cx * CHUNK_WORLD_SIZE;
  const originZ = cz * CHUNK_WORLD_SIZE;
  const ceilH = levelData.environment.ceilingHeight;

  const N = L0_SUB_CELLS;
  const wallN = Array.from({ length: N }, () => Array(N).fill(true));
  const wallS = Array.from({ length: N }, () => Array(N).fill(true));
  const wallW = Array.from({ length: N }, () => Array(N).fill(true));
  const wallE = Array.from({ length: N }, () => Array(N).fill(true));
  const blocked = Array.from({ length: N }, () => Array(N).fill(false));

  const openSubEdge = (sx, sz, dir) => {
    if (sx < 0 || sx >= N || sz < 0 || sz >= N) return;
    if (dir === "N") {
      wallN[sz][sx] = false;
      if (sz > 0) wallS[sz - 1][sx] = false;
    } else if (dir === "S") {
      wallS[sz][sx] = false;
      if (sz < N - 1) wallN[sz + 1][sx] = false;
    } else if (dir === "W") {
      wallW[sz][sx] = false;
      if (sx > 0) wallE[sz][sx - 1] = false;
    } else if (dir === "E") {
      wallE[sz][sx] = false;
      if (sx < N - 1) wallW[sz][sx + 1] = false;
    }
  };

  // Symmetric cross-chunk border doorways aligned to L0_SUB_FOR_MACRO
  for (let slot = 1; slot <= 6; slot += 1) {
    const s = L0_SUB_FOR_MACRO[slot];
    if (isBorderOpening(seedNum, "level_0", cx, cz, cx, cz - 1, slot)) wallN[0][s] = false;
    if (isBorderOpening(seedNum, "level_0", cx, cz, cx, cz + 1, slot)) wallS[N - 1][s] = false;
    if (isBorderOpening(seedNum, "level_0", cx, cz, cx - 1, cz, slot)) wallW[s][0] = false;
    if (isBorderOpening(seedNum, "level_0", cx, cz, cx + 1, cz, slot)) wallE[s][N - 1] = false;
  }

  const walls = [];
  const props = [];
  const propColliders = [];
  const lights = [];
  const interactables = [];
  const landmarkBoxes = [];

  const isInsideLandmark = (wx, wz, pad = 0.05) =>
    landmarkBoxes.some(
      (b) => wx >= b.minX - pad && wx <= b.maxX + pad && wz >= b.minZ - pad && wz <= b.maxZ + pad
    );

  const pushMacroWall = (lx, lz, cellType, style = "solid") => {
    grid[lz][lx] = cellType;
    wallStyles[lz][lx] = style;
    const r = cellWorldRect(cx, cz, lx, lz, 0, 0);
    walls.push({
      lx,
      lz,
      cellType,
      wallStyle: style,
      zoneLabel: null,
      minX: r.minX,
      maxX: r.maxX,
      minZ: r.minZ,
      maxZ: r.maxZ,
      height: ceilH,
    });
  };

  const isOrigin = cx === 0 && cz === 0;
  const isInitialOrigin = isOrigin && epoch === 0;
  const isManilaChunk = !isOrigin && ((cx === 1 && cz === 0) || hashCoords(seedNum, "level_0", cx, cz, 0) % 13 === 0);

  if (isOrigin) {
    // Spawn (1.5, 1.5) sits dead-center inside 3.0m sub-cell (0,0)
    openSubEdge(0, 0, "E");
    openSubEdge(0, 0, "S");

    grid[5][2] = CELL_TYPES.STAIRS;
    openSubEdge(2, 5, "W");
    openSubEdge(2, 5, "S");
    landmarkBoxes.push({
      minX: originX + 6.2,
      maxX: originX + 8.8,
      minZ: originZ + 15.2,
      maxZ: originZ + 17.8,
    });
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
      // Collision test block (lx=3, lz=3 -> [9..12, 9..12]) + unobstructed West/North approach
      pushMacroWall(3, 3, CELL_TYPES.WALL, "solid");
      blocked[3][3] = true;
      openSubEdge(2, 3, "N");
      openSubEdge(2, 3, "W");
      openSubEdge(2, 2, "E");
      landmarkBoxes.push({
        minX: originX + 9.0,
        maxX: originX + 12.0,
        minZ: originZ + 9.0,
        maxZ: originZ + 12.0,
      });

      // Glitch Wall (5,1) & Outlet Wall (6,6)
      pushMacroWall(5, 1, CELL_TYPES.GLITCH_WALL, "solid");
      blocked[1][5] = true;
      landmarkBoxes.push({
        minX: originX + 15.0,
        maxX: originX + 18.0,
        minZ: originZ + 3.0,
        maxZ: originZ + 6.0,
      });
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

      pushMacroWall(6, 6, CELL_TYPES.OUTLET_WALL, "solid");
      blocked[6][6] = true;
      landmarkBoxes.push({
        minX: originX + 18.0,
        maxX: originX + 21.0,
        minZ: originZ + 18.0,
        maxZ: originZ + 21.0,
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
          pushMacroWall(mx, mz, CELL_TYPES.MANILA_WALL, "manila_wall");
        }
      }
    }
    for (let sz = 3; sz <= 5; sz += 1) {
      for (let sx = 3; sx <= 5; sx += 1) {
        blocked[sz][sx] = true;
      }
    }
    blocked[4][3] = false;
    blocked[4][4] = false;
    openSubEdge(2, 4, "E");
    openSubEdge(3, 4, "E");
    landmarkBoxes.push({
      minX: originX + 9.0,
      maxX: originX + 18.0,
      minZ: originZ + 9.0,
      maxZ: originZ + 18.0,
    });
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
  } else if (chunkHash % 5 === 0) {
    pushMacroWall(4, 3, CELL_TYPES.GLITCH_WALL, "solid");
    blocked[3][4] = true;
    landmarkBoxes.push({
      minX: originX + 12.0,
      maxX: originX + 15.0,
      minZ: originZ + 9.0,
      maxZ: originZ + 12.0,
    });
    const gRect = cellWorldRect(cx, cz, 4, 3);
    interactables.push({
      id: `l0_glitch_${cx}_${cz}`,
      type: "GLITCH_WALL",
      triggerType: "NOCLIP_WALL",
      label: "歪んだ壁面境界 (Nキーでノークリップ)",
      x: gRect.centerX,
      z: gRect.centerZ,
      lx: 4,
      lz: 3,
      context: {},
    });
  }

  // Carve turn-biased Growing-Tree spanning labyrinth on unblocked 8x8 sub-cells (2.76m clear corridors)
  const visitedSub = Array.from({ length: N }, () => Array(N).fill(false));
  const runGrowingTreeFrom = (startX, startZ) => {
    if (blocked[startZ][startX] || visitedSub[startZ][startX]) return;
    visitedSub[startZ][startX] = true;
    const active = [{ sx: startX, sz: startZ, dx: 0, dz: 0, straightRun: 0 }];
    while (active.length > 0) {
      const aIdx = rng() < 0.82 ? active.length - 1 : Math.floor(rng() * active.length);
      const cur = active[aIdx];
      const cand = [];
      for (const [dx, dz, dir] of DIRS_4) {
        const nx = cur.sx + dx;
        const nz = cur.sz + dz;
        if (nx < 0 || nx >= N || nz < 0 || nz >= N) continue;
        if (blocked[nz][nx] || visitedSub[nz][nx]) continue;
        const hasPrev = cur.dx !== 0 || cur.dz !== 0;
        const sameDir = hasPrev && dx === cur.dx && dz === cur.dz;
        const weight = sameDir ? (cur.straightRun >= 2 ? 0.05 : 0.65) : 5.2;
        cand.push({ nx, nz, dx, dz, dir, sameDir, weight });
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
      openSubEdge(cur.sx, cur.sz, chosen.dir);
      visitedSub[chosen.nz][chosen.nx] = true;
      active.push({
        sx: chosen.nx,
        sz: chosen.nz,
        dx: chosen.dx,
        dz: chosen.dz,
        straightRun: chosen.sameDir ? cur.straightRun + 1 : 0,
      });
    }
  };

  let rootSx = isOrigin ? 0 : isManilaChunk ? 2 : 1 + (chunkHash % 6);
  let rootSz = isOrigin ? 0 : isManilaChunk ? 4 : 1 + ((chunkHash >>> 4) % 6);
  if (blocked[rootSz][rootSx]) {
    rootSx = 0;
    rootSz = 0;
  }
  runGrowingTreeFrom(rootSx, rootSz);

  // Sweep to guarantee 100% single-component connectivity of every unblocked sub-cell
  let sweepAdded = true;
  while (sweepAdded) {
    sweepAdded = false;
    for (let sz = 0; sz < N; sz += 1) {
      for (let sx = 0; sx < N; sx += 1) {
        if (blocked[sz][sx] || visitedSub[sz][sx]) continue;
        for (const [dx, dz, dir] of DIRS_4) {
          const nx = sx + dx;
          const nz = sz + dz;
          if (nx >= 0 && nx < N && nz >= 0 && nz < N && !blocked[nz][nx] && visitedSub[nz][nx]) {
            openSubEdge(sx, sz, dir);
            runGrowingTreeFrom(sx, sz);
            sweepAdded = true;
            break;
          }
        }
      }
    }
  }

  // Subtle micro-loops (1-2) between distant branches so dead ends stay authentic
  const subDist = Array.from({ length: N }, () => Array(N).fill(-1));
  const bfsQ = [[rootSx, rootSz]];
  subDist[rootSz][rootSx] = 0;
  for (let head = 0; head < bfsQ.length; head += 1) {
    const [sx, sz] = bfsQ[head];
    const dNext = subDist[sz][sx] + 1;
    for (const [dx, dz, dir] of DIRS_4) {
      const nx = sx + dx;
      const nz = sz + dz;
      if (nx < 0 || nx >= N || nz < 0 || nz >= N || blocked[nz][nx] || subDist[nz][nx] !== -1) continue;
      const isClosed =
        (dir === "N" && wallN[sz][sx]) ||
        (dir === "S" && wallS[sz][sx]) ||
        (dir === "W" && wallW[sz][sx]) ||
        (dir === "E" && wallE[sz][sx]);
      if (!isClosed) {
        subDist[nz][nx] = dNext;
        bfsQ.push([nx, nz]);
      }
    }
  }

  const loopCand = [];
  for (let sz = 1; sz < N - 1; sz += 1) {
    for (let sx = 1; sx < N - 1; sx += 1) {
      if (blocked[sz][sx]) continue;
      if (!blocked[sz][sx + 1] && wallE[sz][sx] && Math.abs(subDist[sz][sx] - subDist[sz][sx + 1]) >= 6) {
        const mx = originX + (sx + 1) * L0_SUB_SIZE;
        const mz = originZ + (sz + 0.5) * L0_SUB_SIZE;
        if (!isInsideLandmark(mx, mz)) loopCand.push({ sx, sz, dir: "E" });
      }
      if (!blocked[sz + 1][sx] && wallS[sz][sx] && Math.abs(subDist[sz][sx] - subDist[sz + 1][sx]) >= 6) {
        const mx = originX + (sx + 0.5) * L0_SUB_SIZE;
        const mz = originZ + (sz + 1) * L0_SUB_SIZE;
        if (!isInsideLandmark(mx, mz)) loopCand.push({ sx, sz, dir: "S" });
      }
    }
  }
  const targetLoops = Math.min(loopCand.length, 1 + (chunkHash % 2));
  for (let i = 0; i < targetLoops; i += 1) {
    const pick = loopCand[(i * 7 + (chunkHash >>> 3)) % loopCand.length];
    openSubEdge(pick.sx, pick.sz, pick.dir);
  }

  // Carve 1 small asymmetric 2x2 chamber (6m x 6m) + optional central square column
  let chamberCenter = null;
  for (let tryIdx = 0; tryIdx < 64; tryIdx += 1) {
    const cx0 = 1 + ((tryIdx * 3 + (chunkHash % 5)) % 5);
    const cz0 = 1 + ((tryIdx * 5 + ((chunkHash >>> 5) % 5)) % 5);
    const four = [
      [cx0, cz0],
      [cx0 + 1, cz0],
      [cx0, cz0 + 1],
      [cx0 + 1, cz0 + 1],
    ];
    if (four.some(([x, z]) => blocked[z][x])) continue;
    const minWX = originX + cx0 * L0_SUB_SIZE;
    const maxWX = minWX + 2 * L0_SUB_SIZE;
    const minWZ = originZ + cz0 * L0_SUB_SIZE;
    const maxWZ = minWZ + 2 * L0_SUB_SIZE;
    const hitsLandmark = landmarkBoxes.some(
      (b) => maxWX > b.minX - 0.3 && minWX < b.maxX + 0.3 && maxWZ > b.minZ - 0.3 && minWZ < b.maxZ + 0.3
    );
    if (hitsLandmark) continue;

    openSubEdge(cx0, cz0, "E");
    openSubEdge(cx0, cz0, "S");
    openSubEdge(cx0 + 1, cz0, "S");
    openSubEdge(cx0, cz0 + 1, "E");
    chamberCenter = {
      x: originX + (cx0 + 1) * L0_SUB_SIZE,
      z: originZ + (cz0 + 1) * L0_SUB_SIZE,
      sx: cx0,
      sz: cz0,
    };
    break;
  }

  if (chamberCenter && (isInitialOrigin || chunkHash % 2 === 0)) {
    const halfP = 0.39;
    const pLx = Math.min(CHUNK_CELLS - 1, Math.max(0, Math.floor((chamberCenter.x - originX) / CELL_SIZE)));
    const pLz = Math.min(CHUNK_CELLS - 1, Math.max(0, Math.floor((chamberCenter.z - originZ) / CELL_SIZE)));
    walls.push({
      lx: pLx,
      lz: pLz,
      cellType: CELL_TYPES.PILLAR,
      wallStyle: "l0_pillar",
      zoneLabel: null,
      minX: chamberCenter.x - halfP,
      maxX: chamberCenter.x + halfP,
      minZ: chamberCenter.z - halfP,
      maxZ: chamberCenter.z + halfP,
      height: ceilH,
    });
  } else if (isInitialOrigin) {
    // Fallback pillar centered inside sub-cell (6,2) if no chamber fit
    walls.push({
      lx: 6,
      lz: 2,
      cellType: CELL_TYPES.PILLAR,
      wallStyle: "l0_pillar",
      zoneLabel: null,
      minX: originX + 18.61,
      maxX: originX + 19.39,
      minZ: originZ + 6.61,
      maxZ: originZ + 7.39,
      height: ceilH,
    });
  }

  // Emit seamless horizontal (EW) and vertical (NS) thin drywall wall segments
  const halfT = L0_WALL_THICK * 0.5;
  const ewWallSegments = [];
  const nsWallSegments = [];
  let archCount = 0;
  let wallSegmentCount = 0;

  for (let sz = 0; sz <= N; sz += 1) {
    for (let sx = 0; sx < N; sx += 1) {
      const closed = sz === 0 ? wallN[0][sx] : sz === N ? wallS[N - 1][sx] : wallN[sz][sx];
      if (!closed) continue;
      const wx = originX + (sx + 0.5) * L0_SUB_SIZE;
      const wz = originZ + (sz === 0 ? halfT : sz === N ? CHUNK_WORLD_SIZE - halfT : sz * L0_SUB_SIZE);
      if (isInsideLandmark(wx, wz)) continue;

      const canArch =
        sz >= 2 &&
        sz <= N - 2 &&
        sx >= 1 &&
        sx <= N - 2 &&
        !blocked[sz - 1]?.[sx] &&
        !blocked[sz]?.[sx];
      const useArch = canArch && archCount < (isInitialOrigin ? 2 : 3) && ((sx * 5 + sz * 7 + chunkHash) % 11 === 0);
      const style = useArch ? "arched_divider" : "maze_wall_ew";
      if (useArch) archCount += 1;

      const seg = {
        lx: Math.min(CHUNK_CELLS - 1, Math.floor((wx - originX) / CELL_SIZE)),
        lz: Math.min(CHUNK_CELLS - 1, Math.floor((wz - originZ) / CELL_SIZE)),
        cellType: CELL_TYPES.WALL,
        wallStyle: style,
        zoneLabel: null,
        minX: wx - L0_SUB_SIZE * 0.5 - halfT,
        maxX: wx + L0_SUB_SIZE * 0.5 + halfT,
        minZ: wz - halfT,
        maxZ: wz + halfT,
        height: ceilH,
      };
      walls.push(seg);
      ewWallSegments.push({ seg, wx, wz, sz, sx });
      wallSegmentCount += 1;
    }
  }

  // Guarantee >= 1 arched_divider in initial (0,0) (and colonnade chunks)
  if (archCount === 0 && (isInitialOrigin || chunkHash % 3 === 2)) {
    const fallbackArch = ewWallSegments.find(
      (e) => e.sz >= 2 && e.sz <= N - 2 && e.sx >= 1 && e.sx <= N - 2 && !blocked[e.sz - 1]?.[e.sx] && !blocked[e.sz]?.[e.sx]
    );
    if (fallbackArch) {
      fallbackArch.seg.wallStyle = "arched_divider";
      archCount += 1;
    }
  }

  const nsHalfT = 0.118; // 0.236m thick (4mm thinner than EW walls to avoid corner Z-fighting)
  for (let sx = 0; sx <= N; sx += 1) {
    for (let sz = 0; sz < N; sz += 1) {
      const closed = sx === 0 ? wallW[sz][0] : sx === N ? wallE[sz][N - 1] : wallW[sz][sx];
      if (!closed) continue;
      const wx = originX + (sx === 0 ? halfT : sx === N ? CHUNK_WORLD_SIZE - halfT : sx * L0_SUB_SIZE);
      const wz = originZ + (sz + 0.5) * L0_SUB_SIZE;
      if (isInsideLandmark(wx, wz)) continue;

      const seg = {
        lx: Math.min(CHUNK_CELLS - 1, Math.floor((wx - originX) / CELL_SIZE)),
        lz: Math.min(CHUNK_CELLS - 1, Math.floor((wz - originZ) / CELL_SIZE)),
        cellType: CELL_TYPES.WALL,
        wallStyle: "maze_wall_ns",
        zoneLabel: null,
        minX: wx - nsHalfT,
        maxX: wx + nsHalfT,
        minZ: wz - L0_SUB_SIZE * 0.5 - nsHalfT,
        maxZ: wz + L0_SUB_SIZE * 0.5 + nsHalfT,
        height: ceilH,
      };
      walls.push(seg);
      nsWallSegments.push({ seg, wx, wz, sx, sz });
      wallSegmentCount += 1;
    }
  }

  // Electrical outlets flush on interior EW/NS drywall segments (~6-9 per chunk, >= 2 in 0,0)
  const targetOutlets = isInitialOrigin ? 7 : 6 + (chunkHash % 4);
  for (const ew of ewWallSegments) {
    if (props.length >= targetOutlets) break;
    if (ew.seg.wallStyle !== "maze_wall_ew" || ew.sz <= 0 || ew.sz >= N) continue;
    if (((ew.sx * 3 + ew.sz * 11 + chunkHash) % 13) > 1 && !(isInitialOrigin && props.length < 2)) continue;
    const faceSouth = (ew.sx + ew.sz) % 2 === 0 && !blocked[ew.sz]?.[ew.sx];
    props.push({
      kind: "WALL_OUTLET",
      x: ew.wx,
      z: ew.wz + (faceSouth ? halfT + 0.015 : -(halfT + 0.015)),
      rotY: faceSouth ? 0 : Math.PI,
    });
  }
  for (const ns of nsWallSegments) {
    if (props.length >= targetOutlets) break;
    if (ns.sx <= 0 || ns.sx >= N) continue;
    if (((ns.sx * 7 + ns.sz * 5 + chunkHash) % 11) !== 0 && !(isInitialOrigin && props.length < 2)) continue;
    const faceEast = (ns.sx + ns.sz) % 2 === 0 && !blocked[ns.sz]?.[ns.sx];
    props.push({
      kind: "WALL_OUTLET",
      x: ns.wx + (faceEast ? nsHalfT + 0.015 : -(nsHalfT + 0.015)),
      z: ns.wz,
      rotY: faceEast ? Math.PI * 0.5 : -Math.PI * 0.5,
    });
  }

  // Compute sub-grid maze metrics & dead ends, and emit carpet furniture indents
  let deadEndCount = 0;
  let cornerCount = 0;
  const deadEndCells = [];
  const walkableSubs = [];

  for (let sz = 0; sz < N; sz += 1) {
    for (let sx = 0; sx < N; sx += 1) {
      if (blocked[sz][sx]) continue;
      const openN = !wallN[sz][sx] && !(sz > 0 && blocked[sz - 1][sx]);
      const openS = !wallS[sz][sx] && !(sz < N - 1 && blocked[sz + 1][sx]);
      const openW = !wallW[sz][sx] && !(sx > 0 && blocked[sz][sx - 1]);
      const openE = !wallE[sz][sx] && !(sx < N - 1 && blocked[sz][sx + 1]);
      const deg = (openN ? 1 : 0) + (openS ? 1 : 0) + (openW ? 1 : 0) + (openE ? 1 : 0);
      if (deg === 1) {
        deadEndCount += 1;
        deadEndCells.push({ sx, sz });
      }
      if (deg >= 3 || (deg === 2 && (openN || openS) && (openW || openE))) {
        cornerCount += 1;
      }
      const wx = originX + (sx + 0.5) * L0_SUB_SIZE;
      const wz = originZ + (sz + 0.5) * L0_SUB_SIZE;
      if (!isInsideLandmark(wx, wz, 0.2)) {
        walkableSubs.push({ sx, sz, wx, wz, deg });
      }
    }
  }

  let maxStraightRun = 0;
  for (let sz = 0; sz < N; sz += 1) {
    let run = 0;
    for (let sx = 0; sx < N - 1; sx += 1) {
      if (!blocked[sz][sx] && !blocked[sz][sx + 1] && !wallE[sz][sx]) {
        run += 1;
        if (run > maxStraightRun) maxStraightRun = run;
      } else {
        run = 0;
      }
    }
  }
  for (let sx = 0; sx < N; sx += 1) {
    let run = 0;
    for (let sz = 0; sz < N - 1; sz += 1) {
      if (!blocked[sz][sx] && !blocked[sz + 1][sx] && !wallS[sz][sx]) {
        run += 1;
        if (run > maxStraightRun) maxStraightRun = run;
      } else {
        run = 0;
      }
    }
  }

  // Carpet indents in dead-end alcoves & chamber corners
  let indentCount = 0;
  for (const de of deadEndCells) {
    if (indentCount >= 10) break;
    const wx = originX + (de.sx + 0.5) * L0_SUB_SIZE;
    const wz = originZ + (de.sz + 0.5) * L0_SUB_SIZE;
    if (isInsideLandmark(wx, wz, 0.25)) continue;
    if (rng() < 0.42 || (isInitialOrigin && indentCount < 2)) {
      props.push({
        kind: "CARPET_INDENT",
        x: wx + (rng() - 0.5) * 0.35,
        z: wz + (rng() - 0.5) * 0.35,
        w: 0.65 + rng() * 0.45,
        d: 0.55 + rng() * 0.45,
        rotY: rng() * Math.PI,
      });
      indentCount += 1;
    }
  }
  if (indentCount < 2) {
    for (const sub of walkableSubs) {
      if (indentCount >= 2) break;
      props.push({ kind: "CARPET_INDENT", x: sub.wx, z: sub.wz, w: 0.78, d: 0.68, rotY: 0.4 });
      indentCount += 1;
    }
  }

  // Sparse, irregular fluorescent ceiling fixtures (5-7/chunk, >= 4 in 0,0) leaving dead-ends murky
  const targetLights = Math.min(walkableSubs.length, isInitialOrigin ? 6 : 5 + (chunkHash % 3));
  const preferredLights = walkableSubs.filter((s) => s.deg >= 2);
  const lightPool = preferredLights.length >= 4 ? preferredLights : walkableSubs;
  for (let i = 0; i < lightPool.length && lights.length < targetLights; i += 1) {
    const c = lightPool[(i * 7 + (chunkHash % Math.max(1, lightPool.length))) % lightPool.length];
    if (lights.some((lt) => Math.hypot(lt.x - c.wx, lt.z - c.wz) < 5.2)) continue;
    lights.push({
      x: c.wx + (rng() - 0.5) * 0.28,
      y: ceilH - 0.04,
      z: c.wz + (rng() - 0.5) * 0.28,
      rotY: rng() < 0.45 ? Math.PI * 0.5 : 0,
      flickerPhase: ((c.sx * 7 + c.sz * 13 + Math.abs(cx + cz)) % 17) * 0.37,
    });
  }
  const minLights = isOrigin ? 4 : 3;
  for (const c of walkableSubs) {
    if (lights.length >= minLights) break;
    if (lights.some((lt) => Math.hypot(lt.x - c.wx, lt.z - c.wz) < 2.2)) continue;
    lights.push({
      x: c.wx,
      y: ceilH - 0.04,
      z: c.wz,
      rotY: rng() < 0.35 ? Math.PI * 0.5 : 0,
      flickerPhase: ((c.sx + c.sz) % 11) * 0.4,
    });
  }

  return {
    grid,
    wallStyles,
    walls,
    props,
    propColliders,
    lights,
    interactables,
    mazeMeta: {
      subCells: N,
      subSize: L0_SUB_SIZE,
      wallSegmentCount,
      deadEndCount,
      cornerCount,
      maxStraightRun,
    },
  };
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
  let grid = makeEmptyGrid();
  const wallStyles = makeWallStyleGrid();
  let lights = [];
  let interactables = [];
  let props = [];
  let propColliders = [];
  let prebuiltWalls = null;
  let mazeMeta = null;
  const zoneTag = `${String.fromCharCode(65 + Math.abs(cx * 3 + cz) % 6)}${Math.abs(cx + cz * 2) % 9 + 1}`;

  if (levelId === "level_0") {
    const l0 = generateLevel0ThinWallMaze({ cx, cz, seedNum, chunkHash, epoch, levelData });
    grid = l0.grid;
    prebuiltWalls = l0.walls;
    props = l0.props;
    propColliders = l0.propColliders;
    lights = l0.lights;
    interactables = l0.interactables;
    mazeMeta = l0.mazeMeta;
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

    // Parking bay yellow wheel stops, floor directional arrows, white asphalt stall lines, orange barriers, ceiling beams & pipes
    const baseChunkX = cx * CHUNK_WORLD_SIZE;
    const baseChunkZ = cz * CHUNK_WORLD_SIZE;
    for (const lx of [2, 6]) {
      const rStop = cellWorldRect(cx, cz, lx, 3);
      props.push({ kind: "WHEEL_STOP", x: rStop.centerX, z: rStop.centerZ, rotY: 0 });
      const rArr = cellWorldRect(cx, cz, lx, 2);
      props.push({ kind: "FLOOR_ARROW", x: rArr.centerX, z: rArr.centerZ, rotY: 0 });
      if (!SOLID_CELL_TYPES.has(grid[3][lx])) {
        for (const sxLine of [rStop.minX + 0.08, rStop.maxX - 0.08]) {
          props.push({ kind: "PARKING_LINE", x: sxLine, z: rStop.centerZ + 0.15, w: 0.11, d: 3.1 });
        }
      }
    }
    for (let lx = 0; lx < CHUNK_CELLS; lx += 1) {
      if (!SOLID_CELL_TYPES.has(grid[2][lx])) {
        const laneX = baseChunkX + (lx + 0.5) * CELL_SIZE;
        props.push({ kind: "PARKING_LINE", x: laneX, z: baseChunkZ + 6.08, w: CELL_SIZE - 0.12, d: 0.10 });
        props.push({ kind: "PARKING_LINE", x: laneX, z: baseChunkZ + 8.92, w: CELL_SIZE - 0.12, d: 0.10 });
      }
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
    mazeMeta,
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
 * and filters collision lookups to nearby chunk bounding boxes.
 */
export class ChunkManager {
  constructor({
    levelId = "level_0",
    worldSeed = 1999,
    loadRadius = 2,
    unloadRadius = 3,
    enableNonEuclidean = false,
    onChunkLoad = null,
    onChunkUnload = null,
    onChunkReload = null,
  } = {}) {
    this.levelId = levelId;
    this.worldSeed = Number(worldSeed) || 1999;
    this.loadRadius = loadRadius;
    this.unloadRadius = Math.max(unloadRadius, loadRadius);
    this.enableNonEuclidean = Boolean(enableNonEuclidean);
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
          const epoch =
            this.levelId === "level_0" && this.enableNonEuclidean
              ? (this.chunkShiftEpochs.get(key) || 0)
              : 0;
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
          this.enableNonEuclidean &&
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
   * Dormant non-Euclidean Level 0 rear-chunk shifter strictly outside player gaze.
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

    return emptyRes;
  }

  /**
   * Resolve circle-vs-AABB collision across nearby chunk AABBs within radius + 1.6m
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
    const chunkReach = radius + 1.6;
    const candidateWalls = [];
    for (let dz = -1; dz <= 1; dz += 1) {
      for (let dx = -1; dx <= 1; dx += 1) {
        const cx = pcx + dx;
        const cz = pcz + dz;
        const cMinX = cx * CHUNK_WORLD_SIZE;
        const cMaxX = cMinX + CHUNK_WORLD_SIZE;
        const cMinZ = cz * CHUNK_WORLD_SIZE;
        const cMaxZ = cMinZ + CHUNK_WORLD_SIZE;
        const nearX = Math.max(cMinX, Math.min(px, cMaxX));
        const nearZ = Math.max(cMinZ, Math.min(pz, cMaxZ));
        if (Math.hypot(px - nearX, pz - nearZ) > chunkReach) continue;

        const chunk = this.chunks.get(chunkKey(this.levelId, cx, cz));
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
