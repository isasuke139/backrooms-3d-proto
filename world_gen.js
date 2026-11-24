/**
 * Seed-deterministic infinite chunk maze generator, cross-chunk seam solver,
 * AABB circle collision resolver, and Canvas 2D procedural texture fallback.
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
  // Always keep origin spawn neighborhood open across (-1,0)/(0,-1)/(0,0) seams
  if (
    ((ax === 0 && az === 0) || (bx === 0 && bz === 0)) &&
    slot >= 0 &&
    slot <= 2
  ) {
    return true;
  }
  // Canonical ordering so (A, B) === (B, A)
  const swap = ax > bx || (ax === bx && az > bz);
  const c1x = swap ? bx : ax;
  const c1z = swap ? bz : az;
  const c2x = swap ? ax : bx;
  const c2z = swap ? az : bz;

  // Deterministic guaranteed slots plus hashed openings
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
  // North edge (lz = 0) shared with (cx, cz - 1)
  for (let lx = 0; lx < CHUNK_CELLS; lx += 1) {
    if (isBorderOpening(worldSeed, levelId, cx, cz, cx, cz - 1, lx)) {
      if (SOLID_CELL_TYPES.has(grid[0][lx])) {
        grid[0][lx] = CELL_TYPES.EMPTY;
      }
      if (SOLID_CELL_TYPES.has(grid[1][lx])) {
        grid[1][lx] = CELL_TYPES.EMPTY;
      }
    }
  }
  // South edge (lz = 7) shared with (cx, cz + 1)
  for (let lx = 0; lx < CHUNK_CELLS; lx += 1) {
    if (isBorderOpening(worldSeed, levelId, cx, cz, cx, cz + 1, lx)) {
      if (SOLID_CELL_TYPES.has(grid[CHUNK_CELLS - 1][lx])) {
        grid[CHUNK_CELLS - 1][lx] = CELL_TYPES.EMPTY;
      }
      if (SOLID_CELL_TYPES.has(grid[CHUNK_CELLS - 2][lx])) {
        grid[CHUNK_CELLS - 2][lx] = CELL_TYPES.EMPTY;
      }
    }
  }
  // West edge (lx = 0) shared with (cx - 1, cz)
  for (let lz = 0; lz < CHUNK_CELLS; lz += 1) {
    if (isBorderOpening(worldSeed, levelId, cx, cz, cx - 1, cz, lz)) {
      if (SOLID_CELL_TYPES.has(grid[lz][0])) {
        grid[lz][0] = CELL_TYPES.EMPTY;
      }
      if (SOLID_CELL_TYPES.has(grid[lz][1])) {
        grid[lz][1] = CELL_TYPES.EMPTY;
      }
    }
  }
  // East edge (lx = 7) shared with (cx + 1, cz)
  for (let lz = 0; lz < CHUNK_CELLS; lz += 1) {
    if (isBorderOpening(worldSeed, levelId, cx, cz, cx + 1, cz, lz)) {
      if (SOLID_CELL_TYPES.has(grid[lz][CHUNK_CELLS - 1])) {
        grid[lz][CHUNK_CELLS - 1] = CELL_TYPES.EMPTY;
      }
      if (SOLID_CELL_TYPES.has(grid[lz][CHUNK_CELLS - 2])) {
        grid[lz][CHUNK_CELLS - 2] = CELL_TYPES.EMPTY;
      }
    }
  }
}

function cellWorldRect(cx, cz, lx, lz, inset = 0) {
  const minX = (cx * CHUNK_CELLS + lx) * CELL_SIZE + inset;
  const maxX = (cx * CHUNK_CELLS + lx + 1) * CELL_SIZE - inset;
  const minZ = (cz * CHUNK_CELLS + lz) * CELL_SIZE + inset;
  const maxZ = (cz * CHUNK_CELLS + lz + 1) * CELL_SIZE - inset;
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
export function generateChunkData(levelId, cx, cz, worldSeed = 1999) {
  const levelData = getLevelData(levelId);
  const seedNum = Number(worldSeed) || 1999;
  const chunkHash = hashCoords(seedNum, levelId, cx, cz, 0);
  const rng = createMulberry32(chunkHash);
  const grid = makeEmptyGrid();
  const lights = [];
  const interactables = [];
  const props = [];

  if (levelId === "level_0") {
    // Non-Euclidean office partitions & irregular yellow rooms
    for (let lz = 0; lz < CHUNK_CELLS; lz += 1) {
      for (let lx = 0; lx < CHUNK_CELLS; lx += 1) {
        const r = rng();
        if (r < 0.27) {
          grid[lz][lx] = CELL_TYPES.WALL;
        } else if (r < 0.31) {
          grid[lz][lx] = CELL_TYPES.PILLAR;
        }
      }
    }
    // Carve cross-corridors so rooms remain interconnected
    carveCorridor(grid, 2, 0, 2, 7);
    carveCorridor(grid, 5, 0, 5, 7);
    carveCorridor(grid, 0, 2, 7, 2);
    carveCorridor(grid, 0, 5, 7, 5);
    applyCrossChunkSeams(grid, seedNum, levelId, cx, cz);

    if (cx === 0 && cz === 0) {
      // Clear 3x3 spawn area around (1.5, 1.5)
      for (let lz = 0; lz <= 2; lz += 1) {
        for (let lx = 0; lx <= 2; lx += 1) {
          grid[lz][lx] = CELL_TYPES.EMPTY;
        }
      }
      // Guarantee solid wall in chunk (0,0) for gameplay & collision testing
      grid[3][3] = CELL_TYPES.WALL;
      grid[1][5] = CELL_TYPES.GLITCH_WALL;
      grid[5][2] = CELL_TYPES.STAIRS;
      grid[6][6] = CELL_TYPES.OUTLET_WALL;

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

      const plaqueRect = cellWorldRect(cx, cz, 2, 0);
      props.push({
        kind: "PHOTO_PLAQUE",
        x: plaqueRect.centerX,
        z: plaqueRect.centerZ,
        label: "M.E.G. 記録写真: Level 0",
      });
    } else if (cx === 1 && cz === 0 || (chunkHash % 13 === 0 && !(cx === 0 && cz === 0))) {
      // Manila Room spatial anomaly pocket
      for (let lz = 3; lz <= 5; lz += 1) {
        for (let lx = 3; lx <= 5; lx += 1) {
          grid[lz][lx] = CELL_TYPES.MANILA_WALL;
        }
      }
      grid[4][4] = CELL_TYPES.EMPTY;
      grid[4][3] = CELL_TYPES.DOOR; // open doorway into pocket
      carveCorridor(grid, 0, 4, 3, 4);
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
      grid[3][4] = CELL_TYPES.GLITCH_WALL;
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
  } else if (levelId === "manila_room") {
    for (let lz = 0; lz < CHUNK_CELLS; lz += 1) {
      for (let lx = 0; lx < CHUNK_CELLS; lx += 1) {
        if ((lx === 0 || lz === 0 || lx === 7 || lz === 7) && rng() < 0.45) {
          grid[lz][lx] = CELL_TYPES.MANILA_WALL;
        } else if (rng() < 0.16) {
          grid[lz][lx] = CELL_TYPES.MANILA_WALL;
        }
      }
    }
    carveCorridor(grid, 2, 0, 2, 7);
    carveCorridor(grid, 0, 2, 7, 2);
    carveCorridor(grid, 5, 0, 5, 7);
    applyCrossChunkSeams(grid, seedNum, levelId, cx, cz);

    if (cx === 0 && cz === 0) {
      for (let lz = 0; lz <= 4; lz += 1) {
        for (let lx = 0; lx <= 4; lx += 1) {
          grid[lz][lx] = CELL_TYPES.EMPTY;
        }
      }
      grid[5][5] = CELL_TYPES.MANILA_WALL;
      grid[3][4] = CELL_TYPES.DOOR;
      grid[4][1] = CELL_TYPES.DOOR;
      const restRect = cellWorldRect(cx, cz, 4, 3);
      interactables.push({
        id: "manila_rest_anchor",
        type: "MANILA_REST",
        triggerType: "MANILA_REST",
        label: "マニラ室で休息して脱出 → Level 1 / 2 (Eキー)",
        x: restRect.centerX,
        z: restRect.centerZ,
        lx: 4,
        lz: 3,
        context: {},
      });
      const backRect = cellWorldRect(cx, cz, 1, 4);
      interactables.push({
        id: "manila_back_l0",
        type: "EXIT_DOOR",
        triggerType: "EXIT_DOOR",
        label: "黄色い廊下へ戻る → Level 0 (Eキー)",
        x: backRect.centerX,
        z: backRect.centerZ,
        lx: 1,
        lz: 4,
        context: { targetLevelId: "level_0" },
      });
    }
  } else if (levelId === "level_1") {
    // Open concrete parking lot bays with grid pillars, cars, and puddles
    for (let lz = 0; lz < CHUNK_CELLS; lz += 1) {
      for (let lx = 0; lx < CHUNK_CELLS; lx += 1) {
        if (lx % 3 === 1 && lz % 3 === 1) {
          grid[lz][lx] = CELL_TYPES.PILLAR;
        } else if (rng() < 0.08) {
          grid[lz][lx] = CELL_TYPES.WALL;
        } else if (rng() < 0.06) {
          grid[lz][lx] = CELL_TYPES.CAR;
        } else if (rng() < 0.14) {
          grid[lz][lx] = CELL_TYPES.PUDDLE;
        }
      }
    }
    carveCorridor(grid, 2, 0, 2, 7);
    carveCorridor(grid, 0, 2, 7, 2);
    carveCorridor(grid, 5, 0, 5, 7);
    applyCrossChunkSeams(grid, seedNum, levelId, cx, cz);

    if (cx === 0 && cz === 0) {
      for (let lz = 0; lz <= 2; lz += 1) {
        for (let lx = 0; lx <= 2; lx += 1) {
          grid[lz][lx] = CELL_TYPES.EMPTY;
        }
      }
      grid[1][3] = CELL_TYPES.CAR;
      grid[5][2] = CELL_TYPES.STAIRS;
      grid[2][5] = CELL_TYPES.STAIRS;
      grid[4][4] = CELL_TYPES.KEY_PEDESTAL;
      grid[4][6] = CELL_TYPES.OUTLET_WALL;
      grid[3][3] = CELL_TYPES.PUDDLE;

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
        label: "コンセント付き壁面 (Nキーでノークリップ)",
        x: outRect.centerX,
        z: outRect.centerZ,
        lx: 6,
        lz: 4,
        context: {},
      });
    } else if (cx === 1 && cz === 0) {
      // Canonical Hub Sequence Alcove: Door B -> Door A
      for (let lz = 2; lz <= 4; lz += 1) {
        for (let lx = 1; lx <= 6; lx += 1) {
          grid[lz][lx] = CELL_TYPES.EMPTY;
        }
      }
      grid[3][2] = CELL_TYPES.DOOR;
      grid[3][5] = CELL_TYPES.DOOR;
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
  } else if (levelId === "the_hub") {
    // Subterranean asphalt tunnel nexus with side walkways & level doors
    for (let lz = 0; lz < CHUNK_CELLS; lz += 1) {
      for (let lx = 0; lx < CHUNK_CELLS; lx += 1) {
        if (lz === 0 || lz === 7) {
          grid[lz][lx] = CELL_TYPES.WALL;
        } else if (lz === 1 || lz === 6) {
          grid[lz][lx] = rng() < 0.25 ? CELL_TYPES.PILLAR : CELL_TYPES.EMPTY;
        }
      }
    }
    // Cross intersection tunnels on even chunks
    if ((cx + cz) % 2 === 0) {
      carveCorridor(grid, 3, 0, 3, 7);
      carveCorridor(grid, 4, 0, 4, 7);
    }
    carveCorridor(grid, 0, 3, 7, 3);
    carveCorridor(grid, 0, 4, 7, 4);
    applyCrossChunkSeams(grid, seedNum, levelId, cx, cz);

    if (cx === 0 && cz === 0) {
      for (let lz = 0; lz <= 2; lz += 1) {
        for (let lx = 0; lx <= 2; lx += 1) {
          grid[lz][lx] = CELL_TYPES.EMPTY;
        }
      }
      grid[0][0] = CELL_TYPES.EMPTY;
      grid[2][2] = CELL_TYPES.KEY_PEDESTAL;
      grid[1][5] = CELL_TYPES.DOOR;
      grid[5][6] = CELL_TYPES.DOOR;
      grid[6][3] = CELL_TYPES.DOOR;

      const kRect = cellWorldRect(cx, cz, 2, 2);
      interactables.push({
        id: "hub_key_pedestal",
        type: "KEY_PICKUP",
        triggerType: "PICKUP_KEY",
        label: "Object 2: Level Key 保管棚から取得 (Eキー)",
        x: kRect.centerX,
        z: kRect.centerZ,
        lx: 2,
        lz: 2,
        context: {},
      });

      const d0 = cellWorldRect(cx, cz, 5, 1);
      interactables.push({
        id: "hub_door_level_0",
        type: "HUB_LEVEL_DOOR",
        triggerType: "HUB_DOOR",
        label: "金属扉 [Level 0: 黄色紋章] (Level Key必要 - Eキー)",
        x: d0.centerX,
        z: d0.centerZ,
        lx: 5,
        lz: 1,
        context: { targetLevelId: "level_0", doorTint: 0xe6c85c },
      });

      const d1 = cellWorldRect(cx, cz, 6, 5);
      interactables.push({
        id: "hub_door_level_1",
        type: "HUB_LEVEL_DOOR",
        triggerType: "HUB_DOOR",
        label: "金属扉 [Level 1: 灰色コンクリート] (Level Key必要 - Eキー)",
        x: d1.centerX,
        z: d1.centerZ,
        lx: 6,
        lz: 5,
        context: { targetLevelId: "level_1", doorTint: 0x8d959e },
      });

      const d2 = cellWorldRect(cx, cz, 3, 6);
      interactables.push({
        id: "hub_door_level_2",
        type: "HUB_LEVEL_DOOR",
        triggerType: "HUB_DOOR",
        label: "金属扉 [Level 2: 錆配管紋章] (Level Key必要 - Eキー)",
        x: d2.centerX,
        z: d2.centerZ,
        lx: 3,
        lz: 6,
        context: { targetLevelId: "level_2", doorTint: 0xb86434 },
      });
    } else if (cx === 0 && cz === 1) {
      grid[2][4] = CELL_TYPES.DOOR;
      const dm = cellWorldRect(cx, cz, 4, 2);
      interactables.push({
        id: "hub_door_manila",
        type: "HUB_LEVEL_DOOR",
        triggerType: "HUB_DOOR",
        label: "金属扉 [Manila Room] (Level Key必要 - Eキー)",
        x: dm.centerX,
        z: dm.centerZ,
        lx: 4,
        lz: 2,
        context: { targetLevelId: "manila_room", doorTint: 0xd4a259 },
      });
    }
  } else if (levelId === "level_2") {
    // Tight industrial maintenance tunnels lined with rusting pipes
    for (let lz = 0; lz < CHUNK_CELLS; lz += 1) {
      for (let lx = 0; lx < CHUNK_CELLS; lx += 1) {
        if (rng() < 0.44) {
          grid[lz][lx] = CELL_TYPES.WALL;
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
      grid[2][5] = CELL_TYPES.DOOR;
      grid[5][2] = CELL_TYPES.STAIRS;
      grid[6][6] = CELL_TYPES.DOOR;
      grid[1][4] = CELL_TYPES.GLITCH_WALL;

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

      const s0 = cellWorldRect(cx, cz, 2, 5);
      interactables.push({
        id: "l2_stairs_l0",
        type: "STAIRS",
        triggerType: "STAIRWELL",
        label: "保守ハッチ階段 → Level 0 (Eキー)",
        x: s0.centerX,
        z: s0.centerZ,
        lx: 2,
        lz: 5,
        context: { targetLevelId: "level_0" },
      });

      const fHub = cellWorldRect(cx, cz, 6, 6);
      interactables.push({
        id: "l2_exit_hub",
        type: "EXIT_DOOR",
        triggerType: "EXIT_DOOR",
        label: "連絡通路 → The Hub (Eキー)",
        x: fHub.centerX,
        z: fHub.centerZ,
        lx: 6,
        lz: 6,
        context: { targetLevelId: "the_hub" },
      });

      const gl = cellWorldRect(cx, cz, 4, 1);
      interactables.push({
        id: "l2_glitch_wall",
        type: "GLITCH_WALL",
        triggerType: "NOCLIP_WALL",
        label: "不安定配管壁 (Nキーでノークリップ)",
        x: gl.centerX,
        z: gl.centerZ,
        lx: 4,
        lz: 1,
        context: {},
      });
    }
  }

  // Extract wall AABBs, pipe props, and deterministic ceiling light placements
  const walls = [];
  for (let lz = 0; lz < CHUNK_CELLS; lz += 1) {
    for (let lx = 0; lx < CHUNK_CELLS; lx += 1) {
      const cellType = grid[lz][lx];
      if (SOLID_CELL_TYPES.has(cellType)) {
        const inset =
          cellType === CELL_TYPES.PILLAR
            ? 0.72
            : cellType === CELL_TYPES.CAR
            ? 0.38
            : 0;
        const rect = cellWorldRect(cx, cz, lx, lz, inset);
        walls.push({
          lx,
          lz,
          cellType,
          minX: rect.minX,
          maxX: rect.maxX,
          minZ: rect.minZ,
          maxZ: rect.maxZ,
          height:
            cellType === CELL_TYPES.CAR
              ? 1.45
              : levelData.environment.ceilingHeight,
        });
      } else if (cellType === CELL_TYPES.PUDDLE) {
        const rect = cellWorldRect(cx, cz, lx, lz, 0.2);
        props.push({
          kind: "PUDDLE",
          x: rect.centerX,
          z: rect.centerZ,
          radius: 1.1,
        });
      } else if (
        (levelId === "the_hub" || levelId === "level_2") &&
        (lx + lz) % 3 === 0
      ) {
        const rect = cellWorldRect(cx, cz, lx, lz);
        props.push({
          kind: "OVERHEAD_PIPE",
          x: rect.centerX,
          z: rect.centerZ,
          axis: lz % 2 === 0 ? "x" : "z",
        });
      }

      // Deterministic ceiling lights on sparse open cells
      if (
        !SOLID_CELL_TYPES.has(cellType) &&
        ((lx === 2 && lz === 2) ||
          (lx === 5 && lz === 5) ||
          (lx === 2 && lz === 6 && levelId === "the_hub"))
      ) {
        const rect = cellWorldRect(cx, cz, lx, lz);
        lights.push({
          x: rect.centerX,
          y: levelData.environment.ceilingHeight - 0.12,
          z: rect.centerZ,
          flickerPhase: ((lx * 7 + lz * 13 + Math.abs(cx + cz)) % 17) * 0.37,
        });
      }
    }
  }

  return {
    key: chunkKey(levelId, cx, cz),
    levelId,
    cx,
    cz,
    worldSeed: seedNum,
    chunkHash,
    grid,
    walls,
    lights,
    interactables,
    props,
  };
}

/**
 * Manages active chunks within loadRadius and evicts chunks beyond unloadRadius.
 */
export class ChunkManager {
  constructor({
    levelId = "level_0",
    worldSeed = 1999,
    loadRadius = 2,
    unloadRadius = 3,
    onChunkLoad = null,
    onChunkUnload = null,
  } = {}) {
    this.levelId = levelId;
    this.worldSeed = Number(worldSeed) || 1999;
    this.loadRadius = loadRadius;
    this.unloadRadius = Math.max(unloadRadius, loadRadius);
    this.onChunkLoad = onChunkLoad;
    this.onChunkUnload = onChunkUnload;
    this.chunks = new Map();
  }

  worldToChunk(x, z) {
    return {
      cx: Math.floor(x / CHUNK_WORLD_SIZE),
      cz: Math.floor(z / CHUNK_WORLD_SIZE),
    };
  }

  update(playerX, playerZ) {
    const { cx: pcx, cz: pcz } = this.worldToChunk(playerX, playerZ);
    const loadedKeys = [];
    const unloadedKeys = [];

    // Load chunks within Chebyshev distance <= loadRadius
    for (let dz = -this.loadRadius; dz <= this.loadRadius; dz += 1) {
      for (let dx = -this.loadRadius; dx <= this.loadRadius; dx += 1) {
        const cx = pcx + dx;
        const cz = pcz + dz;
        const key = chunkKey(this.levelId, cx, cz);
        if (!this.chunks.has(key)) {
          const chunkData = generateChunkData(this.levelId, cx, cz, this.worldSeed);
          this.chunks.set(key, chunkData);
          loadedKeys.push(key);
          if (typeof this.onChunkLoad === "function") {
            this.onChunkLoad(chunkData);
          }
        }
      }
    }

    // Evict chunks strictly beyond unloadRadius
    for (const [key, chunkData] of this.chunks.entries()) {
      const dist = Math.max(
        Math.abs(chunkData.cx - pcx),
        Math.abs(chunkData.cz - pcz)
      );
      if (dist > this.unloadRadius || chunkData.levelId !== this.levelId) {
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
   * Resolve circle-vs-AABB collision across the 3x3 chunk neighborhood.
   * Performs 2 separation passes for crisp corner sliding.
   */
  resolveCollision(x, z, radius = 0.42) {
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
            candidateWalls.push(w);
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
          if (!hitCellTypes.includes(wall.cellType)) {
            hitCellTypes.push(wall.cellType);
          }
          if (distSq > 1e-10) {
            const dist = Math.sqrt(distSq);
            const overlap = radius - dist;
            px += (dx / dist) * overlap;
            pz += (dz / dist) * overlap;
          } else {
            // Center strictly inside AABB: push toward shallowest edge
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
    this.levelId = newLevelId;
    this.worldSeed = Number(newWorldSeed) || 1999;
    return unloadedKeys;
  }
}

/**
 * Returns candidate URLs for loading the Wiki image from either root-served or
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
    // Vertical stripes + subtle Backrooms arrow/chevron motif
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
    // Damp water staining along baseboard
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
    // Cracks & floor stripe
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
    ctx.fillStyle = "rgba(220, 200, 120, 0.35)";
    ctx.fillRect(width * 0.48, 0, 8, height);
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
    ctx.fillStyle = "#2b2d30";
    ctx.fillRect(0, 0, width, height);
    ctx.fillStyle = "#d99f2b";
    ctx.fillRect(width * 0.48, 12, 8, 64);
    ctx.fillRect(width * 0.48, 140, 8, 64);
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
