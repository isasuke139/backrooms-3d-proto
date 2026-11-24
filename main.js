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

    for (const slot of slots) {
      const spec = levelData.textures[slot];
      const canvas = createProceduralTextureCanvas(
        spec?.proceduralStyle || "level0_wallpaper",
        256,
        256,
        seed + slot.length * 97
      );
      const procTex = new THREE.CanvasTexture(canvas);
      procTex.wrapS = THREE.RepeatWrapping;
      procTex.wrapT = THREE.RepeatWrapping;
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

      // Attempt asynchronous upgrade to local Wiki texture
      const candidates = resolveTextureCandidates(levelId, slot);
      this._tryLoadCandidates(candidates, slot, mat, procTex, status);
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

    const entry = {
      ...materials,
      ceilingEmissiveMat,
      glitchMat,
      puddleMat,
      pipeMat,
      stairsMat,
      status,
    };
    this.cache.set(levelId, entry);
    return entry;
  }

  _tryLoadCandidates(candidates, slot, mat, fallbackTex, status) {
    if (!candidates || candidates.length === 0) return;

    const tryNext = (idx) => {
      if (idx >= candidates.length) return;
      const url = candidates[idx];
      this.loader.load(
        url,
        (tex) => {
          tex.wrapS = THREE.RepeatWrapping;
          tex.wrapT = THREE.RepeatWrapping;
          tex.colorSpace = THREE.SRGBColorSpace;
          if (slot === "floor" || slot === "ceiling") {
            tex.repeat.set(8, 8);
          }
          mat.map = tex;
          mat.needsUpdate = true;
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
  });
  scene.remove(group);
}

function buildChunkGroup(chunkData) {
  const levelData = getLevelData(chunkData.levelId);
  const mats = materialCache.getMaterials(chunkData.levelId);
  const group = new THREE.Group();
  group.name = chunkData.key;

  const h = levelData.environment.ceilingHeight;
  const originX = chunkData.cx * CHUNK_WORLD_SIZE;
  const originZ = chunkData.cz * CHUNK_WORLD_SIZE;
  const centerX = originX + CHUNK_WORLD_SIZE * 0.5;
  const centerZ = originZ + CHUNK_WORLD_SIZE * 0.5;

  // Floor & Ceiling
  const floorGeo = new THREE.PlaneGeometry(CHUNK_WORLD_SIZE, CHUNK_WORLD_SIZE);
  const floorMesh = new THREE.Mesh(floorGeo, mats.floor);
  floorMesh.rotation.x = -Math.PI / 2;
  floorMesh.position.set(centerX, 0, centerZ);
  group.add(floorMesh);

  const ceilGeo = new THREE.PlaneGeometry(CHUNK_WORLD_SIZE, CHUNK_WORLD_SIZE);
  const ceilMesh = new THREE.Mesh(ceilGeo, mats.ceiling);
  ceilMesh.rotation.x = Math.PI / 2;
  ceilMesh.position.set(centerX, h, centerZ);
  group.add(ceilMesh);

  // Walls, Pillars, Glitch Walls, Outlets, Cars
  for (const w of chunkData.walls) {
    const width = w.maxX - w.minX;
    const depth = w.maxZ - w.minZ;
    const cx = (w.minX + w.maxX) * 0.5;
    const cz = (w.minZ + w.maxZ) * 0.5;

    if (w.cellType === CELL_TYPES.CAR) {
      // Unbranded non-operational car silhouette (Level 1)
      const carColor = ((w.lx + w.lz) % 2 === 0) ? 0x7c2929 : 0x263f63;
      const carMat = mats.door; // reuse shared textured material or tinted box
      const bodyGeo = new THREE.BoxGeometry(width, 0.72, depth);
      const body = new THREE.Mesh(bodyGeo, carMat);
      body.position.set(cx, 0.42, cz);
      group.add(body);

      const cabinGeo = new THREE.BoxGeometry(width * 0.72, 0.55, depth * 0.56);
      const cabin = new THREE.Mesh(cabinGeo, mats.ceiling);
      cabin.position.set(cx, 1.04, cz);
      group.add(cabin);

      const accentGeo = new THREE.BoxGeometry(width * 1.02, 0.14, depth * 1.02);
      const stripe = new THREE.Mesh(
        accentGeo,
        new THREE.MeshBasicMaterial({ color: carColor })
      );
      stripe.position.set(cx, 0.45, cz);
      group.add(stripe);
      continue;
    }

    const mat =
      w.cellType === CELL_TYPES.GLITCH_WALL
        ? mats.glitchMat
        : w.cellType === CELL_TYPES.MANILA_WALL
        ? mats.door
        : mats.wall;

    const wallGeo = new THREE.BoxGeometry(width, w.height, depth);
    const mesh = new THREE.Mesh(wallGeo, mat);
    mesh.position.set(cx, w.height * 0.5, cz);
    group.add(mesh);

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
      const boxGeo = new THREE.BoxGeometry(0.32, 0.44, width + 0.06);
      const outlet = new THREE.Mesh(boxGeo, mats.stairsMat);
      outlet.position.set(cx, 0.9, cz);
      group.add(outlet);
    }
  }

  // Props (Puddles, Overhead Pipes, Photo Plaque)
  for (const prop of chunkData.props) {
    if (prop.kind === "PUDDLE") {
      const pGeo = new THREE.CircleGeometry(prop.radius, 18);
      const pMesh = new THREE.Mesh(pGeo, mats.puddleMat);
      pMesh.rotation.x = -Math.PI / 2;
      pMesh.position.set(prop.x, 0.015, prop.z);
      group.add(pMesh);
    } else if (prop.kind === "OVERHEAD_PIPE") {
      const pipeGeo = new THREE.CylinderGeometry(0.14, 0.14, CELL_SIZE, 10);
      const pipeMesh = new THREE.Mesh(pipeGeo, mats.pipeMat);
      pipeMesh.position.set(prop.x, h - 0.32, prop.z);
      if (prop.axis === "x") {
        pipeMesh.rotation.z = Math.PI / 2;
      } else {
        pipeMesh.rotation.x = Math.PI / 2;
      }
      group.add(pipeMesh);
    } else if (prop.kind === "PHOTO_PLAQUE") {
      const frameGeo = new THREE.BoxGeometry(1.5, 1.15, 0.08);
      const frame = new THREE.Mesh(frameGeo, mats.accent);
      frame.position.set(prop.x, 1.65, prop.z);
      group.add(frame);
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
      const badge = new THREE.Mesh(
        badgeGeo,
        new THREE.MeshBasicMaterial({ color: tint })
      );
      badge.position.set(item.x, 2.52, item.z);
      group.add(badge);
    } else if (item.type === "KEY_PICKUP") {
      if (!state.hasLevelKey) {
        const pedGeo = new THREE.CylinderGeometry(0.32, 0.4, 0.9, 12);
        const ped = new THREE.Mesh(pedGeo, mats.stairsMat);
        ped.position.set(item.x, 0.45, item.z);
        group.add(ped);

        const keyGeo = new THREE.OctahedronGeometry(0.24, 0);
        const keyMesh = new THREE.Mesh(
          keyGeo,
          new THREE.MeshBasicMaterial({ color: 0xffd166 })
        );
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
      ? `Wiki画像 (${st.wikiLoaded}/${st.total})`
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

  // Spin Level Key crystals
  for (const km of keyPickupMeshes) {
    if (km.visible) {
      km.rotation.y += dt * 1.8;
      km.position.y = 1.24 + Math.sin(elapsedSec * 2.5) * 0.08;
    }
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
