/**
 * Presentation, Three.js WebGL renderer, input controller, dual texture loader,
 * atmospheric effects (Level 1 blackouts, Hub light hue-shift, Smiler eyes),
 * and HUD binding.
 *
 * Intentionally separated from pure domain modules:
 *   - ./lore_data.js
 *   - ./world_gen.js
 *   - ./transition_rules.js
 *   - ./audio_synth.js
 *
 * Source: The Backrooms Wiki (Fandom) — https://backrooms.fandom.com/wiki/Backrooms_Wiki
 * License: CC-BY-SA-3.0 — https://creativecommons.org/licenses/by-sa/3.0/
 */

import * as THREE from "three";
import { LEVELS, LICENSE_INFO, getLevelData, getAttributionText } from "./lore_data.js";
import {
  CELL_SIZE,
  CELL_TYPES,
  CHUNK_WORLD_SIZE,
  ChunkManager,
  createProceduralTextureCanvas,
  hashStringToSeed,
  resolveTextureCandidates,
} from "./world_gen.js";
import { TRIGGER_TYPES, evaluateTransition } from "./transition_rules.js";
import { BackroomsAudio } from "./audio_synth.js";

const PLAYER_EYE_HEIGHT = 1.68;
const PLAYER_RADIUS = 0.42;
const WALK_SPEED = 5.2;
const SPRINT_SPEED = 8.0;

// ---------------------------------------------------------------------------
// DOM References
// ---------------------------------------------------------------------------
const ui = {
  viewport: document.getElementById("viewport"),
  overlay: document.getElementById("start-overlay"),
  btnEnter: document.getElementById("btn-enter"),
  btnWikiModal: document.getElementById("btn-wiki-modal"),
  btnCloseModal: document.getElementById("btn-close-modal"),
  wikiModal: document.getElementById("wiki-modal"),
  wikiModalBody: document.getElementById("wiki-modal-body"),
  seedInput: document.getElementById("seed-input"),
  levelSelect: document.getElementById("level-select"),
  hud: document.getElementById("hud"),
  hudBadge: document.getElementById("hud-class-badge"),
  hudLevelName: document.getElementById("hud-level-name"),
  hudLevelSub: document.getElementById("hud-level-sub"),
  hudClassLabel: document.getElementById("hud-class-label"),
  hudCoords: document.getElementById("hud-coords"),
  hudChunk: document.getElementById("hud-chunk"),
  hudActiveChunks: document.getElementById("hud-active-chunks"),
  hudSeed: document.getElementById("hud-seed"),
  hudTexStatus: document.getElementById("hud-tex-status"),
  hudKeyStatus: document.getElementById("hud-key-status"),
  hudFlashlight: document.getElementById("hud-flashlight"),
  hudMmoMode: document.getElementById("hud-mmo-mode"),
  hudPrompt: document.getElementById("hud-prompt"),
  hudLogs: document.getElementById("hud-logs"),
  hudAttribution: document.getElementById("hud-attribution"),
  glitchFlash: document.getElementById("glitch-flash"),
  blackoutBanner: document.getElementById("blackout-banner"),
  compassNeedle: document.getElementById("compass-needle"),
};

// ---------------------------------------------------------------------------
// Dual Texture Loader (Wiki Image + Canvas Procedural Fallback)
// ---------------------------------------------------------------------------
class LevelMaterialCache {
  constructor(onStatusChange) {
    this.loader = new THREE.TextureLoader();
    this.cache = new Map();
    this.onStatusChange = onStatusChange;
  }

  getMaterials(levelId) {
    if (this.cache.has(levelId)) {
      return this.cache.get(levelId);
    }

    const levelData = getLevelData(levelId);
    const seed = hashStringToSeed(levelId);
    const slots = ["wall", "floor", "ceiling", "door", "accent"];
    const materials = {};
    const status = { total: slots.length, wikiLoaded: 0, proceduralFallback: slots.length };
    const maxAniso = Math.min(8, renderer?.capabilities?.getMaxAnisotropy?.() || 4);
    const pendingLoads = [];

    for (const slot of slots) {
      const spec = levelData.textures[slot];
      const canvas = createProceduralTextureCanvas(
        spec?.proceduralStyle || "level0_wallpaper",
        256,
        256,
        seed + slot.length * 97
      );
      const isSinglePanel =
        slot === "accent" || (slot === "door" && levelId !== "level_0");
      const procTex = new THREE.CanvasTexture(canvas);
      procTex.wrapS = isSinglePanel ? THREE.ClampToEdgeWrapping : THREE.RepeatWrapping;
      procTex.wrapT = isSinglePanel ? THREE.ClampToEdgeWrapping : THREE.RepeatWrapping;
      procTex.anisotropy = maxAniso;
      procTex.colorSpace = THREE.SRGBColorSpace;
      if (slot === "floor" || slot === "ceiling") {
        procTex.repeat.set(8, 8);
      }

      const mat = new THREE.MeshStandardMaterial({
        map: procTex,
        roughness: slot === "floor" ? 0.85 : slot === "door" ? 0.45 : 0.78,
        metalness: slot === "door" ? 0.55 : 0.06,
      });
      materials[slot] = mat;
      pendingLoads.push({
        slot,
        mat,
        procTex,
        isSinglePanel,
        candidates: resolveTextureCandidates(levelId, slot),
      });
    }

    const ceilingEmissiveMat = new THREE.MeshBasicMaterial({
      color: new THREE.Color(levelData.environment.lightColor),
    });
    const glitchMat = new THREE.MeshStandardMaterial({
      map: materials.wall.map,
      color: 0xffe49e,
      emissive: 0x33270e,
      emissiveIntensity: 0.45,
      transparent: true,
      opacity: 0.88,
      roughness: 0.5,
    });

    for (const item of pendingLoads) {
      this._tryLoadCandidates(
        item.candidates,
        item.slot,
        item.mat,
        item.procTex,
        status,
        {
          isSinglePanel: item.isSinglePanel,
          anisotropy: maxAniso,
          onUpgrade: item.slot === "wall" ? (tex) => {
            glitchMat.map = tex;
            glitchMat.needsUpdate = true;
          } : null,
        }
      );
    }
    const puddleMat = new THREE.MeshStandardMaterial({
      color: 0x1c2b33,
      roughness: 0.08,
      metalness: 0.78,
      transparent: true,
      opacity: 0.85,
    });
    const pipeMat = new THREE.MeshStandardMaterial({
      color: levelId === "the_hub" ? 0x8b9098 : 0x6b3b24,
      roughness: 0.48,
      metalness: 0.65,
    });
    const stairsMat = new THREE.MeshStandardMaterial({
      color: 0x5c6066,
      roughness: 0.8,
      metalness: 0.15,
    });

    if (!this.shared) {
      const hubConcCanvas = createProceduralTextureCanvas("level1_concrete", 256, 256, 777);
      const hubConcFallback = new THREE.CanvasTexture(hubConcCanvas);
      hubConcFallback.wrapS = THREE.RepeatWrapping;
      hubConcFallback.wrapT = THREE.RepeatWrapping;
      hubConcFallback.repeat.set(4, 2);
      hubConcFallback.colorSpace = THREE.SRGBColorSpace;
      const hubConcreteMat = new THREE.MeshStandardMaterial({
        map: hubConcFallback,
        color: 0xccb896,
        roughness: 0.84,
        metalness: 0.05,
        side: THREE.BackSide,
      });
      this._tryLoadCandidates(
        ["./assets/textures/tex_l1_concrete_wall.jpg", "../dataset/images/Level_1__e8e28d1950.jpg"],
        "hub_concrete",
        hubConcreteMat,
        hubConcFallback,
        { total: 1, wikiLoaded: 0, proceduralFallback: 1 },
        { isSinglePanel: false, anisotropy: maxAniso }
      );

      this.shared = {
        hubConcreteMat,
        baseboardMat: new THREE.MeshStandardMaterial({ color: 0x6e6032, roughness: 0.75 }),
        outletMat: new THREE.MeshStandardMaterial({ color: 0xded6b5, roughness: 0.6 }),
        crownTrimMat: new THREE.MeshStandardMaterial({ color: 0x9c6e46, roughness: 0.65 }),
        woodMat: new THREE.MeshStandardMaterial({ color: 0x5c3d24, roughness: 0.8 }),
        pillarBandMat: new THREE.MeshStandardMaterial({ color: 0x6e2c36, roughness: 0.7 }),
        hazardYellowMat: new THREE.MeshStandardMaterial({ color: 0xd9a520, roughness: 0.6 }),
        barrierOrangeMat: new THREE.MeshStandardMaterial({ color: 0xd95826, roughness: 0.65 }),
        roadLineMat: new THREE.MeshBasicMaterial({ color: 0xe6e3d8 }),
        sidewalkMat: new THREE.MeshStandardMaterial({ color: 0x8d8a82, roughness: 0.85 }),
        curbRedGlowMat: new THREE.MeshBasicMaterial({ color: 0xff3b2f }),
        gantryMat: new THREE.MeshStandardMaterial({ color: 0x17181c, roughness: 0.55, metalness: 0.6 }),
        redSignGlowMat: new THREE.MeshBasicMaterial({ color: 0xff2e2e }),
        blueSignGlowMat: new THREE.MeshBasicMaterial({ color: 0x2ea3ff }),
        greenExitMat: new THREE.MeshBasicMaterial({ color: 0x22d665 }),
        fanBodyMat: new THREE.MeshStandardMaterial({ color: 0x32363d, roughness: 0.45, metalness: 0.7 }),
        rustPipeMat: new THREE.MeshStandardMaterial({ color: 0x6b3922, roughness: 0.6, metalness: 0.5 }),
        darkPipeMat: new THREE.MeshStandardMaterial({ color: 0x3c4147, roughness: 0.45, metalness: 0.65 }),
        valveRedMat: new THREE.MeshStandardMaterial({ color: 0xb82924, roughness: 0.5 }),
        tireMat: new THREE.MeshStandardMaterial({ color: 0x16171a, roughness: 0.9 }),
        windshieldMat: new THREE.MeshStandardMaterial({ color: 0x1f2b36, roughness: 0.2, metalness: 0.7 }),
        carColors: [
          new THREE.MeshStandardMaterial({ color: 0x7a2626, roughness: 0.45, metalness: 0.4 }),
          new THREE.MeshStandardMaterial({ color: 0x243e63, roughness: 0.45, metalness: 0.4 }),
          new THREE.MeshStandardMaterial({ color: 0xd1d4d9, roughness: 0.45, metalness: 0.3 }),
        ],
        tintMatCache: new Map(),
      };
    }

    const entry = {
      ...materials,
      ceilingEmissiveMat,
      glitchMat,
      puddleMat,
      pipeMat,
      stairsMat,
      shared: this.shared,
      status,
    };
    this.cache.set(levelId, entry);
    return entry;
  }

  _tryLoadCandidates(candidates, slot, mat, fallbackTex, status, opts = {}) {
    if (!candidates || candidates.length === 0) return;

    const tryNext = (idx) => {
      if (idx >= candidates.length) return;
      const url = candidates[idx];
      this.loader.load(
        url,
        (tex) => {
          tex.wrapS = opts.isSinglePanel ? THREE.ClampToEdgeWrapping : THREE.RepeatWrapping;
          tex.wrapT = opts.isSinglePanel ? THREE.ClampToEdgeWrapping : THREE.RepeatWrapping;
          tex.anisotropy = opts.anisotropy || 4;
          tex.colorSpace = THREE.SRGBColorSpace;
          if (slot === "floor" || slot === "ceiling") {
            tex.repeat.set(8, 8);
          }
          mat.map = tex;
          mat.needsUpdate = true;
          if (typeof opts.onUpgrade === "function") {
            opts.onUpgrade(tex);
          }
          fallbackTex.dispose();
          status.wikiLoaded += 1;
          status.proceduralFallback = Math.max(0, status.total - status.wikiLoaded);
          if (typeof this.onStatusChange === "function") {
            this.onStatusChange(status);
          }
        },
        undefined,
        () => {
          tryNext(idx + 1);
        }
      );
    };

    tryNext(0);
  }
}

// ---------------------------------------------------------------------------
// Three.js Scene & Renderer Setup
// ---------------------------------------------------------------------------
const renderer = new THREE.WebGLRenderer({ antialias: true, powerPreference: "high-performance" });
renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, 2));
renderer.setSize(window.innerWidth, window.innerHeight);
renderer.outputColorSpace = THREE.SRGBColorSpace;
renderer.toneMapping = THREE.ACESFilmicToneMapping;
renderer.toneMappingExposure = 1.05;
ui.viewport.appendChild(renderer.domElement);

const scene = new THREE.Scene();
const camera = new THREE.PerspectiveCamera(
  74,
  window.innerWidth / window.innerHeight,
  0.08,
  95
);
scene.add(camera);

const ambientLight = new THREE.AmbientLight(0xfff0b5, 0.42);
scene.add(ambientLight);

const hemiLight = new THREE.HemisphereLight(0xfff2cc, 0x3b321b, 0.28);
scene.add(hemiLight);

// Player flashlight attached to camera
const flashlight = new THREE.SpotLight(0xfff4d6, 3.6, 26, Math.PI * 0.24, 0.45, 1.4);
flashlight.position.set(0.14, -0.1, 0);
const flashlightTarget = new THREE.Object3D();
flashlightTarget.position.set(0, -0.12, -8);
camera.add(flashlight);
camera.add(flashlightTarget);
flashlight.target = flashlightTarget;
flashlight.visible = false;

// Distant Smiler eyes (visible only during Level 1 blackout when flashlight is off)
const smilerGroup = new THREE.Group();
const smilerEyeMat = new THREE.MeshBasicMaterial({ color: 0xffffff });
const smilerLeftEye = new THREE.Mesh(new THREE.SphereGeometry(0.055, 8, 8), smilerEyeMat);
const smilerRightEye = new THREE.Mesh(new THREE.SphereGeometry(0.055, 8, 8), smilerEyeMat);
smilerLeftEye.position.set(-0.14, 0.12, 0);
smilerRightEye.position.set(0.14, 0.12, 0);
smilerGroup.add(smilerLeftEye, smilerRightEye);
for (let i = -3; i <= 3; i += 1) {
  const tooth = new THREE.Mesh(new THREE.SphereGeometry(0.032, 6, 6), smilerEyeMat);
  tooth.position.set(i * 0.065, -0.06 + Math.abs(i) * 0.014, 0);
  smilerGroup.add(tooth);
}
smilerGroup.visible = false;
scene.add(smilerGroup);

// ---------------------------------------------------------------------------
// Game State
// ---------------------------------------------------------------------------
const audio = new BackroomsAudio();
const chunkMeshes = new Map();
const chunkPointLights = [];
let keyPickupMeshes = [];
let ventFanRotors = [];

const state = {
  started: false,
  pointerLocked: false,
  currentLevelId: "level_0",
  worldSeedStr: "1999",
  worldSeed: hashStringToSeed("1999"),
  player: {
    x: 1.5,
    y: PLAYER_EYE_HEIGHT,
    z: 1.5,
    yaw: -Math.PI * 0.25,
    pitch: 0,
    bobPhase: 0,
    stepAccum: 0,
  },
  flashlightOn: false,
  hasLevelKey: false,
  hubSequenceStep: "none", // "none" -> "door_a_after_b"
  blackoutActive: false,
  blackoutTimer: 0,
  hudVisible: true,
  lastGlitchPrompt: false,
  logs: [],
  keysPressed: new Set(),
};

const materialCache = new LevelMaterialCache(() => {
  updateTextureStatusHud();
});

function addLog(msg) {
  const timeStr = new Date().toISOString().slice(11, 19);
  state.logs.unshift(`[${timeStr}] ${msg}`);
  if (state.logs.length > 9) {
    state.logs.length = 9;
  }
  ui.hudLogs.innerHTML = state.logs
    .map((line, i) => `<div class="log-line ${i === 0 ? "latest" : ""}">${escapeHtml(line)}</div>`)
    .join("");
}

function escapeHtml(str) {
  return String(str)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;");
}

// ---------------------------------------------------------------------------
// Chunk Mesh Builder & Strict Disposal
// ---------------------------------------------------------------------------
function disposeChunkGroup(group) {
  group.traverse((obj) => {
    if (obj.isMesh && obj.geometry) {
      obj.geometry.dispose();
    }
    if (obj.isPointLight) {
      const idx = chunkPointLights.indexOf(obj);
      if (idx !== -1) chunkPointLights.splice(idx, 1);
    }
    if (obj.userData && obj.userData.isVentRotor) {
      const rIdx = ventFanRotors.indexOf(obj);
      if (rIdx !== -1) ventFanRotors.splice(rIdx, 1);
    }
  });
  scene.remove(group);
}

function getSharedTintMat(shared, hexColor) {
  if (!shared.tintMatCache.has(hexColor)) {
    shared.tintMatCache.set(hexColor, new THREE.MeshBasicMaterial({ color: hexColor }));
  }
  return shared.tintMatCache.get(hexColor);
}

function buildChunkGroup(chunkData) {
  const levelData = getLevelData(chunkData.levelId);
  const mats = materialCache.getMaterials(chunkData.levelId);
  const s = mats.shared;
  const group = new THREE.Group();
  group.name = chunkData.key;

  const h = levelData.environment.ceilingHeight;
  const originX = chunkData.cx * CHUNK_WORLD_SIZE;
  const originZ = chunkData.cz * CHUNK_WORLD_SIZE;
  const centerX = originX + CHUNK_WORLD_SIZE * 0.5;
  const centerZ = originZ + CHUNK_WORLD_SIZE * 0.5;
  const hasHubArch =
    chunkData.levelId === "the_hub" &&
    chunkData.props.some((p) => p.kind === "TUNNEL_ARCH");

  // Floor (always present) and Ceiling (omitted inside vaulted Hub tunnels)
  const floorGeo = new THREE.PlaneGeometry(CHUNK_WORLD_SIZE, CHUNK_WORLD_SIZE);
  const floorMesh = new THREE.Mesh(floorGeo, mats.floor);
  floorMesh.rotation.x = -Math.PI / 2;
  floorMesh.position.set(centerX, 0, centerZ);
  group.add(floorMesh);

  if (!hasHubArch) {
    const ceilGeo = new THREE.PlaneGeometry(CHUNK_WORLD_SIZE, CHUNK_WORLD_SIZE);
    const ceilMesh = new THREE.Mesh(ceilGeo, mats.ceiling);
    ceilMesh.rotation.x = Math.PI / 2;
    ceilMesh.position.set(centerX, h, centerZ);
    group.add(ceilMesh);
  }

  // Walls, Partitions, Arched Dividers, Parking Pillars, Cars
  for (const w of chunkData.walls) {
    const width = w.maxX - w.minX;
    const depth = w.maxZ - w.minZ;
    const cx = (w.minX + w.maxX) * 0.5;
    const cz = (w.minZ + w.maxZ) * 0.5;

    if (w.cellType === CELL_TYPES.CAR) {
      const bodyMat = s.carColors[(w.lx + w.lz) % s.carColors.length];
      const body = new THREE.Mesh(new THREE.BoxGeometry(width, 0.58, depth * 0.85), bodyMat);
      body.position.set(cx, 0.46, cz);
      group.add(body);

      const cabin = new THREE.Mesh(new THREE.BoxGeometry(width * 0.58, 0.48, depth * 0.72), bodyMat);
      cabin.position.set(cx - 0.1, 0.98, cz);
      group.add(cabin);

      const glass = new THREE.Mesh(new THREE.BoxGeometry(width * 0.6, 0.36, depth * 0.64), s.windshieldMat);
      glass.position.set(cx - 0.1, 0.98, cz);
      group.add(glass);

      for (const [wx, wz] of [
        [-width * 0.32, -depth * 0.42],
        [width * 0.32, -depth * 0.42],
        [-width * 0.32, depth * 0.42],
        [width * 0.32, depth * 0.42],
      ]) {
        const wheel = new THREE.Mesh(new THREE.CylinderGeometry(0.24, 0.24, 0.18, 10), s.tireMat);
        wheel.rotation.x = Math.PI / 2;
        wheel.position.set(cx + wx, 0.24, cz + wz);
        group.add(wheel);
      }
      continue;
    }

    if (w.wallStyle === "arched_divider") {
      // Half knee-wall + upper lintel beam + vertical posts matching File:Level 0 alt.png
      const knee = new THREE.Mesh(new THREE.BoxGeometry(width, 1.05, depth), mats.wall);
      knee.position.set(cx, 0.525, cz);
      group.add(knee);

      const topBeam = new THREE.Mesh(new THREE.BoxGeometry(width, 0.65, depth), mats.wall);
      topBeam.position.set(cx, w.height - 0.325, cz);
      group.add(topBeam);

      for (const offset of [-width * 0.42, width * 0.42]) {
        const post = new THREE.Mesh(new THREE.BoxGeometry(0.32, w.height, depth + 0.04), mats.wall);
        post.position.set(cx + offset, w.height * 0.5, cz);
        group.add(post);
      }
      const trim = new THREE.Mesh(new THREE.BoxGeometry(width, 0.12, depth + 0.03), s.baseboardMat);
      trim.position.set(cx, 0.06, cz);
      group.add(trim);
      continue;
    }

    if (w.wallStyle === "parking_pillar") {
      // Concrete parking column + drop-capital slab + burgundy band + yellow corner strips (File:SolusLevel1.jpg)
      const col = new THREE.Mesh(new THREE.BoxGeometry(width, w.height, depth), mats.wall);
      col.position.set(cx, w.height * 0.5, cz);
      group.add(col);

      const cap = new THREE.Mesh(new THREE.BoxGeometry(width + 0.9, 0.32, depth + 0.9), mats.ceiling);
      cap.position.set(cx, w.height - 0.16, cz);
      group.add(cap);

      const band = new THREE.Mesh(new THREE.BoxGeometry(width + 0.03, 0.42, depth + 0.03), s.pillarBandMat);
      band.position.set(cx, w.height - 0.62, cz);
      group.add(band);

      const hazard = new THREE.Mesh(new THREE.BoxGeometry(width + 0.04, 0.9, depth + 0.04), s.hazardYellowMat);
      hazard.position.set(cx, 0.45, cz);
      group.add(hazard);

      if ((w.lx + w.lz) % 2 === 0) {
        const lightStrip = new THREE.Mesh(new THREE.BoxGeometry(0.14, 1.4, 0.08), mats.ceilingEmissiveMat);
        lightStrip.position.set(cx, 2.7, w.minZ - 0.05);
        group.add(lightStrip);
      }
      continue;
    }

    const mat =
      w.cellType === CELL_TYPES.GLITCH_WALL
        ? mats.glitchMat
        : w.cellType === CELL_TYPES.MANILA_WALL
        ? mats.wall
        : mats.wall;

    const wallGeo = new THREE.BoxGeometry(width, w.height, depth);
    const mesh = new THREE.Mesh(wallGeo, mat);
    mesh.position.set(cx, w.height * 0.5, cz);
    group.add(mesh);

    if (chunkData.levelId === "level_0" && (w.wallStyle === "thin_x" || w.wallStyle === "thin_z" || w.wallStyle === "solid")) {
      const trim = new THREE.Mesh(new THREE.BoxGeometry(width + 0.02, 0.12, depth + 0.02), s.baseboardMat);
      trim.position.set(cx, 0.06, cz);
      group.add(trim);
    }

    if (w.wallStyle === "manila_wall") {
      const crown = new THREE.Mesh(new THREE.BoxGeometry(width + 0.03, 0.14, depth + 0.03), s.crownTrimMat);
      crown.position.set(cx, w.height - 0.07, cz);
      group.add(crown);
    }

    if (w.cellType === CELL_TYPES.GLITCH_WALL) {
      const wireGeo = new THREE.BoxGeometry(width + 0.04, w.height + 0.04, depth + 0.04);
      const edges = new THREE.EdgesGeometry(wireGeo);
      wireGeo.dispose();
      const line = new THREE.LineSegments(
        edges,
        new THREE.LineBasicMaterial({ color: 0xffd166 })
      );
      line.position.copy(mesh.position);
      group.add(line);
    }

    if (w.cellType === CELL_TYPES.OUTLET_WALL) {
      const plate = new THREE.Mesh(new THREE.BoxGeometry(0.32, 0.44, width + 0.06), s.outletMat);
      plate.position.set(cx, 0.65, cz);
      group.add(plate);
    }
  }

  // Props (Level-specific architectural silhouettes & details)
  for (const prop of chunkData.props) {
    if (prop.kind === "PUDDLE") {
      const pMesh = new THREE.Mesh(new THREE.CircleGeometry(prop.radius, 18), mats.puddleMat);
      pMesh.rotation.x = -Math.PI / 2;
      pMesh.position.set(prop.x, 0.015, prop.z);
      group.add(pMesh);
    } else if (prop.kind === "OVERHEAD_PIPE") {
      const pipeMesh = new THREE.Mesh(new THREE.CylinderGeometry(0.14, 0.14, CELL_SIZE, 10), mats.pipeMat);
      pipeMesh.position.set(prop.x, h - 0.32, prop.z);
      if (prop.axis === "x") pipeMesh.rotation.z = Math.PI / 2;
      else pipeMesh.rotation.x = Math.PI / 2;
      group.add(pipeMesh);
    } else if (prop.kind === "PHOTO_PLAQUE") {
      const stand = new THREE.Mesh(new THREE.BoxGeometry(0.12, 1.5, 0.12), s.gantryMat);
      stand.position.set(prop.x, 0.75, prop.z);
      group.add(stand);
      const frame = new THREE.Mesh(new THREE.BoxGeometry(1.45, 1.08, 0.08), mats.accent);
      frame.position.set(prop.x, 1.65, prop.z);
      group.add(frame);
    } else if (prop.kind === "WALL_OUTLET") {
      const outlet = new THREE.Mesh(new THREE.BoxGeometry(0.16, 0.24, 0.06), s.outletMat);
      outlet.position.set(prop.x, 0.46, prop.z);
      outlet.rotation.y = prop.rotY || 0;
      group.add(outlet);
    } else if (prop.kind === "REST_TABLE") {
      const top = new THREE.Mesh(new THREE.BoxGeometry(1.4, 0.08, 0.85), s.woodMat);
      top.position.set(prop.x, 0.76, prop.z);
      group.add(top);
      for (const [lx, lz] of [[-0.6, -0.34], [0.6, -0.34], [-0.6, 0.34], [0.6, 0.34]]) {
        const leg = new THREE.Mesh(new THREE.BoxGeometry(0.08, 0.74, 0.08), s.woodMat);
        leg.position.set(prop.x + lx, 0.37, prop.z + lz);
        group.add(leg);
      }
      const lantern = new THREE.Mesh(new THREE.CylinderGeometry(0.11, 0.14, 0.28, 10), mats.ceilingEmissiveMat);
      lantern.position.set(prop.x, 0.94, prop.z);
      group.add(lantern);
    } else if (prop.kind === "WHEEL_STOP") {
      const stop = new THREE.Mesh(new THREE.BoxGeometry(1.7, 0.15, 0.24), s.hazardYellowMat);
      stop.position.set(prop.x, 0.075, prop.z);
      stop.rotation.y = prop.rotY || 0;
      group.add(stop);
    } else if (prop.kind === "FLOOR_ARROW") {
      const shaft = new THREE.Mesh(new THREE.PlaneGeometry(0.28, 1.5), s.hazardYellowMat);
      shaft.rotation.x = -Math.PI / 2;
      shaft.position.set(prop.x, 0.012, prop.z);
      group.add(shaft);
      const head = new THREE.Mesh(new THREE.ConeGeometry(0.38, 0.55, 3), s.hazardYellowMat);
      head.rotation.x = -Math.PI / 2;
      head.position.set(prop.x, 0.015, prop.z - 0.85);
      group.add(head);
    } else if (prop.kind === "TRAFFIC_BARRIER") {
      const bar = new THREE.Mesh(new THREE.BoxGeometry(1.4, 0.82, 0.45), s.barrierOrangeMat);
      bar.position.set(prop.x, 0.41, prop.z);
      group.add(bar);
    } else if (prop.kind === "PARKING_RAMP") {
      const ramp = new THREE.Mesh(new THREE.BoxGeometry(4.2, 0.28, 7.6), mats.wall);
      ramp.position.set(prop.x, 1.35, prop.z);
      ramp.rotation.x = -0.32;
      group.add(ramp);
      const rail = new THREE.Mesh(new THREE.BoxGeometry(0.22, 0.72, 7.6), mats.wall);
      rail.position.set(prop.x + 2.0, 1.85, prop.z);
      rail.rotation.x = -0.32;
      group.add(rail);
    } else if (prop.kind === "OVERHEAD_BEAM") {
      const beam = new THREE.Mesh(new THREE.BoxGeometry(CHUNK_WORLD_SIZE, 0.48, 0.42), mats.ceiling);
      beam.position.set(prop.x, h - 0.24, prop.z);
      group.add(beam);
    } else if (prop.kind === "CEILING_PIPE") {
      const pipeMat = getSharedTintMat(s, prop.color || 0xb84a27);
      const cPipe = new THREE.Mesh(new THREE.CylinderGeometry(0.11, 0.11, CHUNK_WORLD_SIZE, 10), pipeMat);
      cPipe.rotation.z = Math.PI / 2;
      cPipe.position.set(prop.x, h - 0.52, prop.z);
      group.add(cPipe);
    } else if (prop.kind === "FAKE_EXIT_SIGN") {
      const sign = new THREE.Mesh(new THREE.BoxGeometry(0.95, 0.36, 0.1), s.greenExitMat);
      sign.position.set(prop.x, 3.1, prop.z);
      group.add(sign);
    } else if (prop.kind === "TUNNEL_ARCH") {
      // Half-cylinder concrete highway tunnel vault (File:Tunnel.webp & File:Now THIS is the hub.png)
      const archGeo = new THREE.CylinderGeometry(
        prop.radius,
        prop.radius,
        prop.length,
        20,
        1,
        true,
        0,
        Math.PI
      );
      const arch = new THREE.Mesh(archGeo, s.hubConcreteMat);
      arch.position.set(prop.centerX, 0.2, prop.centerZ);
      if (prop.axis === "x") {
        arch.rotation.z = Math.PI / 2;
        arch.rotation.x = -Math.PI / 2;
      } else {
        arch.rotation.x = Math.PI / 2;
        arch.rotation.z = Math.PI / 2;
      }
      group.add(arch);
    } else if (prop.kind === "HIGHWAY_ROAD") {
      const isX = prop.axis === "x";
      const roadW = isX ? prop.length : prop.width;
      const roadD = isX ? prop.width : prop.length;
      const road = new THREE.Mesh(new THREE.PlaneGeometry(roadW, roadD), mats.floor);
      road.rotation.x = -Math.PI / 2;
      road.position.set(prop.centerX, 0.02, prop.centerZ);
      group.add(road);

      // Dashed white center markings & continuous white edge lines
      for (let seg = -9; seg <= 9; seg += 4.5) {
        const dash = new THREE.Mesh(
          new THREE.PlaneGeometry(isX ? 2.2 : 0.16, isX ? 0.16 : 2.2),
          s.roadLineMat
        );
        dash.rotation.x = -Math.PI / 2;
        dash.position.set(
          prop.centerX + (isX ? seg : 0),
          0.032,
          prop.centerZ + (isX ? 0 : seg)
        );
        group.add(dash);
      }
      for (const offset of [-prop.width * 0.44, prop.width * 0.44]) {
        const line = new THREE.Mesh(
          new THREE.PlaneGeometry(isX ? prop.length : 0.14, isX ? 0.14 : prop.length),
          s.roadLineMat
        );
        line.rotation.x = -Math.PI / 2;
        line.position.set(
          prop.centerX + (isX ? 0 : offset),
          0.032,
          prop.centerZ + (isX ? offset : 0)
        );
        group.add(line);
      }
    } else if (prop.kind === "SIDEWALK_CURB") {
      const curb = new THREE.Mesh(new THREE.BoxGeometry(prop.length, 0.22, prop.width), s.sidewalkMat);
      curb.position.set(prop.x, 0.11, prop.z);
      group.add(curb);
      for (let sx = -9; sx <= 9; sx += 6) {
        const stud = new THREE.Mesh(new THREE.BoxGeometry(0.12, 0.08, 0.12), s.curbRedGlowMat);
        stud.position.set(prop.x + sx, 0.23, prop.z);
        group.add(stud);
      }
    } else if (prop.kind === "TRAFFIC_GANTRY") {
      const isX = prop.axis === "x";
      const bar = new THREE.Mesh(
        new THREE.BoxGeometry(isX ? 0.24 : 7.6, 0.28, isX ? 7.6 : 0.24),
        s.gantryMat
      );
      bar.position.set(prop.x, 4.15, prop.z);
      group.add(bar);
      for (const off of [-2.0, -0.7, 0.7, 2.0]) {
        const box = new THREE.Mesh(new THREE.BoxGeometry(0.55, 0.55, 0.14), s.gantryMat);
        box.position.set(prop.x + (isX ? 0 : off), 4.15, prop.z + (isX ? off : 0));
        if (isX) box.rotation.y = Math.PI / 2;
        group.add(box);
        const led = new THREE.Mesh(new THREE.BoxGeometry(0.32, 0.32, 0.16), s.redSignGlowMat);
        led.position.copy(box.position);
        led.rotation.copy(box.rotation);
        group.add(led);
      }
    } else if (prop.kind === "VENT_FAN") {
      const shroud = new THREE.Mesh(new THREE.CylinderGeometry(0.62, 0.62, 1.5, 14, 1, true), s.fanBodyMat);
      shroud.rotation.z = Math.PI / 2;
      shroud.position.set(prop.x, prop.y, prop.z);
      group.add(shroud);
      const rotor = new THREE.Mesh(new THREE.BoxGeometry(0.08, 1.05, 0.22), s.hazardYellowMat);
      rotor.position.set(prop.x, prop.y, prop.z);
      rotor.userData = { isVentRotor: true };
      group.add(rotor);
      ventFanRotors.push(rotor);
    } else if (prop.kind === "BLUE_TUNNEL_SIGN") {
      const sign = new THREE.Mesh(new THREE.BoxGeometry(0.65, 0.65, 0.1), s.blueSignGlowMat);
      sign.position.set(prop.x, 2.1, prop.z);
      group.add(sign);
    } else if (prop.kind === "CHAMFER_RIB") {
      // Concrete rib pilasters + 45-deg upper chamfer haunches (File:Spoopy level2.png)
      const isZ = prop.axis === "z";
      for (const side of [-1, 1]) {
        const haunch = new THREE.Mesh(
          new THREE.BoxGeometry(isZ ? 0.58 : 0.35, 0.58, isZ ? 0.35 : 0.58),
          mats.ceiling
        );
        haunch.position.set(
          prop.x + (isZ ? side * 1.25 : 0),
          h - 0.22,
          prop.z + (isZ ? 0 : side * 1.25)
        );
        if (isZ) haunch.rotation.z = Math.PI / 4;
        else haunch.rotation.x = Math.PI / 4;
        group.add(haunch);
      }
    } else if (prop.kind === "SIDE_PIPE_RUN") {
      // Multi-tier horizontal pipes bolted along corridor walls (File:Spoopy level2.png & File:Level2main.png)
      const isX = prop.axis === "x";
      for (const [py, pRad, pMat] of [
        [0.85, 0.08, s.rustPipeMat],
        [1.45, 0.11, s.darkPipeMat],
        [2.05, 0.09, s.rustPipeMat],
      ]) {
        const pipe = new THREE.Mesh(new THREE.CylinderGeometry(pRad, pRad, CELL_SIZE, 10), pMat);
        pipe.position.set(prop.x, py, prop.z);
        if (isX) pipe.rotation.z = Math.PI / 2;
        else pipe.rotation.x = Math.PI / 2;
        group.add(pipe);
      }
      if (prop.hasValve) {
        const valve = new THREE.Mesh(new THREE.TorusGeometry(0.14, 0.03, 6, 12), s.valveRedMat);
        valve.position.set(prop.x, 1.45, prop.z);
        if (!isX) valve.rotation.y = Math.PI / 2;
        group.add(valve);
      }
    } else if (prop.kind === "STEAM_VENT") {
      const vent = new THREE.Mesh(new THREE.CylinderGeometry(0.28, 0.28, 0.4, 10), s.rustPipeMat);
      vent.position.set(prop.x, h - 0.2, prop.z);
      group.add(vent);
    }
  }

  // Interactables (Doors, Stairs, Level Key Pedestals)
  for (const item of chunkData.interactables) {
    if (item.type === "STAIRS") {
      for (let step = 0; step < 5; step += 1) {
        const sGeo = new THREE.BoxGeometry(1.8, 0.28, 0.45);
        const sMesh = new THREE.Mesh(sGeo, mats.stairsMat);
        sMesh.position.set(item.x, 0.14 + step * 0.28, item.z - 0.8 + step * 0.4);
        group.add(sMesh);
      }
    } else if (
      item.type === "HUB_LEVEL_DOOR" ||
      item.type === "HUB_DOOR_A" ||
      item.type === "HUB_DOOR_B" ||
      item.type === "EXIT_DOOR" ||
      item.type === "MANILA_PORTAL" ||
      item.type === "MANILA_REST"
    ) {
      const dGeo = new THREE.BoxGeometry(1.3, 2.35, 0.22);
      const dMesh = new THREE.Mesh(dGeo, mats.door);
      dMesh.position.set(item.x, 1.18, item.z);
      group.add(dMesh);

      const tint =
        item.context?.doorTint ||
        (item.type === "HUB_DOOR_B"
          ? 0x4ea8de
          : item.type === "HUB_DOOR_A"
          ? 0xf4a261
          : item.type === "MANILA_PORTAL" || item.type === "MANILA_REST"
          ? 0xd4a259
          : 0xe63946);
      const badgeGeo = new THREE.BoxGeometry(0.95, 0.26, 0.26);
      const badge = new THREE.Mesh(badgeGeo, getSharedTintMat(s, tint));
      badge.position.set(item.x, 2.52, item.z);
      group.add(badge);
    } else if (item.type === "KEY_PICKUP") {
      if (!state.hasLevelKey) {
        const pedGeo = new THREE.CylinderGeometry(0.32, 0.4, 0.9, 12);
        const ped = new THREE.Mesh(pedGeo, mats.stairsMat);
        ped.position.set(item.x, 0.45, item.z);
        group.add(ped);

        const keyGeo = new THREE.OctahedronGeometry(0.24, 0);
        const keyMesh = new THREE.Mesh(keyGeo, getSharedTintMat(s, 0xffd166));
        keyMesh.position.set(item.x, 1.25, item.z);
        group.add(keyMesh);
        keyPickupMeshes.push(keyMesh);
      }
    }
  }

  // Ceiling Light Fixtures + Budgeted Point Lights
  const nearOriginOrPlayer =
    Math.max(
      Math.abs(chunkData.cx - Math.floor(state.player.x / CHUNK_WORLD_SIZE)),
      Math.abs(chunkData.cz - Math.floor(state.player.z / CHUNK_WORLD_SIZE))
    ) <= 1;

  chunkData.lights.forEach((lt, idx) => {
    const panelGeo = new THREE.BoxGeometry(1.15, 0.08, 0.55);
    const panel = new THREE.Mesh(panelGeo, mats.ceilingEmissiveMat);
    panel.position.set(lt.x, lt.y, lt.z);
    group.add(panel);

    if (nearOriginOrPlayer && idx === 0) {
      const pt = new THREE.PointLight(
        levelData.environment.lightColor,
        levelData.environment.lightIntensity,
        16,
        1.6
      );
      pt.position.set(lt.x, lt.y - 0.25, lt.z);
      pt.userData = {
        baseIntensity: levelData.environment.lightIntensity,
        flickerPhase: lt.flickerPhase,
      };
      group.add(pt);
      chunkPointLights.push(pt);
    }
  });

  scene.add(group);
  chunkMeshes.set(chunkData.key, group);
}

const chunkManager = new ChunkManager({
  levelId: state.currentLevelId,
  worldSeed: state.worldSeed,
  loadRadius: 2,
  unloadRadius: 3,
  onChunkLoad: (chunkData) => buildChunkGroup(chunkData),
  onChunkUnload: (chunkData) => {
    const group = chunkMeshes.get(chunkData.key);
    if (group) {
      disposeChunkGroup(group);
      chunkMeshes.delete(chunkData.key);
    }
  },
});

// ---------------------------------------------------------------------------
// Level Switching & HUD Updates
// ---------------------------------------------------------------------------
function updateTextureStatusHud() {
  const mats = materialCache.getMaterials(state.currentLevelId);
  const st = mats.status;
  ui.hudTexStatus.textContent =
    st.wikiLoaded > 0
      ? `AI再生成テクスチャ (${st.wikiLoaded}/${st.total})`
      : `Canvasプロシージャル (${st.total}/${st.total})`;
}

function applyLevelEnvironment(levelId) {
  const levelData = getLevelData(levelId);
  const env = levelData.environment;

  scene.background = new THREE.Color(env.fogColor);
  scene.fog = new THREE.FogExp2(env.fogColor, env.fogDensity);
  ambientLight.color.setHex(env.ambientColor);
  ambientLight.intensity = env.ambientIntensity;
  hemiLight.color.setHex(env.ambientColor);
  hemiLight.groundColor.setHex(env.fogColor);

  ui.hudBadge.textContent = levelData.survivalClass.code;
  ui.hudBadge.style.borderColor = levelData.survivalClass.colorHex;
  ui.hudBadge.style.backgroundColor = `${levelData.survivalClass.colorHex}55`;
  ui.hudLevelName.textContent = levelData.name;
  ui.hudLevelSub.textContent = levelData.subtitle;
  ui.hudClassLabel.textContent = levelData.survivalClass.label;
  ui.hudMmoMode.textContent =
    levelData.mmoInstanceMode === "solo_isolated"
      ? "Solo Isolated (Phenomenon 15)"
      : "Shared MMO Shard Ready";
  ui.hudAttribution.innerHTML =
    `出典: <a href="${levelData.wikiUrl}" target="_blank" rel="noopener">${escapeHtml(
      levelData.wikiTitle
    )}</a> (${LICENSE_INFO.wikiName}) | License: <a href="${
      LICENSE_INFO.url
    }" target="_blank" rel="noopener">${LICENSE_INFO.name}</a>`;

  updateTextureStatusHud();
  ui.blackoutBanner.classList.add("hidden");
  smilerGroup.visible = false;
  state.blackoutActive = false;
  state.blackoutTimer = 0;

  for (const line of levelData.ambientLogs) {
    addLog(line);
  }
}

function triggerGlitchFlash() {
  ui.glitchFlash.classList.remove("hidden");
  ui.glitchFlash.classList.add("active");
  setTimeout(() => {
    ui.glitchFlash.classList.remove("active");
    ui.glitchFlash.classList.add("hidden");
  }, 420);
}

function switchLevel(targetLevelId, spawnPos = { x: 1.5, z: 1.5 }, reason = "") {
  keyPickupMeshes = [];
  ventFanRotors = [];
  chunkManager.reset(targetLevelId, state.worldSeed);
  state.currentLevelId = targetLevelId;
  state.player.x = spawnPos.x;
  state.player.z = spawnPos.z;
  state.player.y = PLAYER_EYE_HEIGHT;

  applyLevelEnvironment(targetLevelId);
  chunkManager.update(state.player.x, state.player.z);
  audio.setLevelAmbience(targetLevelId);

  if (reason) {
    addLog(`>>> ${reason}`);
  }
  updateHudTelemetry();
}

function updateHudTelemetry() {
  const { cx, cz } = chunkManager.worldToChunk(state.player.x, state.player.z);
  const distOrigin = Math.hypot(state.player.x, state.player.z);
  ui.hudCoords.textContent = `X:${state.player.x.toFixed(1)}m Z:${state.player.z.toFixed(1)}m (原点距離 ${distOrigin.toFixed(0)}m)`;
  ui.hudChunk.textContent = `(${cx}, ${cz})`;
  ui.hudActiveChunks.textContent = `${chunkManager.chunks.size}`;
  ui.hudSeed.textContent = `${state.worldSeedStr} (#${state.worldSeed})`;
  ui.hudKeyStatus.textContent = state.hasLevelKey ? "Object 2 所持中" : "未所持";
  ui.hudKeyStatus.className = state.hasLevelKey ? "badge-ok" : "badge-muted";
  ui.hudFlashlight.textContent = state.flashlightOn ? "ON" : "OFF";

  const deg = ((-state.player.yaw * 180) / Math.PI) % 360;
  ui.compassNeedle.style.transform = `rotate(${deg}deg)`;
}

// ---------------------------------------------------------------------------
// Interaction & Noclip Handlers
// ---------------------------------------------------------------------------
function executeInteraction() {
  const item = chunkManager.findNearestInteractable(state.player.x, state.player.z, 3.0);
  if (!item) {
    addLog("周囲にインタラクト可能な対象がありません。");
    return;
  }

  if (item.triggerType === "PICKUP_KEY") {
    if (!state.hasLevelKey) {
      state.hasLevelKey = true;
      audio.playKeyPickup();
      for (const km of keyPickupMeshes) {
        km.visible = false;
      }
      addLog("Object 2 (Level Key) を取得しました！ The Hub の全金属扉を解錠できます。");
      updateHudTelemetry();
    }
    return;
  }

  if (item.triggerType === "HUB_SEQ_STEP_B") {
    state.hubSequenceStep = "door_a_after_b";
    audio.playDoorTransition();
    addLog("Door [B] を通過しました。次は隣接する Door [A] を起動してください。");
    return;
  }

  const result = evaluateTransition({
    currentLevelId: state.currentLevelId,
    triggerType: item.triggerType,
    worldSeed: state.worldSeed,
    playerPos: { x: state.player.x, z: state.player.z },
    context: {
      ...item.context,
      hasLevelKey: state.hasLevelKey,
      sequenceStep: state.hubSequenceStep,
    },
  });

  if (!result.allowed) {
    addLog(`[DENIED] ${result.reason}`);
    return;
  }

  audio.playDoorTransition();
  triggerGlitchFlash();
  state.hubSequenceStep = "none";
  switchLevel(result.targetLevelId, result.spawnPos, result.reason);
}

function executeNoclip() {
  const col = chunkManager.resolveCollision(state.player.x, state.player.z, PLAYER_RADIUS);
  const nearest = chunkManager.findNearestInteractable(state.player.x, state.player.z, 3.2);
  const triggerType =
    state.currentLevelId === "level_1" &&
    (col.nearbyGlitchWall?.cellType === CELL_TYPES.OUTLET_WALL ||
      nearest?.triggerType === TRIGGER_TYPES.OUTLET_NOCLIP)
      ? TRIGGER_TYPES.OUTLET_NOCLIP
      : TRIGGER_TYPES.NOCLIP_WALL;

  const result = evaluateTransition({
    currentLevelId: state.currentLevelId,
    triggerType,
    worldSeed: state.worldSeed,
    playerPos: { x: state.player.x, z: state.player.z },
    context: {},
  });

  if (!result.allowed) {
    addLog(`[NOCLIP FAILED] ${result.reason}`);
    return;
  }

  audio.playNoclipGlitch();
  triggerGlitchFlash();
  switchLevel(result.targetLevelId, result.spawnPos, result.reason);
}

// ---------------------------------------------------------------------------
// Input & Pointer Lock Events
// ---------------------------------------------------------------------------
document.addEventListener("pointerlockchange", () => {
  state.pointerLocked = document.pointerLockElement === renderer.domElement;
  if (!state.pointerLocked && state.started) {
    ui.hudPrompt.textContent = "クリックでマウス視点復帰 / WASD移動 / ←→回転 / F懐中電灯 / E調べる / Nノークリップ";
  }
});

document.addEventListener("mousemove", (ev) => {
  if (!state.pointerLocked) return;
  state.player.yaw -= ev.movementX * 0.0022;
  state.player.pitch = Math.max(
    -1.48,
    Math.min(1.48, state.player.pitch - ev.movementY * 0.0022)
  );
});

window.addEventListener("keydown", (ev) => {
  if (!state.started) return;
  const code = ev.code;
  state.keysPressed.add(code);

  if (code === "KeyF") {
    state.flashlightOn = !state.flashlightOn;
    flashlight.visible = state.flashlightOn;
    audio.playFlashlightClick(state.flashlightOn);
    updateHudTelemetry();
  } else if (code === "KeyE") {
    executeInteraction();
  } else if (code === "KeyN") {
    executeNoclip();
  } else if (code === "KeyM") {
    const muted = audio.toggleMute();
    addLog(muted ? "オーディオをミュートしました (M)。" : "オーディオを再開しました (M)。");
  } else if (code === "KeyH") {
    state.hudVisible = !state.hudVisible;
    ui.hud.classList.toggle("hidden", !state.hudVisible);
  }
});

window.addEventListener("keyup", (ev) => {
  state.keysPressed.delete(ev.code);
});

renderer.domElement.addEventListener("click", () => {
  if (state.started && !state.pointerLocked && renderer.domElement.requestPointerLock) {
    renderer.domElement.requestPointerLock();
  }
  audio.init();
});

window.addEventListener("resize", () => {
  camera.aspect = window.innerWidth / window.innerHeight;
  camera.updateProjectionMatrix();
  renderer.setSize(window.innerWidth, window.innerHeight);
});

ui.btnEnter.addEventListener("click", () => {
  const seedVal = ui.seedInput.value.trim() || "1999";
  const startLevel = ui.levelSelect.value || "level_0";
  state.worldSeedStr = seedVal;
  state.worldSeed = hashStringToSeed(seedVal);
  state.started = true;
  state.hasLevelKey = false;
  state.hubSequenceStep = "none";

  ui.overlay.classList.add("hidden");
  audio.init();
  switchLevel(startLevel, { x: 1.5, z: 1.5 }, `シード "${seedVal}" で ${getLevelData(startLevel).name} へ進入`);
  if (renderer.domElement.requestPointerLock) {
    renderer.domElement.requestPointerLock();
  }
});

function populateWikiModal() {
  const cards = Object.values(LEVELS)
    .map(
      (lvl) => `
      <div class="wiki-card">
        <h3>${escapeHtml(lvl.name)}</h3>
        <p class="wiki-meta">クラス: <strong>${escapeHtml(lvl.survivalClass.label)}</strong> | MMO: <code>${escapeHtml(lvl.mmoInstanceMode)}</code></p>
        <p>${escapeHtml(lvl.environment.description)}</p>
        <p class="wiki-links">
          一次Markdown: <code>${escapeHtml(lvl.sourcePagePath)}</code><br/>
          画像: <code>${escapeHtml(lvl.textures.wall.wikiFile)}</code><br/>
          出典: <a href="${lvl.wikiUrl}" target="_blank" rel="noopener">${lvl.wikiUrl}</a> (${LICENSE_INFO.name})
        </p>
      </div>`
    )
    .join("");
  ui.wikiModalBody.innerHTML = cards;
}

ui.btnWikiModal.addEventListener("click", () => {
  populateWikiModal();
  ui.wikiModal.classList.remove("hidden");
});

ui.btnCloseModal.addEventListener("click", () => {
  ui.wikiModal.classList.add("hidden");
});

// ---------------------------------------------------------------------------
// Main Simulation & Render Loop
// ---------------------------------------------------------------------------
let lastTime = performance.now();
let driftCheckAccum = 0;

function updateAtmosphere(dt, elapsedSec) {
  const levelData = getLevelData(state.currentLevelId);
  const env = levelData.environment;
  const mats = materialCache.getMaterials(state.currentLevelId);

  // Level 1 & Manila Room Blackout Cycle
  if (env.blackoutIntervalSec > 0) {
    state.blackoutTimer += dt;
    if (!state.blackoutActive && state.blackoutTimer >= env.blackoutIntervalSec) {
      state.blackoutActive = true;
      state.blackoutTimer = 0;
      audio.playBlackout(true);
      ui.blackoutBanner.classList.remove("hidden");
      addLog("[BLACKOUT] 照明電源が遮断されました！懐中電灯 (F) を確保してください！");
    } else if (state.blackoutActive && state.blackoutTimer >= env.blackoutDurationSec) {
      state.blackoutActive = false;
      state.blackoutTimer = 0;
      audio.playBlackout(false);
      ui.blackoutBanner.classList.add("hidden");
      smilerGroup.visible = false;
      addLog("[POWER RESTORED] 蛍光灯が再点灯しました。");
    }
  }

  // Smiler eyes in dark during Level 1 blackout when flashlight is OFF
  if (state.currentLevelId === "level_1" && state.blackoutActive && !state.flashlightOn) {
    if (!smilerGroup.visible) {
      const dist = 10.5;
      smilerGroup.position.set(
        state.player.x - Math.sin(state.player.yaw) * dist,
        1.5,
        state.player.z - Math.cos(state.player.yaw) * dist
      );
      smilerGroup.lookAt(state.player.x, 1.5, state.player.z);
      smilerGroup.visible = true;
    }
  } else {
    smilerGroup.visible = false;
  }

  // The Hub hue-shifting lights (orange -> red -> purple/green)
  let currentLightHex = env.lightColor;
  if (env.hueShiftColors && env.hueShiftColors.length > 0) {
    const idx = Math.floor(elapsedSec / 12) % env.hueShiftColors.length;
    currentLightHex = env.hueShiftColors[idx];
    mats.ceilingEmissiveMat.color.setHex(currentLightHex);
  } else {
    mats.ceilingEmissiveMat.color.setHex(state.blackoutActive ? 0x0b0b0c : env.lightColor);
  }

  ambientLight.intensity = state.blackoutActive ? 0.03 : env.ambientIntensity;
  for (const pt of chunkPointLights) {
    if (state.blackoutActive) {
      pt.intensity = 0;
    } else {
      const base = pt.userData.baseIntensity || 1.3;
      const flicker = env.lightFlicker
        ? 0.92 + 0.08 * Math.sin(elapsedSec * 19 + (pt.userData.flickerPhase || 0))
        : 1.0;
      pt.intensity = base * flicker;
      pt.color.setHex(currentLightHex);
    }
  }

  // Spin Level Key crystals & Hub ventilation fans
  for (const km of keyPickupMeshes) {
    if (km.visible) {
      km.rotation.y += dt * 1.8;
      km.position.y = 1.24 + Math.sin(elapsedSec * 2.5) * 0.08;
    }
  }
  for (const rotor of ventFanRotors) {
    rotor.rotation.x += dt * 7.5;
  }
}

function animate(now) {
  requestAnimationFrame(animate);
  const dt = Math.min(0.05, (now - lastTime) / 1000);
  lastTime = now;
  const elapsedSec = now / 1000;

  if (state.started) {
    // Fallback yaw rotation with ArrowLeft/ArrowRight or Q
    if (state.keysPressed.has("ArrowLeft") || state.keysPressed.has("KeyQ")) {
      state.player.yaw += 1.9 * dt;
    }
    if (state.keysPressed.has("ArrowRight")) {
      state.player.yaw -= 1.9 * dt;
    }

    let forward = 0;
    let strafe = 0;
    if (state.keysPressed.has("KeyW") || state.keysPressed.has("ArrowUp")) forward += 1;
    if (state.keysPressed.has("KeyS") || state.keysPressed.has("ArrowDown")) forward -= 1;
    if (state.keysPressed.has("KeyD")) strafe += 1;
    if (state.keysPressed.has("KeyA")) strafe -= 1;

    const moving = forward !== 0 || strafe !== 0;
    if (moving) {
      const len = Math.hypot(forward, strafe);
      const nf = forward / len;
      const ns = strafe / len;
      const speed =
        state.keysPressed.has("ShiftLeft") || state.keysPressed.has("ShiftRight")
          ? SPRINT_SPEED
          : WALK_SPEED;

      const sinY = Math.sin(state.player.yaw);
      const cosY = Math.cos(state.player.yaw);
      const vx = (-sinY * nf + cosY * ns) * speed * dt;
      const vz = (-cosY * nf - sinY * ns) * speed * dt;

      const resolved = chunkManager.resolveCollision(
        state.player.x + vx,
        state.player.z + vz,
        PLAYER_RADIUS
      );
      state.player.x = resolved.x;
      state.player.z = resolved.z;

      state.player.bobPhase += dt * (speed > WALK_SPEED ? 13 : 9);
      state.player.stepAccum += speed * dt;
      if (state.player.stepAccum >= 2.15) {
        state.player.stepAccum = 0;
        audio.playFootstep(state.currentLevelId);
      }

      const streamRes = chunkManager.update(state.player.x, state.player.z);
      if (streamRes.loadedKeys.length > 0 || streamRes.unloadedKeys.length > 0) {
        updateHudTelemetry();
      }
    } else {
      state.player.bobPhase = 0;
    }

    // Update Camera
    const bobOffset = moving ? Math.sin(state.player.bobPhase) * 0.045 : 0;
    camera.position.set(state.player.x, state.player.y + bobOffset, state.player.z);
    camera.rotation.order = "YXZ";
    camera.rotation.y = state.player.yaw;
    camera.rotation.x = state.player.pitch;

    // Context prompt (Nearest interactable or glitch wall)
    const nearest = chunkManager.findNearestInteractable(state.player.x, state.player.z, 3.0);
    const colProbe = chunkManager.resolveCollision(state.player.x, state.player.z, PLAYER_RADIUS);
    if (nearest) {
      ui.hudPrompt.textContent = nearest.label;
    } else if (colProbe.nearbyGlitchWall) {
      ui.hudPrompt.textContent = "空間の不安定境界を検知 — [N] キーでノークリップ";
    } else if (state.pointerLocked) {
      ui.hudPrompt.textContent =
        "WASD移動 | Shiftダッシュ | F懐中電灯 | E調べる | Nノークリップ | M消音 | H HUD";
    }

    // Passive Level 0 Distance Drift check (every 0.5s)
    driftCheckAccum += dt;
    if (driftCheckAccum >= 0.5) {
      driftCheckAccum = 0;
      updateHudTelemetry();
      if (state.currentLevelId === "level_0") {
        const driftRes = evaluateTransition({
          currentLevelId: "level_0",
          triggerType: TRIGGER_TYPES.DISTANCE_DRIFT,
          worldSeed: state.worldSeed,
          playerPos: { x: state.player.x, z: state.player.z },
          context: {},
        });
        if (driftRes.allowed) {
          audio.playNoclipGlitch();
          triggerGlitchFlash();
          switchLevel(driftRes.targetLevelId, driftRes.spawnPos, driftRes.reason);
        }
      }
    }

    updateAtmosphere(dt, elapsedSec);
  }

  renderer.render(scene, camera);
}

// Initialize initial scene backdrop for preview behind start overlay
applyLevelEnvironment("level_0");
chunkManager.update(state.player.x, state.player.z);
updateHudTelemetry();
requestAnimationFrame(animate);
