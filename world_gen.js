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
  if (
    ((ax === 0 && az === 0) || (bx === 0 && bz === 0)) &&
    slot >= 0 &&
    slot <= 2
  ) {
    return true;
  }
  const swap = ax > bx || (ax === bx && az > bz);
  const c1x = swap ? bx : ax;
  const c1z = swap ? bz : az;
  const c2x = swap ? ax : bx;
  const c2z = swap ? az : bz;

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
export function generateChunkData(levelId, cx, cz, worldSeed = 1999) {
  const levelData = getLevelData(levelId);
  const seedNum = Number(worldSeed) || 1999;
  const chunkHash = hashCoords(seedNum, levelId, cx, cz, 0);
  const rng = createMulberry32(chunkHash);
  const grid = makeEmptyGrid();
  const wallStyles = makeWallStyleGrid();
  const lights = [];
  const interactables = [];
  const props = [];
  const zoneTag = `${String.fromCharCode(65 + Math.abs(cx * 3 + cz) % 6)}${Math.abs(cx + cz * 2) % 9 + 1}`;

  if (levelId === "level_0") {
    // Open retail hall layout with slim drywall partitions & arched colonnade dividers
    for (let lz = 0; lz < CHUNK_CELLS; lz += 1) {
      for (let lx = 0; lx < CHUNK_CELLS; lx += 1) {
        const r = rng();
        if (r < 0.14) {
          grid[lz][lx] = CELL_TYPES.WALL;
          wallStyles[lz][lx] = r < 0.065 ? "thin_x" : r < 0.12 ? "thin_z" : "solid";
        } else if (r < 0.175) {
          grid[lz][lx] = CELL_TYPES.PILLAR;
          wallStyles[lz][lx] = "l0_pillar";
        }
      }
    }

    // Arched colonnade divider strip matching File:Level 0 alt.png
    if ((cx + cz) % 2 === 0) {
      const archX = 4;
      for (let lz = 2; lz <= 4; lz += 1) {
        grid[lz][archX] = CELL_TYPES.WALL;
        wallStyles[lz][archX] = "arched_divider";
      }
    }

    carveCorridor(grid, 1, 0, 1, 7);
    carveCorridor(grid, 6, 0, 6, 7);
    carveCorridor(grid, 0, 1, 7, 1);
    carveCorridor(grid, 0, 6, 7, 6);
    applyCrossChunkSeams(grid, seedNum, levelId, cx, cz);

    if (cx === 0 && cz === 0) {
      for (let lz = 0; lz <= 2; lz += 1) {
        for (let lx = 0; lx <= 2; lx += 1) {
          grid[lz][lx] = CELL_TYPES.EMPTY;
        }
      }
      // Guarantee open sightlines for irregular spawn lights & colonnade vistas
      grid[2][5] = CELL_TYPES.EMPTY;
      grid[4][2] = CELL_TYPES.EMPTY;

      // Guarantee full solid wall at (3,3) for collision test & framing divider walls
      grid[3][3] = CELL_TYPES.WALL;
      wallStyles[3][3] = "solid";
      grid[2][4] = CELL_TYPES.WALL;
      wallStyles[2][4] = "arched_divider";
      grid[3][4] = CELL_TYPES.WALL;
      wallStyles[3][4] = "arched_divider";
      grid[4][1] = CELL_TYPES.WALL;
      wallStyles[4][1] = "thin_z";
      grid[1][5] = CELL_TYPES.GLITCH_WALL;
      wallStyles[1][5] = "solid";
      grid[5][2] = CELL_TYPES.STAIRS;
      grid[6][6] = CELL_TYPES.OUTLET_WALL;
      wallStyles[6][6] = "solid";

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
    } else if ((cx === 1 && cz === 0) || (chunkHash % 13 === 0 && !(cx === 0 && cz === 0))) {
      for (let lz = 3; lz <= 5; lz += 1) {
        for (let lx = 3; lx <= 5; lx += 1) {
          grid[lz][lx] = CELL_TYPES.MANILA_WALL;
          wallStyles[lz][lx] = "manila_wall";
        }
      }
      grid[4][4] = CELL_TYPES.EMPTY;
      grid[4][3] = CELL_TYPES.DOOR;
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
      wallStyles[3][4] = "solid";
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

    // Scattered knee-height electrical outlets facing into open space & carpet furniture indents
    for (let lz = 1; lz < CHUNK_CELLS - 1; lz += 1) {
      for (let lx = 1; lx < CHUNK_CELLS - 1; lx += 1) {
        const cell = grid[lz][lx];
        if (cell === CELL_TYPES.WALL && wallStyles[lz][lx] === "solid" && (lx + lz) % 3 === 0) {
          const r = cellWorldRect(cx, cz, lx, lz);
          if (!SOLID_CELL_TYPES.has(grid[lz - 1][lx])) {
            props.push({ kind: "WALL_OUTLET", x: r.centerX, z: r.minZ - 0.02, rotY: Math.PI });
          } else if (!SOLID_CELL_TYPES.has(grid[lz + 1][lx])) {
            props.push({ kind: "WALL_OUTLET", x: r.centerX, z: r.maxZ + 0.02, rotY: 0 });
          }
        } else if (!SOLID_CELL_TYPES.has(cell) && cell !== CELL_TYPES.STAIRS && cell !== CELL_TYPES.DOOR) {
          const r = cellWorldRect(cx, cz, lx, lz);
          const guaranteedIndent = cx === 0 && cz === 0 && ((lx === 1 && lz === 2) || (lx === 2 && lz === 1));
          if (guaranteedIndent || rng() < 0.12) {
            props.push({
              kind: "CARPET_INDENT",
              x: r.centerX + (rng() - 0.5) * 0.55,
              z: r.centerZ + (rng() - 0.5) * 0.55,
              w: 0.72 + rng() * 0.65,
              d: 0.62 + rng() * 0.65,
              rotY: rng() * Math.PI,
            });
          }
        }
      }
    }

    // Inconsistently placed fluorescent light fixtures (Level 0 Wiki: inconsistent lighting)
    const lightCandidates = [];
    for (let lz = 0; lz < CHUNK_CELLS; lz += 1) {
      for (let lx = 0; lx < CHUNK_CELLS; lx += 1) {
        if (!SOLID_CELL_TYPES.has(grid[lz][lx])) {
          lightCandidates.push([lx, lz]);
        }
      }
    }
    if (cx === 0 && cz === 0) {
      for (const [lx, lz, jx, jz, rotY] of [
        [1, 1, 0.18, -0.14, 0],
        [3, 1, -0.22, 0.2, Math.PI * 0.5],
        [5, 2, 0.15, -0.24, 0],
        [2, 4, -0.24, 0.16, 0.12],
      ]) {
        if (!SOLID_CELL_TYPES.has(grid[lz][lx])) {
          const r = cellWorldRect(cx, cz, lx, lz);
          lights.push({
            x: r.centerX + jx,
            y: levelData.environment.ceilingHeight - 0.04,
            z: r.centerZ + jz,
            rotY,
            flickerPhase: ((lx * 7 + lz * 13) % 17) * 0.37,
          });
        }
      }
    } else {
      const targetLights = 4 + (chunkHash % 3); // 4-6 lights irregularly scattered
      for (const [lx, lz] of lightCandidates) {
        if (lights.length >= targetLights) break;
        const p = hashCoords(seedNum, "l0_lt", cx * CHUNK_CELLS + lx, cz * CHUNK_CELLS + lz, 9) % 100;
        if (p < 14) {
          const r = cellWorldRect(cx, cz, lx, lz);
          lights.push({
            x: r.centerX + (rng() - 0.5) * 0.55,
            y: levelData.environment.ceilingHeight - 0.04,
            z: r.centerZ + (rng() - 0.5) * 0.55,
            rotY: rng() < 0.35 ? Math.PI * 0.5 : 0,
            flickerPhase: ((lx * 7 + lz * 13 + Math.abs(cx + cz)) % 17) * 0.37,
          });
        }
      }
      if (lights.length < 3) {
        for (const [lx, lz] of lightCandidates.slice(0, 3 - lights.length)) {
          const r = cellWorldRect(cx, cz, lx, lz);
          lights.push({
            x: r.centerX,
            y: levelData.environment.ceilingHeight - 0.04,
            z: r.centerZ,
            rotY: rng() < 0.35 ? Math.PI * 0.5 : 0,
            flickerPhase: ((lx + lz) % 11) * 0.4,
          });
        }
      }
    }
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

    // Emit concrete-floor Hydrolitis & False Puddle meshes, scattered rebar, and sub-area doors
    for (let lz = 0; lz < CHUNK_CELLS; lz += 1) {
      for (let lx = 0; lx < CHUNK_CELLS; lx += 1) {
        const cell = grid[lz][lx];
        if (cell === CELL_TYPES.PUDDLE) {
          const r = cellWorldRect(cx, cz, lx, lz);
          const isOriginNormal = cx === 0 && cz === 0 && ((lx === 3 && lz === 2) || (lx === 2 && lz === 4));
          const isOriginFalse = cx === 0 && cz === 0 && lx === 3 && lz === 3;
          const isFalsePuddle = isOriginFalse ? true : isOriginNormal ? false : rng() < 0.24;
          props.push({
            kind: "PUDDLE",
            x: r.centerX,
            z: r.centerZ,
            radius: 1.05 + rng() * 0.7,
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

    // Add chamfered concrete shaft ribs, multi-tier side pipes, and overhead pipes along corridors
    for (let lz = 0; lz < CHUNK_CELLS; lz += 1) {
      for (let lx = 0; lx < CHUNK_CELLS; lx += 1) {
        if (SOLID_CELL_TYPES.has(grid[lz][lx])) continue;
        const r = cellWorldRect(cx, cz, lx, lz);
        const axis = lx === 1 || lx === 5 ? "z" : "x";
        if ((lx + lz) % 2 === 0) {
          props.push({ kind: "CHAMFER_RIB", x: r.centerX, z: r.centerZ, axis });
        }
        if (lx === 1 || lx === 5 || lz === 1 || lz === 5) {
          props.push({ kind: "OVERHEAD_PIPE", x: r.centerX + (axis === "z" ? 0.55 : 0), z: r.centerZ + (axis === "x" ? 0.55 : 0), y: 2.46, length: CELL_SIZE, axis });
        }
        const leftSolid = lx > 0 && SOLID_CELL_TYPES.has(grid[lz][lx - 1]);
        const rightSolid = lx < CHUNK_CELLS - 1 && SOLID_CELL_TYPES.has(grid[lz][lx + 1]);
        const northSolid = lz > 0 && SOLID_CELL_TYPES.has(grid[lz - 1][lx]);
        const southSolid = lz < CHUNK_CELLS - 1 && SOLID_CELL_TYPES.has(grid[lz + 1][lx]);
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

  // Extract wall AABBs (respecting thin partitions, pillars, and full solid cells)
  const walls = [];
  for (let lz = 0; lz < CHUNK_CELLS; lz += 1) {
    for (let lx = 0; lx < CHUNK_CELLS; lx += 1) {
      const cellType = grid[lz][lx];
      if (!SOLID_CELL_TYPES.has(cellType)) continue;

      const style = wallStyles[lz][lx] || "solid";
      let rect;
      if (cellType === CELL_TYPES.PILLAR || style === "parking_pillar" || style === "l0_pillar") {
        const inset = style === "parking_pillar" ? 0.92 : 1.02;
        rect = cellWorldRect(cx, cz, lx, lz, inset, inset);
      } else if (cellType === CELL_TYPES.CAR) {
        rect = cellWorldRect(cx, cz, lx, lz, 0.38, 0.38);
      } else if (style === "thin_x" || style === "arched_divider") {
        rect = cellWorldRect(cx, cz, lx, lz, 0, 1.31); // 0.38m thick along Z
      } else if (style === "thin_z") {
        rect = cellWorldRect(cx, cz, lx, lz, 1.31, 0); // 0.38m thick along X
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
