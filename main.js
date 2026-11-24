/**
 * Presentation, Three.js WebGL PBR renderer, dynamic shadows, PMREM reflections,
 * world-scaled UV builders, high-poly level architecture, dual texture loader,
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
import { LEVELS, LICENSE_INFO, getLevelData } from "./lore_data.js";
import {
  CELL_SIZE,
  CELL_TYPES,
  CHUNK_CELLS,
  CHUNK_WORLD_SIZE,
  ChunkManager,
  SOLID_CELL_TYPES,
  createProceduralTextureCanvas,
  hashStringToSeed,
  resolveTextureCandidates,
} from "./world_gen.js";
import { TRIGGER_TYPES, evaluateTransition } from "./transition_rules.js";
import { BackroomsAudio } from "./audio_synth.js";

const STAND_EYE_HEIGHT = 1.68;
const CROUCH_EYE_HEIGHT = 1.02;
const PLAYER_EYE_HEIGHT = STAND_EYE_HEIGHT;
const PLAYER_RADIUS = 0.42;
const WALK_SPEED = 5.2;
const SPRINT_SPEED = 8.0;
const CROUCH_SPEED = 2.7;
const JUMP_VELOCITY = 5.6;
const GRAVITY = 15.5;
const POINT_LIGHT_POOL_SIZE = 6;
export const ENABLE_L0_NON_EUCLIDEAN_SHIFT = false;

// ---------------------------------------------------------------------------
// DOM References
// ---------------------------------------------------------------------------
const ui = {
  viewport: document.getElementById("viewport"),
  camcorderVignette: document.getElementById("camcorder-vignette"),
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
// Geometry & Canvas Procedural Helpers (World-Scaled UVs, Signage, Halos)
// ---------------------------------------------------------------------------

/**
 * Rescale BoxGeometry UVs to world meters so thin walls, end-caps, pillars,
 * and wide partitions share uniform texture density without squishing.
 */
function createWorldScaledBoxGeometry(w, h, d, tileSize = 3.0) {
  const geo = new THREE.BoxGeometry(w, h, d);
  const pos = geo.attributes.position;
  const norm = geo.attributes.normal;
  const uv = geo.attributes.uv;

  for (let i = 0; i < pos.count; i += 1) {
    const nx = Math.abs(norm.getX(i));
    const ny = Math.abs(norm.getY(i));
    const x = pos.getX(i) + w * 0.5;
    const y = pos.getY(i) + h * 0.5;
    const z = pos.getZ(i) + d * 0.5;

    if (nx > 0.5) {
      uv.setXY(i, z / tileSize, y / tileSize);
    } else if (ny > 0.5) {
      uv.setXY(i, x / tileSize, z / tileSize);
    } else {
      uv.setXY(i, x / tileSize, y / tileSize);
    }
  }
  uv.needsUpdate = true;
  return geo;
}

/**
 * Build true curved colonnade wall section with arched cutout (Level 0 alt.png).
 */
function createArchedDividerGeometry(width, height, depth) {
  const shape = new THREE.Shape();
  const hw = width * 0.5;
  const kneeH = 1.05;
  const pillarW = 0.34;
  const archHalfSpan = Math.max(0.45, hw - pillarW);
  const springY = Math.max(kneeH + 0.15, height - 0.65 - archHalfSpan * 0.72);
  const archR = archHalfSpan;

  // Outer rectangle
  shape.moveTo(-hw, 0);
  shape.lineTo(hw, 0);
  shape.lineTo(hw, height);
  shape.lineTo(-hw, height);
  shape.closePath();

  // Inner arched opening hole
  const hole = new THREE.Path();
  hole.moveTo(-archHalfSpan, kneeH);
  hole.lineTo(-archHalfSpan, springY);
  hole.absarc(0, springY, archR, Math.PI, 0, true);
  hole.lineTo(archHalfSpan, kneeH);
  hole.closePath();
  shape.holes.push(hole);

  const geo = new THREE.ExtrudeGeometry(shape, {
    depth,
    bevelEnabled: true,
    bevelThickness: 0.02,
    bevelSize: 0.02,
    bevelSegments: 2,
    curveSegments: 14,
  });
  geo.translate(0, 0, -depth * 0.5);

  // World-scale UVs for clean wallpaper projection
  const pos = geo.attributes.position;
  const norm = geo.attributes.normal;
  const uv = geo.attributes.uv;
  for (let i = 0; i < pos.count; i += 1) {
    const nx = Math.abs(norm.getX(i));
    const ny = Math.abs(norm.getY(i));
    if (nx > 0.5) uv.setXY(i, (pos.getZ(i) + depth * 0.5) / 3.0, pos.getY(i) / 3.0);
    else if (ny > 0.5) uv.setXY(i, (pos.getX(i) + hw) / 3.0, (pos.getZ(i) + depth * 0.5) / 3.0);
    else uv.setXY(i, (pos.getX(i) + hw) / 3.0, pos.getY(i) / 3.0);
  }
  uv.needsUpdate = true;
  return geo;
}

/**
 * Sculpted unbranded sedan body profile (Level 1 parking lot).
 */
function createSedanBodyGeometry(length = 2.2, width = 1.6) {
  const shape = new THREE.Shape();
  const hl = length * 0.5;
  shape.moveTo(-hl, 0.25);
  shape.lineTo(hl, 0.25);
  shape.lineTo(hl, 0.68);
  shape.lineTo(hl * 0.56, 0.78);
  shape.lineTo(hl * 0.28, 1.24);
  shape.lineTo(-hl * 0.42, 1.24);
  shape.lineTo(-hl * 0.72, 0.80);
  shape.lineTo(-hl, 0.74);
  shape.closePath();

  const geo = new THREE.ExtrudeGeometry(shape, {
    depth: width,
    bevelEnabled: true,
    bevelThickness: 0.04,
    bevelSize: 0.04,
    bevelSegments: 2,
  });
  geo.translate(0, 0, -width * 0.5);
  return geo;
}

let GEO_BATCH_SEQ = 0;
let MAT_BATCH_SEQ = 0;

function markSharedGeo(geo) {
  geo.userData = { ...(geo.userData || {}), sharedGeo: true };
  return geo;
}

const SHARED_GEOS = {
  box: markSharedGeo(new THREE.BoxGeometry(1, 1, 1)),
  plane: markSharedGeo(new THREE.PlaneGeometry(1, 1)),
  cyl10: markSharedGeo(new THREE.CylinderGeometry(1, 1, 1, 10)),
  wheelStop: markSharedGeo(new THREE.CylinderGeometry(0.13, 0.17, 1.75, 4)),
  arrowHead: markSharedGeo(new THREE.ConeGeometry(0.38, 0.55, 3)),
  torusValve: markSharedGeo(new THREE.TorusGeometry(0.15, 0.03, 7, 14)),
};

const SHARED_BOX_CACHE = new Map();
function getSharedBoxGeo(w, h, d, tileSize = 3.0) {
  const key = `${w.toFixed(2)}:${h.toFixed(2)}:${d.toFixed(2)}:${tileSize.toFixed(1)}`;
  if (SHARED_BOX_CACHE.has(key)) return SHARED_BOX_CACHE.get(key);
  const geo = markSharedGeo(createWorldScaledBoxGeometry(w, h, d, tileSize));
  SHARED_BOX_CACHE.set(key, geo);
  return geo;
}

const SHARED_PLANE_CACHE = new Map();
function getSharedWorldPlaneGeo(w, d, tileSize = 2.4) {
  const key = `${w.toFixed(2)}:${d.toFixed(2)}:${tileSize.toFixed(2)}`;
  if (SHARED_PLANE_CACHE.has(key)) return SHARED_PLANE_CACHE.get(key);
  const geo = new THREE.PlaneGeometry(w, d);
  const pos = geo.attributes.position;
  const uv = geo.attributes.uv;
  for (let i = 0; i < pos.count; i += 1) {
    uv.setXY(i, (pos.getX(i) + w * 0.5) / tileSize, (pos.getY(i) + d * 0.5) / tileSize);
  }
  uv.needsUpdate = true;
  markSharedGeo(geo);
  SHARED_PLANE_CACHE.set(key, geo);
  return geo;
}

const SHARED_ARCH_CACHE = new Map();
function getSharedArchedDividerGeo(w, h, d) {
  const key = `${w.toFixed(2)}:${h.toFixed(2)}:${d.toFixed(2)}`;
  if (SHARED_ARCH_CACHE.has(key)) return SHARED_ARCH_CACHE.get(key);
  const geo = markSharedGeo(createArchedDividerGeometry(w, h, d));
  SHARED_ARCH_CACHE.set(key, geo);
  return geo;
}

const SHARED_PIPE_CACHE = new Map();
function getSharedPipeGeometry(radius, length, radialSegs = 12) {
  const key = `${radius.toFixed(3)}:${length.toFixed(2)}:${radialSegs}`;
  if (SHARED_PIPE_CACHE.has(key)) return SHARED_PIPE_CACHE.get(key);
  const geo = new THREE.CylinderGeometry(radius, radius, length, radialSegs);
  const uv = geo.attributes.uv;
  const vScale = Math.max(1, length / 1.6);
  for (let i = 0; i < uv.count; i += 1) {
    uv.setXY(i, uv.getX(i), uv.getY(i) * vScale);
  }
  uv.needsUpdate = true;
  markSharedGeo(geo);
  SHARED_PIPE_CACHE.set(key, geo);
  return geo;
}

/**
 * Collects repeated per-chunk geometries and flushes one InstancedMesh per
 * (geometry, material, receiveShadow, castShadow) bucket to dramatically slash draw calls.
 */
class ChunkInstanceBatcher {
  constructor() {
    this.buckets = new Map();
    this._mat4 = new THREE.Matrix4();
    this._quat = new THREE.Quaternion();
    this._euler = new THREE.Euler();
    this._pos = new THREE.Vector3();
    this._scale = new THREE.Vector3();
  }

  add(geo, mat, { x, y, z, rx = 0, ry = 0, rz = 0, sx = 1, sy = 1, sz = 1, receiveShadow = false, castShadow = false } = {}) {
    if (!geo._batchId) geo._batchId = ++GEO_BATCH_SEQ;
    if (!mat._batchId) mat._batchId = ++MAT_BATCH_SEQ;
    const key = `${geo._batchId}:${mat._batchId}:${receiveShadow ? 1 : 0}:${castShadow ? 1 : 0}`;
    let bucket = this.buckets.get(key);
    if (!bucket) {
      bucket = { geo, mat, receiveShadow, castShadow, matrices: [] };
      this.buckets.set(key, bucket);
    }
    this._pos.set(x, y, z);
    this._euler.set(rx, ry, rz, "XYZ");
    this._quat.setFromEuler(this._euler);
    this._scale.set(sx, sy, sz);
    this._mat4.compose(this._pos, this._quat, this._scale);
    bucket.matrices.push(this._mat4.clone());
  }

  flushTo(group) {
    for (const bucket of this.buckets.values()) {
      const count = bucket.matrices.length;
      if (count === 0) continue;
      const inst = new THREE.InstancedMesh(bucket.geo, bucket.mat, count);
      inst.castShadow = Boolean(bucket.castShadow);
      inst.receiveShadow = Boolean(bucket.receiveShadow);
      for (let i = 0; i < count; i += 1) {
        inst.setMatrixAt(i, bucket.matrices[i]);
      }
      inst.instanceMatrix.needsUpdate = true;
      inst.computeBoundingBox();
      inst.computeBoundingSphere();
      group.add(inst);
    }
  }
}

function createPuddleFallbackTexture(isFalsePuddle = false) {
  const c = document.createElement("canvas");
  c.width = 128;
  c.height = 128;
  const ctx = c.getContext("2d");
  const grad = ctx.createRadialGradient(64, 64, 10, 64, 64, 60);
  if (isFalsePuddle) {
    grad.addColorStop(0, "rgba(104, 122, 130, 0.92)");
    grad.addColorStop(0.68, "rgba(62, 74, 80, 0.72)");
    grad.addColorStop(1, "rgba(32, 38, 40, 0)");
  } else {
    grad.addColorStop(0, "rgba(24, 32, 30, 0.85)");
    grad.addColorStop(0.7, "rgba(38, 46, 44, 0.45)");
    grad.addColorStop(1, "rgba(38, 46, 44, 0)");
  }
  ctx.fillStyle = grad;
  ctx.fillRect(0, 0, 128, 128);
  const tex = new THREE.CanvasTexture(c);
  tex.colorSpace = THREE.SRGBColorSpace;
  return tex;
}

function createGlowSpriteTexture(hexColor = "#fff2c2") {
  const c = document.createElement("canvas");
  c.width = 128;
  c.height = 128;
  const ctx = c.getContext("2d");
  const grad = ctx.createRadialGradient(64, 64, 4, 64, 64, 62);
  grad.addColorStop(0, hexColor);
  grad.addColorStop(0.28, `${hexColor}88`);
  grad.addColorStop(1, "rgba(0,0,0,0)");
  ctx.fillStyle = grad;
  ctx.fillRect(0, 0, 128, 128);
  const tex = new THREE.CanvasTexture(c);
  tex.colorSpace = THREE.SRGBColorSpace;
  return tex;
}

function createHazardStripeTexture() {
  const c = document.createElement("canvas");
  c.width = 128;
  c.height = 128;
  const ctx = c.getContext("2d");
  ctx.fillStyle = "#d9a21b";
  ctx.fillRect(0, 0, 128, 128);
  ctx.fillStyle = "#181818";
  for (let i = -128; i < 256; i += 32) {
    ctx.beginPath();
    ctx.moveTo(i, 0);
    ctx.lineTo(i + 16, 0);
    ctx.lineTo(i - 48, 128);
    ctx.lineTo(i - 64, 128);
    ctx.closePath();
    ctx.fill();
  }
  const tex = new THREE.CanvasTexture(c);
  tex.wrapS = THREE.RepeatWrapping;
  tex.wrapT = THREE.RepeatWrapping;
  tex.repeat.set(3, 1);
  tex.colorSpace = THREE.SRGBColorSpace;
  return tex;
}

function createSignTexture(kind, text = "", bg = "#16181c", fg = "#ffffff") {
  const c = document.createElement("canvas");
  c.width = 256;
  c.height = 128;
  const ctx = c.getContext("2d");
  ctx.fillStyle = bg;
  ctx.fillRect(0, 0, 256, 128);

  if (kind === "TRIANGLE_WARN") {
    ctx.strokeStyle = "#ff3229";
    ctx.lineWidth = 10;
    ctx.beginPath();
    ctx.moveTo(128, 18);
    ctx.lineTo(192, 110);
    ctx.lineTo(64, 110);
    ctx.closePath();
    ctx.stroke();
    ctx.fillStyle = "#ff3229";
    ctx.fillRect(123, 50, 10, 32);
    ctx.fillRect(123, 90, 10, 10);
  } else if (kind === "RED_X") {
    ctx.strokeStyle = "#ff2b2b";
    ctx.lineWidth = 16;
    ctx.lineCap = "round";
    ctx.beginPath();
    ctx.moveTo(82, 24);
    ctx.lineTo(174, 104);
    ctx.moveTo(174, 24);
    ctx.lineTo(82, 104);
    ctx.stroke();
  } else if (kind === "BLUE_EXIT") {
    ctx.fillStyle = "#1263c9";
    ctx.fillRect(0, 0, 256, 128);
    ctx.strokeStyle = "#ffffff";
    ctx.lineWidth = 6;
    ctx.strokeRect(8, 8, 240, 112);
    ctx.fillStyle = "#ffffff";
    ctx.beginPath();
    ctx.arc(105, 38, 12, 0, Math.PI * 2);
    ctx.fill();
    ctx.fillRect(96, 52, 18, 34);
    ctx.fillRect(72, 62, 54, 10);
    ctx.fillRect(142, 28, 42, 74);
  } else {
    ctx.strokeStyle = fg;
    ctx.lineWidth = 5;
    ctx.strokeRect(6, 6, 244, 116);
    ctx.fillStyle = fg;
    ctx.font = "bold 46px monospace";
    ctx.textAlign = "center";
    ctx.textBaseline = "middle";
    ctx.fillText(text, 128, 66);
  }

  const tex = new THREE.CanvasTexture(c);
  tex.colorSpace = THREE.SRGBColorSpace;
  return tex;
}

function createTileGridTexture(bg = "#edf4f8", lineColor = "#adc7d4") {
  const c = document.createElement("canvas");
  c.width = 128;
  c.height = 128;
  const ctx = c.getContext("2d");
  ctx.fillStyle = bg;
  ctx.fillRect(0, 0, 128, 128);
  ctx.strokeStyle = lineColor;
  ctx.lineWidth = 2;
  for (let i = 0; i <= 128; i += 16) {
    ctx.beginPath();
    ctx.moveTo(i, 0);
    ctx.lineTo(i, 128);
    ctx.stroke();
    ctx.beginPath();
    ctx.moveTo(0, i);
    ctx.lineTo(128, i);
    ctx.stroke();
  }
  const tex = new THREE.CanvasTexture(c);
  tex.colorSpace = THREE.SRGBColorSpace;
  return tex;
}

const NEWS_BROADCASTS = [
  { lang: "EN", header: "CH-04 WORLD NEWS", line1: "TRAFFIC & WEATHER ALERT", line2: "TEMP: -3.8C // NO SIGNALS", accent: "#2268b8" },
  { lang: "JP", header: "NHK-BACKROOMS 臨時", line1: "地下連絡網 気温マイナス3.8度", line2: "外部通信途絶 // 換気稼働中", accent: "#b82e2e" },
  { lang: "ES", header: "TELE-NEXUS 24H", line1: "BOLETIN METEOROLOGICO", line2: "SIN TRANSITO EN TUNEL", accent: "#b8741e" },
  { lang: "FR", header: "INFO MONDE DIRECT", line1: "METEO SOUTERRAINE -3.8C", line2: "SECTEUR CENTRAL STABLE", accent: "#276e8c" },
  { lang: "DE", header: "TAGESSCHAU AKTUELL", line1: "TUNNELNETZ TEMPERATUR", line2: "LUEFTUNGSSYSTEM AKTIV", accent: "#3d6b42" },
  { lang: "RU", header: "НОВОСТИ КАНАЛ-1", line1: "СВОДКА ПО ТОННЕЛЯМ", line2: "СВЯЗЬ ОТСУТСТВУЕТ", accent: "#6d3b87" },
];

function paintNewsBroadcastCanvas(canvas, idx) {
  const b = NEWS_BROADCASTS[idx % NEWS_BROADCASTS.length];
  const ctx = canvas.getContext("2d");
  ctx.fillStyle = "#101622";
  ctx.fillRect(0, 0, 256, 128);
  ctx.fillStyle = b.accent;
  ctx.fillRect(0, 0, 256, 30);
  ctx.fillStyle = "#ffffff";
  ctx.font = "bold 16px monospace";
  ctx.textAlign = "left";
  ctx.textBaseline = "middle";
  ctx.fillText(`[${b.lang}] ${b.header}`, 10, 15);
  ctx.fillStyle = "#dce8f5";
  ctx.font = "bold 14px sans-serif";
  ctx.fillText(b.line1, 10, 56);
  ctx.fillStyle = "#96adc4";
  ctx.font = "12px monospace";
  ctx.fillText(b.line2, 10, 82);
  ctx.fillStyle = "#c92b2b";
  ctx.fillRect(0, 104, 256, 24);
  ctx.fillStyle = "#ffffff";
  ctx.font = "bold 12px monospace";
  ctx.fillText("LIVE BROADCAST // HUB MONITORING", 10, 116);
}

// ---------------------------------------------------------------------------
// Dual PBR Texture Loader (AI Albedo + Normal + Roughness + Canvas Fallback)
// ---------------------------------------------------------------------------
class LevelMaterialCache {
  constructor(onStatusChange) {
    this.loader = new THREE.TextureLoader();
    this.cache = new Map();
    this.shared = null;
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
      const repeat =
        slot === "floor" && (levelId === "the_hub" || levelId === "level_1")
          ? [10, 10]
          : slot === "floor" || slot === "ceiling"
            ? [8, 8]
            : [1, 1];

      const procTex = new THREE.CanvasTexture(canvas);
      procTex.wrapS = isSinglePanel ? THREE.ClampToEdgeWrapping : THREE.RepeatWrapping;
      procTex.wrapT = isSinglePanel ? THREE.ClampToEdgeWrapping : THREE.RepeatWrapping;
      procTex.anisotropy = maxAniso;
      procTex.colorSpace = THREE.SRGBColorSpace;
      procTex.repeat.set(repeat[0], repeat[1]);

      const mat = new THREE.MeshStandardMaterial({
        map: procTex,
        roughness: slot === "floor" ? 0.88 : slot === "door" ? 0.45 : 0.85,
        metalness: slot === "door" && levelId !== "level_0" ? 0.62 : 0.05,
        envMapIntensity:
          slot === "door"
            ? 0.9
            : levelId === "the_hub" && slot === "floor"
              ? 1.15
              : levelId === "level_1" && slot === "floor"
                ? 1.05
                : 0.45,
      });
      if (spec?.normalScale) {
        mat.normalScale = new THREE.Vector2(spec.normalScale, spec.normalScale);
      }

      materials[slot] = mat;
      pendingLoads.push({
        slot,
        spec,
        mat,
        procTex,
        isSinglePanel,
        repeat,
        candidates: resolveTextureCandidates(levelId, slot),
      });
    }

    const ceilingEmissiveMat = new THREE.MeshBasicMaterial({
      color: new THREE.Color(levelData.environment.lightColor),
    });
    const glitchMat = new THREE.MeshStandardMaterial({
      map: materials.wall.map,
      color: 0xc2b278,
      emissive: 0x161206,
      emissiveIntensity: 0.16,
      transparent: true,
      opacity: 0.94,
      roughness: 0.72,
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
          repeat: item.repeat,
          onUpgrade: item.slot === "wall" ? (tex) => {
            glitchMat.map = tex;
            glitchMat.needsUpdate = true;
          } : null,
        }
      );

      // Load paired tangent-space Normal Map
      if (item.spec?.normalPath) {
        this._loadAuxMap(item.spec.normalPath, {
          isSinglePanel: item.isSinglePanel,
          anisotropy: maxAniso,
          repeat: item.repeat,
          onLoaded: (nTex) => {
            item.mat.normalMap = nTex;
            item.mat.needsUpdate = true;
            if (item.slot === "wall") {
              glitchMat.normalMap = nTex;
              glitchMat.needsUpdate = true;
            }
          },
        });
      }

      // Load paired Roughness Map
      if (item.spec?.roughnessPath) {
        this._loadAuxMap(item.spec.roughnessPath, {
          isSinglePanel: item.isSinglePanel,
          anisotropy: maxAniso,
          repeat: item.repeat,
          onLoaded: (rTex) => {
            item.mat.roughnessMap = rTex;
            item.mat.roughness = 1.0; // modulated cleanly by roughnessMap
            item.mat.needsUpdate = true;
          },
        });
      }
    }

    const pipeMat = new THREE.MeshStandardMaterial({
      color: levelId === "the_hub" ? 0x8b9098 : 0x6b3b24,
      roughness: 0.42,
      metalness: 0.72,
      envMapIntensity: 0.9,
    });
    const stairsMat = new THREE.MeshStandardMaterial({
      color: 0x5c6066,
      roughness: 0.82,
      metalness: 0.18,
    });

    if (!this.shared) {
      const loadSharedPbr = (mat, albedoUrl, normalUrl, roughUrl, { repeat = [1, 1], slotName = "shared" } = {}) => {
        this._tryLoadCandidates(
          [albedoUrl],
          slotName,
          mat,
          mat.map,
          { total: 1, wikiLoaded: 0, proceduralFallback: 1 },
          { isSinglePanel: false, anisotropy: maxAniso, repeat }
        );
        this._loadAuxMap(normalUrl, {
          isSinglePanel: false,
          anisotropy: maxAniso,
          repeat,
          onLoaded: (nTex) => {
            mat.normalMap = nTex;
            mat.needsUpdate = true;
          },
        });
        this._loadAuxMap(roughUrl, {
          isSinglePanel: false,
          anisotropy: maxAniso,
          repeat,
          onLoaded: (rTex) => {
            mat.roughnessMap = rTex;
            mat.roughness = 1.0;
            mat.needsUpdate = true;
          },
        });
      };

      const makeFallbackTex = (style, seedOffset, repeat = [1, 1]) => {
        const c = createProceduralTextureCanvas(style, 256, 256, seedOffset);
        const t = new THREE.CanvasTexture(c);
        t.wrapS = THREE.RepeatWrapping;
        t.wrapT = THREE.RepeatWrapping;
        t.repeat.set(repeat[0], repeat[1]);
        t.colorSpace = THREE.SRGBColorSpace;
        return t;
      };

      const hubConcreteMat = new THREE.MeshStandardMaterial({
        map: makeFallbackTex("level1_concrete", 777, [6, 5]),
        color: 0xd0ba94,
        roughness: 0.92,
        metalness: 0.06,
        normalScale: new THREE.Vector2(1.1, 1.1),
        side: THREE.BackSide,
      });
      loadSharedPbr(
        hubConcreteMat,
        "./assets/textures/tex_l1_concrete_wall.jpg",
        "./assets/textures/tex_l1_concrete_wall_nrm.jpg",
        "./assets/textures/tex_l1_concrete_wall_rgh.jpg",
        { repeat: [6, 5], slotName: "hub_concrete" }
      );

      const hubRoadMat = new THREE.MeshStandardMaterial({
        map: makeFallbackTex("hub_road", 778, [1, 1]),
        color: 0xffffff,
        roughness: 0.78,
        metalness: 0.06,
        envMapIntensity: 1.25,
        normalScale: new THREE.Vector2(1.35, 1.35),
        polygonOffset: true,
        polygonOffsetFactor: -1,
        polygonOffsetUnits: -1,
      });
      loadSharedPbr(
        hubRoadMat,
        "./assets/textures/tex_hub_asphalt.jpg",
        "./assets/textures/tex_hub_asphalt_nrm.jpg",
        "./assets/textures/tex_hub_asphalt_rgh.jpg",
        { repeat: [1, 1], slotName: "hub_road" }
      );

      const sidewalkMat = new THREE.MeshStandardMaterial({
        map: makeFallbackTex("level1_concrete", 779, [1, 1]),
        color: 0xd8d2c6,
        roughness: 0.88,
        metalness: 0.04,
        envMapIntensity: 0.55,
        normalScale: new THREE.Vector2(1.15, 1.15),
      });
      loadSharedPbr(
        sidewalkMat,
        "./assets/textures/tex_hub_sidewalk.jpg",
        "./assets/textures/tex_hub_sidewalk_nrm.jpg",
        "./assets/textures/tex_hub_sidewalk_rgh.jpg",
        { repeat: [1, 1], slotName: "hub_sidewalk" }
      );

      const l2WoodMat = new THREE.MeshStandardMaterial({
        map: makeFallbackTex("level1_concrete", 888, [1, 1]),
        color: 0xffffff,
        roughness: 0.9,
        metalness: 0.04,
        normalScale: new THREE.Vector2(1.1, 1.1),
      });
      loadSharedPbr(
        l2WoodMat,
        "./assets/textures/tex_l2_wood_wall.jpg",
        "./assets/textures/tex_l2_wood_wall_nrm.jpg",
        "./assets/textures/tex_l2_wood_wall_rgh.jpg",
        { repeat: [1, 1], slotName: "l2_wood" }
      );

      const rustPipeMat = new THREE.MeshStandardMaterial({
        map: makeFallbackTex("level2_rust_pipe", 999, [1, 1]),
        color: 0xffffff,
        roughness: 0.78,
        metalness: 0.45,
        envMapIntensity: 0.9,
        normalScale: new THREE.Vector2(1.15, 1.15),
      });
      loadSharedPbr(
        rustPipeMat,
        "./assets/textures/tex_pipe_rust.jpg",
        "./assets/textures/tex_pipe_rust_nrm.jpg",
        "./assets/textures/tex_pipe_rust_rgh.jpg",
        { repeat: [1, 1], slotName: "rust_pipe" }
      );

      const makeSteelPipeMat = (colorHex, roughness = 0.44, metalness = 0.68) =>
        new THREE.MeshStandardMaterial({
          map: makeFallbackTex("hub_door", 512, [1, 1]),
          color: colorHex,
          roughness,
          metalness,
          envMapIntensity: 1.05,
          normalScale: new THREE.Vector2(0.95, 0.95),
        });

      const darkPipeMat = makeSteelPipeMat(0x50565d, 0.44, 0.72);
      const hubPipeMat = makeSteelPipeMat(0x9ca4ad, 0.4, 0.74);
      const l1OrangePipeMat = makeSteelPipeMat(0xd06236, 0.48, 0.52);
      const l1GreyPipeMat = makeSteelPipeMat(0xa4acb5, 0.46, 0.6);
      const steelPipeMats = [darkPipeMat, hubPipeMat, l1OrangePipeMat, l1GreyPipeMat];

      this.loader.load("./assets/textures/tex_pipe_metal.jpg", (tex) => {
        tex.wrapS = THREE.RepeatWrapping;
        tex.wrapT = THREE.RepeatWrapping;
        tex.anisotropy = maxAniso;
        tex.colorSpace = THREE.SRGBColorSpace;
        for (const pm of steelPipeMats) {
          const old = pm.map;
          pm.map = tex;
          pm.needsUpdate = true;
          if (old && old !== tex) old.dispose();
        }
      });
      this._loadAuxMap("./assets/textures/tex_pipe_metal_nrm.jpg", {
        isSinglePanel: false,
        anisotropy: maxAniso,
        repeat: [1, 1],
        onLoaded: (nTex) => {
          for (const pm of steelPipeMats) {
            pm.normalMap = nTex;
            pm.needsUpdate = true;
          }
        },
      });
      this._loadAuxMap("./assets/textures/tex_pipe_metal_rgh.jpg", {
        isSinglePanel: false,
        anisotropy: maxAniso,
        repeat: [1, 1],
        onLoaded: (rTex) => {
          for (const pm of steelPipeMats) {
            pm.roughnessMap = rTex;
            pm.roughness = 1.0;
            pm.needsUpdate = true;
          }
        },
      });

      const hydrolitisPuddleMat = new THREE.MeshStandardMaterial({
        map: createPuddleFallbackTexture(false),
        roughness: 0.06,
        metalness: 0.06,
        envMapIntensity: 2.2,
        normalScale: new THREE.Vector2(0.28, 0.28),
        transparent: true,
        depthWrite: false,
        polygonOffset: true,
        polygonOffsetFactor: -2,
        polygonOffsetUnits: -2,
      });
      const falsePuddleMat = new THREE.MeshStandardMaterial({
        map: createPuddleFallbackTexture(true),
        roughness: 0.22,
        metalness: 0.04,
        envMapIntensity: 1.1,
        normalScale: new THREE.Vector2(0.2, 0.2),
        transparent: true,
        depthWrite: false,
        polygonOffset: true,
        polygonOffsetFactor: -3,
        polygonOffsetUnits: -3,
      });
      this.loader.load("./assets/textures/tex_puddle_hydrolitis.png", (tex) => {
        tex.wrapS = THREE.ClampToEdgeWrapping;
        tex.wrapT = THREE.ClampToEdgeWrapping;
        tex.anisotropy = maxAniso;
        tex.colorSpace = THREE.SRGBColorSpace;
        const old = hydrolitisPuddleMat.map;
        hydrolitisPuddleMat.map = tex;
        hydrolitisPuddleMat.needsUpdate = true;
        if (old) old.dispose();
      });
      this.loader.load("./assets/textures/tex_puddle_false.png", (tex) => {
        tex.wrapS = THREE.ClampToEdgeWrapping;
        tex.wrapT = THREE.ClampToEdgeWrapping;
        tex.anisotropy = maxAniso;
        tex.colorSpace = THREE.SRGBColorSpace;
        const old = falsePuddleMat.map;
        falsePuddleMat.map = tex;
        falsePuddleMat.needsUpdate = true;
        if (old) old.dispose();
      });
      this._loadAuxMap("./assets/textures/tex_puddle_nrm.jpg", {
        isSinglePanel: true,
        anisotropy: maxAniso,
        repeat: [1, 1],
        onLoaded: (nTex) => {
          hydrolitisPuddleMat.normalMap = nTex;
          hydrolitisPuddleMat.needsUpdate = true;
          falsePuddleMat.normalMap = nTex;
          falsePuddleMat.needsUpdate = true;
        },
      });

      const makeHubLeafMat = (tintHex) => {
        const m = new THREE.MeshStandardMaterial({
          map: makeFallbackTex("hub_door", 404, [1, 1]),
          color: tintHex,
          roughness: 0.48,
          metalness: 0.58,
          envMapIntensity: 0.95,
          normalScale: new THREE.Vector2(1.0, 1.0),
        });
        loadSharedPbr(
          m,
          "./assets/textures/tex_metal_door.jpg",
          "./assets/textures/tex_metal_door_nrm.jpg",
          "./assets/textures/tex_metal_door_rgh.jpg",
          { repeat: [1, 1], slotName: "hub_door_leaf" }
        );
        return m;
      };

      const newsTvCanvas = document.createElement("canvas");
      newsTvCanvas.width = 256;
      newsTvCanvas.height = 128;
      paintNewsBroadcastCanvas(newsTvCanvas, 0);
      const newsTvTex = new THREE.CanvasTexture(newsTvCanvas);
      newsTvTex.colorSpace = THREE.SRGBColorSpace;

      const hazardTex = createHazardStripeTexture();
      hazardTex.anisotropy = maxAniso;
      const glowOrange = createGlowSpriteTexture("#ff9c47");

      this.shared = {
        hubConcreteMat,
        hubRoadMat,
        sidewalkMat,
        l2WoodMat,
        rustPipeMat,
        darkPipeMat,
        hubPipeMat,
        l1OrangePipeMat,
        l1GreyPipeMat,
        hydrolitisPuddleMat,
        falsePuddleMat,
        newsTvCanvas,
        newsTvTex,
        newsTvMat: new THREE.MeshBasicMaterial({ map: newsTvTex }),
        hubDoorLeafMats: {
          level_0: makeHubLeafMat(0xe6da9e),
          level_1: makeHubLeafMat(0xaeb6be),
          level_2: makeHubLeafMat(0x8c7b6e),
        },
        goldPhiMat: new THREE.MeshStandardMaterial({ color: 0xd9a832, roughness: 0.25, metalness: 0.88, envMapIntensity: 1.3 }),
        tileL37Mat: new THREE.MeshStandardMaterial({ map: createTileGridTexture("#eef6fa", "#b8d0dc"), roughness: 0.35, metalness: 0.1 }),
        neonL154Mat: new THREE.MeshStandardMaterial({ color: 0x1d1a2c, emissive: 0x7c2ae8, emissiveIntensity: 0.35, roughness: 0.35, metalness: 0.6 }),
        carpetIndentMat: new THREE.MeshStandardMaterial({ color: 0x5e5028, roughness: 0.96, transparent: true, opacity: 0.42, polygonOffset: true, polygonOffsetFactor: -1, polygonOffsetUnits: -1 }),
        rebarMat: new THREE.MeshStandardMaterial({ color: 0x5c2f1b, roughness: 0.65, metalness: 0.7 }),
        maintBlackDoorMat: new THREE.MeshStandardMaterial({ color: 0x101214, roughness: 0.38, metalness: 0.78, envMapIntensity: 0.9 }),
        warehouseWoodDoorMat: new THREE.MeshStandardMaterial({ color: 0x6b4528, roughness: 0.82, metalness: 0.04 }),
        warehousePinkDoorMat: new THREE.MeshStandardMaterial({ color: 0xb98d96, roughness: 0.84, metalness: 0.04 }),
        warehouseWhiteDoorMat: new THREE.MeshStandardMaterial({ color: 0xd2d4d1, roughness: 0.8, metalness: 0.04 }),
        alcoveVoidMat: new THREE.MeshStandardMaterial({ color: 0x100c08, roughness: 0.95 }),
        crawlWireMat: new THREE.MeshBasicMaterial({ color: 0x141418 }),
        crawlSparkMat: new THREE.MeshBasicMaterial({ color: 0x6ce5ff }),
        manilaLightPoolMat: new THREE.MeshBasicMaterial({
          map: glowOrange,
          transparent: true,
          opacity: 0.22,
          blending: THREE.AdditiveBlending,
          depthWrite: false,
        }),
        hazardStripeMat: new THREE.MeshStandardMaterial({ map: hazardTex, roughness: 0.72 }),
        baseboardMat: new THREE.MeshStandardMaterial({ color: 0x8d8147, roughness: 0.78 }),
        outletMat: new THREE.MeshStandardMaterial({ color: 0xded6b5, roughness: 0.55 }),
        socketDarkMat: new THREE.MeshBasicMaterial({ color: 0x1b1a16 }),
        crownTrimMat: new THREE.MeshStandardMaterial({ color: 0x9c6e46, roughness: 0.65 }),
        woodMat: new THREE.MeshStandardMaterial({ color: 0x5c3d24, roughness: 0.72 }),
        paperMat: new THREE.MeshStandardMaterial({ color: 0xeae2c8, roughness: 0.9 }),
        brassMat: new THREE.MeshStandardMaterial({ color: 0xd4a442, roughness: 0.3, metalness: 0.88 }),
        pillarBandMat: new THREE.MeshStandardMaterial({ color: 0x6e2c36, roughness: 0.72 }),
        hazardYellowMat: new THREE.MeshStandardMaterial({ color: 0xd9a520, roughness: 0.6 }),
        barrierOrangeMat: new THREE.MeshStandardMaterial({ color: 0xd95826, roughness: 0.65 }),
        roadLineMat: new THREE.MeshBasicMaterial({ color: 0xe6e3d8, polygonOffset: true, polygonOffsetFactor: -2, polygonOffsetUnits: -2 }),
        curbRedGlowMat: new THREE.MeshBasicMaterial({ color: 0xff3b2f }),
        gantryMat: new THREE.MeshStandardMaterial({ color: 0x17181c, roughness: 0.45, metalness: 0.75 }),
        warnSignMat: new THREE.MeshBasicMaterial({ map: createSignTexture("TRIANGLE_WARN") }),
        redXSignMat: new THREE.MeshBasicMaterial({ map: createSignTexture("RED_X") }),
        blueExitSignMat: new THREE.MeshBasicMaterial({ map: createSignTexture("BLUE_EXIT") }),
        exitSignMat: new THREE.MeshBasicMaterial({ map: createSignTexture("TEXT", "EXIT", "#0d381e", "#52ff91") }),
        fireExitSignMat: new THREE.MeshBasicMaterial({ map: createSignTexture("TEXT", "FIRE EXIT", "#3a100c", "#ff775e") }),
        lorePhiSignMat: new THREE.MeshBasicMaterial({ map: createSignTexture("TEXT", "PHI (Φ)", "#45330a", "#ffd966") }),
        lore37SignMat: new THREE.MeshBasicMaterial({ map: createSignTexture("TEXT", "LVL 37", "#193647", "#d6f2ff") }),
        lore154SignMat: new THREE.MeshBasicMaterial({ map: createSignTexture("TEXT", "LVL 154", "#23123a", "#e49eff") }),
        doorLabelMats: {
          level_0: new THREE.MeshBasicMaterial({ map: createSignTexture("TEXT", "LEVEL 0", "#3a3216", "#ffe375") }),
          level_1: new THREE.MeshBasicMaterial({ map: createSignTexture("TEXT", "LEVEL 1", "#232629", "#d8e0e8") }),
          level_2: new THREE.MeshBasicMaterial({ map: createSignTexture("TEXT", "LEVEL 2", "#331a0f", "#ff9e66") }),
          manila_room: new THREE.MeshBasicMaterial({ map: createSignTexture("TEXT", "MANILA", "#332211", "#ffc375") }),
        },
        zoneStencilMatCache: new Map(),
        fakeExitSignMatCache: new Map(),
        greenExitMat: new THREE.MeshBasicMaterial({ color: 0x22d665 }),
        fanBodyMat: new THREE.MeshStandardMaterial({ color: 0x32363d, roughness: 0.4, metalness: 0.8 }),
        valveRedMat: new THREE.MeshStandardMaterial({ color: 0xb82924, roughness: 0.42, metalness: 0.4 }),
        extinguisherRedMat: new THREE.MeshStandardMaterial({ color: 0xc4221d, roughness: 0.35, metalness: 0.55 }),
        tireMat: new THREE.MeshStandardMaterial({ color: 0x16171a, roughness: 0.92 }),
        rimMat: new THREE.MeshStandardMaterial({ color: 0xb4bac2, roughness: 0.28, metalness: 0.9 }),
        windshieldMat: new THREE.MeshStandardMaterial({ color: 0x141d26, roughness: 0.12, metalness: 0.85, envMapIntensity: 1.3 }),
        headlightMat: new THREE.MeshBasicMaterial({ color: 0xdbe3eb }),
        taillightMat: new THREE.MeshBasicMaterial({ color: 0x801515 }),
        carColors: [
          new THREE.MeshStandardMaterial({ color: 0x7a2626, roughness: 0.32, metalness: 0.55, envMapIntensity: 1.1 }),
          new THREE.MeshStandardMaterial({ color: 0x243e63, roughness: 0.32, metalness: 0.55, envMapIntensity: 1.1 }),
          new THREE.MeshStandardMaterial({ color: 0xd1d4d9, roughness: 0.36, metalness: 0.45, envMapIntensity: 1.0 }),
          new THREE.MeshStandardMaterial({ color: 0x202226, roughness: 0.32, metalness: 0.55, envMapIntensity: 1.1 }),
        ],
        glowTextures: {
          warm: createGlowSpriteTexture("#fff0ad"),
          orange: glowOrange,
          cool: createGlowSpriteTexture("#dceeff"),
          cold: createGlowSpriteTexture("#e6f5ea"),
          amber: createGlowSpriteTexture("#ffbe55"),
        },
        tintMatCache: new Map(),
        haloMatCache: new Map(),
      };
    }

    const entry = {
      ...materials,
      ceilingEmissiveMat,
      glitchMat,
      puddleMat: this.shared.hydrolitisPuddleMat,
      pipeMat: levelId === "the_hub" ? this.shared.hubPipeMat : pipeMat,
      stairsMat,
      shared: this.shared,
      status,
    };
    this.cache.set(levelId, entry);
    return entry;
  }

  _loadAuxMap(url, { isSinglePanel, anisotropy, repeat, onLoaded }) {
    this.loader.load(
      url,
      (tex) => {
        tex.wrapS = isSinglePanel ? THREE.ClampToEdgeWrapping : THREE.RepeatWrapping;
        tex.wrapT = isSinglePanel ? THREE.ClampToEdgeWrapping : THREE.RepeatWrapping;
        tex.anisotropy = anisotropy || 4;
        tex.colorSpace = THREE.NoColorSpace;
        if (repeat) tex.repeat.set(repeat[0], repeat[1]);
        onLoaded(tex);
      },
      undefined,
      () => {
        // Silent fallback when offline
      }
    );
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
          if (opts.repeat) {
            tex.repeat.set(opts.repeat[0], opts.repeat[1]);
          } else if (slot === "floor" || slot === "ceiling") {
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
// Three.js Scene, PBR Reflections & Shadow-Enabled Renderer Setup
// ---------------------------------------------------------------------------
const renderer = new THREE.WebGLRenderer({ antialias: true, powerPreference: "high-performance" });
renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, 1.5));
renderer.setSize(window.innerWidth, window.innerHeight);
renderer.outputColorSpace = THREE.SRGBColorSpace;
renderer.toneMapping = THREE.ACESFilmicToneMapping;
renderer.toneMappingExposure = 1.08;
renderer.shadowMap.enabled = true;
renderer.shadowMap.type = THREE.PCFSoftShadowMap;
renderer.shadowMap.autoUpdate = false;
ui.viewport.appendChild(renderer.domElement);

const scene = new THREE.Scene();

const LEVEL_PMREM_PALETTES = {
  level_0: { bg: 0x685f33, top: 0xf7ffe8, side: 0xbca856 },
  manila_room: { bg: 0x2b1b0e, top: 0xd97d36, side: 0x7d5836 },
  level_1: { bg: 0x292e32, top: 0xe6f0fa, side: 0x596066 },
  the_hub: { bg: 0x1b1206, top: 0xffb43b, side: 0x6e471a },
  level_2: { bg: 0x0c100d, top: 0xb0c2b5, side: 0x252d27 },
};

const levelEnvTargets = new Map();

function getLevelEnvironmentTexture(levelId) {
  if (levelEnvTargets.has(levelId)) {
    return levelEnvTargets.get(levelId).texture;
  }
  const pal = LEVEL_PMREM_PALETTES[levelId] || LEVEL_PMREM_PALETTES.level_0;
  const pmrem = new THREE.PMREMGenerator(renderer);
  const envScene = new THREE.Scene();
  envScene.background = new THREE.Color(pal.bg);
  const topPanel = new THREE.Mesh(
    new THREE.PlaneGeometry(18, 18),
    new THREE.MeshBasicMaterial({ color: pal.top, side: THREE.DoubleSide })
  );
  topPanel.position.set(0, 6, 0);
  topPanel.rotation.x = Math.PI / 2;
  const sidePanel = new THREE.Mesh(
    new THREE.PlaneGeometry(18, 8),
    new THREE.MeshBasicMaterial({ color: pal.side, side: THREE.DoubleSide })
  );
  sidePanel.position.set(0, 0, -8);
  envScene.add(topPanel, sidePanel);
  const envRT = pmrem.fromScene(envScene, 0.04);
  levelEnvTargets.set(levelId, envRT);
  topPanel.geometry.dispose();
  topPanel.material.dispose();
  sidePanel.geometry.dispose();
  sidePanel.material.dispose();
  pmrem.dispose();
  return envRT.texture;
}

scene.environment = getLevelEnvironmentTexture("level_0");
scene.environmentIntensity = 0.55;

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

// Shadow-casting player flashlight attached to camera (shadows only computed when ON)
const flashlight = new THREE.SpotLight(0xfff4d6, 4.0, 28, Math.PI * 0.24, 0.48, 1.35);
flashlight.position.set(0.14, -0.1, 0);
flashlight.castShadow = false;
flashlight.shadow.mapSize.set(512, 512);
flashlight.shadow.camera.near = 0.2;
flashlight.shadow.camera.far = 26;
flashlight.shadow.bias = -0.0008;
const flashlightTarget = new THREE.Object3D();
flashlightTarget.position.set(0, -0.12, -8);
camera.add(flashlight);
camera.add(flashlightTarget);
flashlight.target = flashlightTarget;
flashlight.visible = false;

// Fixed 6-PointLight pooled rig (allocated once to prevent shader recompiles)
const pointLightPool = Array.from({ length: POINT_LIGHT_POOL_SIZE }, () => {
  const pt = new THREE.PointLight(0xffffff, 0, 18, 1.5);
  scene.add(pt);
  return pt;
});

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
    y: STAND_EYE_HEIGHT,
    feetY: 0,
    vy: 0,
    eyeHeight: STAND_EYE_HEIGHT,
    grounded: true,
    crouching: false,
    landDip: 0,
    hazardDip: 0,
    knockbackVx: 0,
    knockbackVz: 0,
    falsePuddleCooldown: 0,
    z: 1.5,
    yaw: -Math.PI * 0.25,
    pitch: 0,
    bobPhase: 0,
    stepAccum: 0,
  },
  flashlightOn: false,
  hasLevelKey: false,
  hubSequenceStep: "none",
  blackoutActive: false,
  blackoutTimer: 0,
  manilaDwellSec: 0,
  manilaWarnStep: 0,
  tvChannelIdx: 0,
  tvTimer: 0,
  l2TremorTimer: 0,
  l2TremorActiveTimer: 0,
  l0ShiftTimer: 0,
  l0ShiftDistAccum: 0,
  l0ShiftLogCooldown: 0,
  l0LastChunkKey: "",
  hudVisible: true,
  camcorderVisible: true,
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
// Chunk Mesh Builder & Strict Disposal (InstancedMesh Batched)
// ---------------------------------------------------------------------------
function disposeChunkGroup(group) {
  group.traverse((obj) => {
    if (obj.isInstancedMesh) {
      obj.dispose();
    }
    if (obj.isMesh && obj.geometry && !obj.userData?.sharedGeo && !obj.geometry.userData?.sharedGeo) {
      obj.geometry.dispose();
    }
    if (obj.isSprite && obj.material && !obj.material.userData?.sharedMat) {
      obj.material.dispose();
    }
    if (obj.isLineSegments && obj.geometry) {
      obj.geometry.dispose();
      if (obj.material) obj.material.dispose();
    }
    if (obj.userData && obj.userData.isVentRotor) {
      const rIdx = ventFanRotors.indexOf(obj);
      if (rIdx !== -1) ventFanRotors.splice(rIdx, 1);
    }
  });
  scene.remove(group);
}

function updateChunkVisibility() {
  const { cx: pcx, cz: pcz } = chunkManager.worldToChunk(state.player.x, state.player.z);
  const maxVisRadius =
    state.currentLevelId === "level_0" ||
    state.currentLevelId === "level_2" ||
    state.currentLevelId === "manila_room"
      ? 1
      : 2;
  for (const group of chunkMeshes.values()) {
    const dx = Math.abs(group.userData.cx - pcx);
    const dz = Math.abs(group.userData.cz - pcz);
    group.visible = Math.max(dx, dz) <= maxVisRadius;
  }
}

function getSharedHaloMat(shared, levelId) {
  if (!shared.haloMatCache.has(levelId)) {
    const glowTex =
      levelId === "manila_room"
        ? shared.glowTextures.orange
        : levelId === "the_hub"
        ? shared.glowTextures.amber
        : levelId === "level_1"
        ? shared.glowTextures.cool
        : levelId === "level_2"
        ? shared.glowTextures.cold
        : shared.glowTextures.warm;
    const opacity =
      levelId === "the_hub"
        ? 0.56
        : levelId === "manila_room"
        ? 0.48
        : levelId === "level_2"
        ? 0.28
        : 0.24;
    const mat = new THREE.SpriteMaterial({
      map: glowTex,
      transparent: true,
      opacity,
      blending: THREE.AdditiveBlending,
      depthWrite: false,
    });
    mat.userData = { ...(mat.userData || {}), sharedMat: true };
    shared.haloMatCache.set(levelId, mat);
  }
  return shared.haloMatCache.get(levelId);
}

function getSharedTintMat(shared, hexColor) {
  if (!shared.tintMatCache.has(hexColor)) {
    shared.tintMatCache.set(hexColor, new THREE.MeshBasicMaterial({ color: hexColor }));
  }
  return shared.tintMatCache.get(hexColor);
}

function getZoneStencilMat(shared, zoneLabel) {
  const key = zoneLabel || "F";
  if (!shared.zoneStencilMatCache.has(key)) {
    shared.zoneStencilMatCache.set(
      key,
      new THREE.MeshStandardMaterial({
        map: createSignTexture("TEXT", key, "#9ca0a4", "#1b1d20"),
        roughness: 0.85,
      })
    );
  }
  return shared.zoneStencilMatCache.get(key);
}

function getFakeExitSignMat(shared, signLang = "EXIT") {
  const key = signLang || "EXIT";
  if (!shared.fakeExitSignMatCache.has(key)) {
    shared.fakeExitSignMatCache.set(
      key,
      new THREE.MeshBasicMaterial({
        map: createSignTexture("TEXT", key, "#0d381e", "#52ff91"),
      })
    );
  }
  return shared.fakeExitSignMatCache.get(key);
}

function buildChunkGroup(chunkData) {
  const levelData = getLevelData(chunkData.levelId);
  const mats = materialCache.getMaterials(chunkData.levelId);
  const s = mats.shared;
  const group = new THREE.Group();
  group.name = chunkData.key;
  group.userData = { cx: chunkData.cx, cz: chunkData.cz };
  const batch = new ChunkInstanceBatcher();

  const h = levelData.environment.ceilingHeight;
  const originX = chunkData.cx * CHUNK_WORLD_SIZE;
  const originZ = chunkData.cz * CHUNK_WORLD_SIZE;
  const centerX = originX + CHUNK_WORLD_SIZE * 0.5;
  const centerZ = originZ + CHUNK_WORLD_SIZE * 0.5;
  const hasHubArch =
    chunkData.levelId === "the_hub" &&
    chunkData.props.some((p) => p.kind === "TUNNEL_ARCH");

  // Floor & Ceiling (shared PlaneGeometry)
  const floorMesh = new THREE.Mesh(SHARED_GEOS.plane, mats.floor);
  floorMesh.scale.set(CHUNK_WORLD_SIZE, CHUNK_WORLD_SIZE, 1);
  floorMesh.rotation.x = -Math.PI / 2;
  floorMesh.position.set(centerX, 0, centerZ);
  floorMesh.receiveShadow = true;
  group.add(floorMesh);

  if (!hasHubArch) {
    const ceilMesh = new THREE.Mesh(SHARED_GEOS.plane, mats.ceiling);
    ceilMesh.scale.set(CHUNK_WORLD_SIZE, CHUNK_WORLD_SIZE, 1);
    ceilMesh.rotation.x = Math.PI / 2;
    ceilMesh.position.set(centerX, h, centerZ);
    group.add(ceilMesh);
  }

  // Walls, Sculpted Arched Colonnades, Parking Pillars, High-Poly Sedans
  for (const w of chunkData.walls) {
    const width = w.maxX - w.minX;
    const depth = w.maxZ - w.minZ;
    const cx = (w.minX + w.maxX) * 0.5;
    const cz = (w.minZ + w.maxZ) * 0.5;

    if (w.cellType === CELL_TYPES.CAR) {
      const bodyMat = s.carColors[(w.lx + w.lz) % s.carColors.length];
      const carGroup = new THREE.Group();
      carGroup.position.set(cx, 0, cz);
      const gridRows = chunkData.grid;
      const adjWall =
        (w.lx > 0 && SOLID_CELL_TYPES.has(gridRows[w.lz]?.[w.lx - 1])) ||
        (w.lx < CHUNK_CELLS - 1 && SOLID_CELL_TYPES.has(gridRows[w.lz]?.[w.lx + 1])) ||
        (w.lz > 0 && SOLID_CELL_TYPES.has(gridRows[w.lz - 1]?.[w.lx])) ||
        (w.lz < CHUNK_CELLS - 1 && SOLID_CELL_TYPES.has(gridRows[w.lz + 1]?.[w.lx]));
      carGroup.rotation.y = adjWall
        ? (((w.lx + w.lz) % 2 === 0 ? 1 : -1) * 0.26)
        : ((w.lx + w.lz) % 2 === 0 ? 0 : Math.PI);

      const carBody = new THREE.Mesh(createSedanBodyGeometry(width * 0.96, depth * 0.72), bodyMat);
      carBody.castShadow = true;
      carBody.receiveShadow = true;
      carGroup.add(carBody);

      const glassCabin = new THREE.Mesh(
        new THREE.BoxGeometry(width * 0.42, 0.36, depth * 0.68),
        s.windshieldMat
      );
      glassCabin.position.set(-width * 0.05, 0.98, 0);
      carGroup.add(glassCabin);

      for (const [wx, wz] of [
        [-width * 0.3, -depth * 0.36],
        [width * 0.3, -depth * 0.36],
        [-width * 0.3, depth * 0.36],
        [width * 0.3, depth * 0.36],
      ]) {
        const tire = new THREE.Mesh(new THREE.CylinderGeometry(0.24, 0.24, 0.17, 16), s.tireMat);
        tire.rotation.x = Math.PI / 2;
        tire.position.set(wx, 0.24, wz);
        tire.castShadow = true;
        carGroup.add(tire);

        const rim = new THREE.Mesh(new THREE.CylinderGeometry(0.14, 0.14, 0.18, 12), s.rimMat);
        rim.rotation.x = Math.PI / 2;
        rim.position.set(wx, 0.24, wz);
        carGroup.add(rim);
      }

      for (const zOff of [-depth * 0.23, depth * 0.23]) {
        const head = new THREE.Mesh(new THREE.BoxGeometry(0.06, 0.14, 0.22), s.headlightMat);
        head.position.set(width * 0.49, 0.5, zOff);
        carGroup.add(head);

        const tail = new THREE.Mesh(new THREE.BoxGeometry(0.06, 0.12, 0.22), s.taillightMat);
        tail.position.set(-width * 0.49, 0.54, zOff);
        carGroup.add(tail);
      }

      group.add(carGroup);
      continue;
    }

    if (w.wallStyle === "arched_divider") {
      batch.add(getSharedArchedDividerGeo(width, w.height, depth), mats.wall, {
        x: cx,
        y: 0,
        z: cz,
        receiveShadow: true,
        castShadow: true,
      });
      batch.add(SHARED_GEOS.box, s.baseboardMat, {
        x: cx,
        y: 0.06,
        z: cz,
        sx: width + 0.02,
        sy: 0.12,
        sz: depth + 0.04,
      });
      continue;
    }

    if (w.wallStyle === "parking_pillar" || w.wallStyle === "parking_pillar_round") {
      if (w.wallStyle === "parking_pillar_round") {
        const rad = Math.min(width, depth) * 0.5;
        const col = new THREE.Mesh(new THREE.CylinderGeometry(rad, rad, w.height, 18), mats.wall);
        col.position.set(cx, w.height * 0.5, cz);
        col.castShadow = true;
        col.receiveShadow = true;
        group.add(col);

        const capLower = new THREE.Mesh(
          new THREE.CylinderGeometry(rad + 0.3, rad + 0.3, 0.18, 18),
          mats.ceiling
        );
        capLower.position.set(cx, w.height - 0.34, cz);
        group.add(capLower);

        const capUpper = new THREE.Mesh(
          new THREE.CylinderGeometry(rad + 0.52, rad + 0.52, 0.2, 18),
          mats.ceiling
        );
        capUpper.position.set(cx, w.height - 0.14, cz);
        group.add(capUpper);

        const band = new THREE.Mesh(
          new THREE.CylinderGeometry(rad + 0.015, rad + 0.015, 0.42, 18),
          s.pillarBandMat
        );
        band.position.set(cx, w.height - 0.72, cz);
        group.add(band);

        const hazard = new THREE.Mesh(
          new THREE.CylinderGeometry(rad + 0.02, rad + 0.02, 0.88, 18),
          s.hazardStripeMat
        );
        hazard.position.set(cx, 0.44, cz);
        group.add(hazard);
      } else {
        const col = new THREE.Mesh(createWorldScaledBoxGeometry(width, w.height, depth, 3.0), mats.wall);
        col.position.set(cx, w.height * 0.5, cz);
        col.castShadow = true;
        col.receiveShadow = true;
        group.add(col);

        // Two-tier beveled drop-capital slab
        const capLower = new THREE.Mesh(createWorldScaledBoxGeometry(width + 0.6, 0.18, depth + 0.6, 3.0), mats.ceiling);
        capLower.position.set(cx, w.height - 0.34, cz);
        group.add(capLower);

        const capUpper = new THREE.Mesh(createWorldScaledBoxGeometry(width + 1.05, 0.2, depth + 1.05, 3.0), mats.ceiling);
        capUpper.position.set(cx, w.height - 0.14, cz);
        group.add(capUpper);

        const band = new THREE.Mesh(new THREE.BoxGeometry(width + 0.03, 0.42, depth + 0.03), s.pillarBandMat);
        band.position.set(cx, w.height - 0.72, cz);
        group.add(band);

        const hazard = new THREE.Mesh(new THREE.BoxGeometry(width + 0.04, 0.88, depth + 0.04), s.hazardStripeMat);
        hazard.position.set(cx, 0.44, cz);
        group.add(hazard);
      }

      const stencil = new THREE.Mesh(
        new THREE.PlaneGeometry(0.68, 0.34),
        getZoneStencilMat(s, w.zoneLabel)
      );
      stencil.position.set(cx, 2.25, w.minZ - 0.02);
      stencil.rotation.y = Math.PI;
      group.add(stencil);

      if ((w.lx + w.lz) % 2 === 0) {
        const cage = new THREE.Mesh(new THREE.BoxGeometry(0.22, 1.5, 0.12), s.gantryMat);
        cage.position.set(cx, 2.8, w.minZ - 0.04);
        group.add(cage);
        const strip = new THREE.Mesh(new THREE.CylinderGeometry(0.035, 0.035, 1.38, 10), mats.ceilingEmissiveMat);
        strip.position.set(cx, 2.8, w.minZ - 0.08);
        group.add(strip);
        const stripHalo = new THREE.Sprite(
          new THREE.SpriteMaterial({
            map: s.glowTextures.cool,
            transparent: true,
            opacity: 0.36,
            blending: THREE.AdditiveBlending,
            depthWrite: false,
          })
        );
        stripHalo.position.set(cx, 2.8, w.minZ - 0.2);
        stripHalo.scale.set(1.6, 2.6, 1);
        group.add(stripHalo);
      } else {
        // 3D Fire extinguisher mounted on pillar (File:SolusLevel1.jpg)
        const tank = new THREE.Mesh(new THREE.CylinderGeometry(0.11, 0.11, 0.56, 14), s.extinguisherRedMat);
        tank.position.set(w.maxX + 0.12, 1.25, cz);
        tank.castShadow = true;
        group.add(tank);
        const valveTop = new THREE.Mesh(new THREE.CylinderGeometry(0.035, 0.05, 0.1, 10), s.brassMat);
        valveTop.position.set(w.maxX + 0.12, 1.58, cz);
        group.add(valveTop);
      }
      continue;
    }

    const mat =
      w.cellType === CELL_TYPES.GLITCH_WALL
        ? mats.glitchMat
        : w.wallStyle === "l2_wood"
        ? s.l2WoodMat
        : mats.wall;

    const wallGeo = getSharedBoxGeo(width, w.height, depth, 3.0);
    batch.add(wallGeo, mat, {
      x: cx,
      y: w.height * 0.5,
      z: cz,
      receiveShadow: true,
      castShadow: true,
    });

    if (
      chunkData.levelId === "level_0" &&
      (w.wallStyle === "thin_x" ||
        w.wallStyle === "thin_z" ||
        w.wallStyle === "solid" ||
        w.wallStyle === "maze_wall_ew" ||
        w.wallStyle === "maze_wall_ns")
    ) {
      batch.add(SHARED_GEOS.box, s.baseboardMat, {
        x: cx,
        y: 0.065,
        z: cz,
        sx: width + 0.03,
        sy: 0.13,
        sz: depth + 0.03,
      });
      batch.add(SHARED_GEOS.box, s.baseboardMat, {
        x: cx,
        y: 0.44,
        z: cz,
        sx: width + 0.032,
        sy: 0.045,
        sz: depth + 0.032,
      });
    }

    if (w.wallStyle === "manila_wall") {
      batch.add(SHARED_GEOS.box, s.crownTrimMat, {
        x: cx,
        y: w.height - 0.075,
        z: cz,
        sx: width + 0.04,
        sy: 0.15,
        sz: depth + 0.04,
      });
    }

    if (w.cellType === CELL_TYPES.OUTLET_WALL) {
      const plate = new THREE.Mesh(new THREE.BoxGeometry(0.34, 0.48, width + 0.06), s.outletMat);
      plate.position.set(cx, 0.65, cz);
      group.add(plate);
    }
  }

  // Props (Feathered Puddles, Pipes w/ World-Scaled UVs, Instanced Repeated Geometry)
  for (const prop of chunkData.props) {
    if (prop.kind === "PUDDLE") {
      const size = prop.radius * 2.2;
      const pMat = prop.isFalsePuddle ? s.falsePuddleMat : mats.puddleMat;
      const rotZ = (prop.x * 1.3 + prop.z * 0.7) % (Math.PI * 2);
      batch.add(SHARED_GEOS.plane, pMat, {
        x: prop.x,
        y: prop.yOffset ?? 0.014,
        z: prop.z,
        rx: -Math.PI / 2,
        rz: rotZ,
        sx: size,
        sy: size,
        receiveShadow: true,
      });
    } else if (prop.kind === "CARPET_INDENT") {
      batch.add(SHARED_GEOS.plane, s.carpetIndentMat, {
        x: prop.x,
        y: 0.008,
        z: prop.z,
        rx: -Math.PI / 2,
        rz: prop.rotY || 0,
        sx: prop.w || 0.9,
        sy: prop.d || 0.8,
      });
    } else if (prop.kind === "LEVEL0_WING_WALL") {
      const wh = prop.height ?? h;
      batch.add(getSharedBoxGeo(prop.w, wh, prop.d, 3.0), mats.wall, {
        x: prop.x,
        y: wh * 0.5,
        z: prop.z,
        receiveShadow: true,
        castShadow: true,
      });
      batch.add(SHARED_GEOS.box, s.baseboardMat, {
        x: prop.x,
        y: 0.065,
        z: prop.z,
        sx: prop.w + 0.025,
        sy: 0.13,
        sz: prop.d + 0.025,
      });
    } else if (prop.kind === "REBAR_CLUSTER") {
      const cosR = Math.cos(prop.rotY || 0);
      const sinR = Math.sin(prop.rotY || 0);
      for (const [rx, rz, ang, len] of [
        [0, 0, 0.22, 0.52],
        [0.08, -0.06, -0.28, 0.44],
        [-0.07, 0.07, 0.35, 0.58],
      ]) {
        batch.add(SHARED_GEOS.cyl10, s.rebarMat, {
          x: prop.x + rx * cosR + rz * sinR,
          y: len * 0.44,
          z: prop.z - rx * sinR + rz * cosR,
          ry: prop.rotY || 0,
          rz: ang,
          sx: 0.017,
          sy: len,
          sz: 0.017,
        });
      }
    } else if (prop.kind === "MAINT_DOOR" || prop.kind === "WAREHOUSE_DOOR") {
      const dGrp = new THREE.Group();
      dGrp.position.set(prop.x, 0, prop.z);
      dGrp.rotation.y = prop.rotY || 0;
      const frame = new THREE.Mesh(getSharedBoxGeo(1.38, 2.34, 0.09, 3.0), s.gantryMat);
      frame.position.set(0, 1.17, 0);
      const leafMat =
        prop.kind === "MAINT_DOOR"
          ? s.maintBlackDoorMat
          : prop.doorVariant === "pink"
            ? s.warehousePinkDoorMat
            : prop.doorVariant === "white"
              ? s.warehouseWhiteDoorMat
              : s.warehouseWoodDoorMat;
      const leaf = new THREE.Mesh(getSharedBoxGeo(1.22, 2.22, 0.06, 3.0), leafMat);
      leaf.position.set(0, 1.12, 0.02);
      const knob = new THREE.Mesh(getSharedBoxGeo(0.14, 0.04, 0.1, 1.0), s.brassMat);
      knob.position.set(0.42, 1.02, 0.06);
      dGrp.add(frame, leaf, knob);
      group.add(dGrp);
    } else if (prop.kind === "OVERHEAD_PIPE") {
      const pLen = prop.length || CELL_SIZE;
      const py = prop.y ?? h - 0.32;
      const pipeGeoMat = chunkData.levelId === "level_2" ? s.rustPipeMat : mats.pipeMat;
      const isX = prop.axis === "x";
      batch.add(getSharedPipeGeometry(0.14, pLen, 12), pipeGeoMat, {
        x: prop.x,
        y: py,
        z: prop.z,
        rx: isX ? 0 : Math.PI / 2,
        rz: isX ? Math.PI / 2 : 0,
      });
      if (pLen > CELL_SIZE * 2) {
        const flangeGeo = getSharedPipeGeometry(0.2, 0.1, 12);
        for (const off of [-8, 0, 8]) {
          batch.add(flangeGeo, s.gantryMat, {
            x: prop.x + (isX ? off : 0),
            y: py,
            z: prop.z + (isX ? 0 : off),
            rx: isX ? 0 : Math.PI / 2,
            rz: isX ? Math.PI / 2 : 0,
          });
        }
      }
    } else if (prop.kind === "LIGHT_TRACK") {
      const len = prop.length || CHUNK_WORLD_SIZE;
      const isX = prop.axis === "x";
      batch.add(SHARED_GEOS.box, s.gantryMat, {
        x: prop.x,
        y: prop.y || 5.48,
        z: prop.z,
        sx: isX ? len : 0.16,
        sy: 0.08,
        sz: isX ? 0.16 : len,
      });
    } else if (prop.kind === "WALL_TV") {
      const tvGrp = new THREE.Group();
      tvGrp.position.set(prop.x, 3.15, prop.z);
      tvGrp.rotation.y = prop.rotY || 0;
      const bracket = new THREE.Mesh(new THREE.BoxGeometry(0.14, 0.14, 0.28), s.gantryMat);
      bracket.position.set(0, 0.08, -0.14);
      const tiltGrp = new THREE.Group();
      tiltGrp.rotation.x = 0.22;
      const caseBox = new THREE.Mesh(new THREE.BoxGeometry(1.04, 0.68, 0.14), s.gantryMat);
      const screen = new THREE.Mesh(new THREE.PlaneGeometry(0.92, 0.56), s.newsTvMat);
      screen.position.set(0, 0, 0.076);
      tiltGrp.add(caseBox, screen);
      tvGrp.add(bracket, tiltGrp);
      group.add(tvGrp);
    } else if (prop.kind === "WALL_ALCOVE") {
      batch.add(SHARED_GEOS.box, s.alcoveVoidMat, {
        x: prop.x,
        y: 0.72,
        z: prop.z,
        ry: prop.rotY || 0,
        sx: 1.12,
        sy: 1.38,
        sz: 0.18,
      });
      const cosR = Math.cos(prop.rotY || 0);
      const sinR = Math.sin(prop.rotY || 0);
      batch.add(SHARED_GEOS.box, s.sidewalkMat, {
        x: prop.x - sinR * -0.05,
        y: 0.72,
        z: prop.z + cosR * -0.05,
        ry: prop.rotY || 0,
        sx: 1.26,
        sy: 1.5,
        sz: 0.12,
      });
    } else if (prop.kind === "WALL_OUTLET") {
      const ry = prop.rotY || 0;
      const sinR = Math.sin(ry);
      const cosR = Math.cos(ry);
      batch.add(SHARED_GEOS.box, s.outletMat, {
        x: prop.x,
        y: 0.45,
        z: prop.z,
        ry,
        sx: 0.16,
        sy: 0.24,
        sz: 0.03,
      });
      for (const sy of [-0.045, 0.045]) {
        batch.add(SHARED_GEOS.box, s.socketDarkMat, {
          x: prop.x + sinR * 0.01,
          y: 0.45 + sy,
          z: prop.z + cosR * 0.01,
          ry,
          sx: 0.06,
          sy: 0.045,
          sz: 0.04,
        });
      }
    } else if (prop.kind === "WHEEL_STOP") {
      batch.add(SHARED_GEOS.wheelStop, s.hazardYellowMat, {
        x: prop.x,
        y: 0.09,
        z: prop.z,
        rx: Math.PI / 4,
        rz: Math.PI / 2,
        receiveShadow: true,
      });
    } else if (prop.kind === "PARKING_LINE") {
      batch.add(SHARED_GEOS.plane, s.roadLineMat, {
        x: prop.x,
        y: 0.011,
        z: prop.z,
        rx: -Math.PI / 2,
        sx: prop.w,
        sy: prop.d,
      });
    } else if (prop.kind === "FLOOR_ARROW") {
      batch.add(SHARED_GEOS.plane, s.hazardYellowMat, {
        x: prop.x,
        y: 0.012,
        z: prop.z,
        rx: -Math.PI / 2,
        rz: prop.rotY || 0,
        sx: 0.28,
        sy: 1.5,
      });
      const cosR = Math.cos(prop.rotY || 0);
      const sinR = Math.sin(prop.rotY || 0);
      batch.add(SHARED_GEOS.arrowHead, s.hazardYellowMat, {
        x: prop.x - sinR * 0.85,
        y: 0.015,
        z: prop.z - cosR * 0.85,
        rx: -Math.PI / 2,
        rz: prop.rotY || 0,
      });
    } else if (prop.kind === "TRAFFIC_BARRIER") {
      const base = new THREE.Mesh(getSharedBoxGeo(1.45, 0.22, 0.55, 2.0), s.barrierOrangeMat);
      base.position.set(prop.x, 0.11, prop.z);
      const topBar = new THREE.Mesh(getSharedBoxGeo(1.38, 0.62, 0.34, 2.0), s.barrierOrangeMat);
      topBar.position.set(prop.x, 0.52, prop.z);
      base.castShadow = true;
      topBar.castShadow = true;
      group.add(base, topBar);
    } else if (prop.kind === "PARKING_RAMP") {
      const ramp = new THREE.Mesh(createWorldScaledBoxGeometry(4.2, 0.28, 7.6, 3.0), mats.wall);
      ramp.position.set(prop.x, 1.35, prop.z);
      ramp.rotation.x = -0.32;
      ramp.receiveShadow = true;
      group.add(ramp);
      const rail = new THREE.Mesh(createWorldScaledBoxGeometry(0.24, 0.78, 7.6, 3.0), mats.wall);
      rail.position.set(prop.x + 2.0, 1.85, prop.z);
      rail.rotation.x = -0.32;
      group.add(rail);
    } else if (prop.kind === "OVERHEAD_BEAM") {
      batch.add(getSharedBoxGeo(CHUNK_WORLD_SIZE, 0.48, 0.42, 3.0), mats.ceiling, {
        x: prop.x,
        y: h - 0.24,
        z: prop.z,
      });
    } else if (prop.kind === "CEILING_PIPE") {
      const pMat = prop.color === 0x9aa2ab ? s.l1GreyPipeMat : s.l1OrangePipeMat;
      batch.add(getSharedPipeGeometry(0.11, CHUNK_WORLD_SIZE, 10), pMat, {
        x: prop.x,
        y: h - 0.52,
        z: prop.z,
        rz: Math.PI / 2,
      });
    } else if (prop.kind === "FAKE_EXIT_SIGN") {
      const signGrp = new THREE.Group();
      signGrp.position.set(prop.x, 3.1, prop.z);
      signGrp.rotation.y = prop.rotY !== undefined ? prop.rotY : Math.PI;
      const housing = new THREE.Mesh(new THREE.BoxGeometry(1.02, 0.44, 0.14), s.gantryMat);
      const face = new THREE.Mesh(
        new THREE.PlaneGeometry(0.92, 0.34),
        getFakeExitSignMat(s, prop.signLang || "EXIT")
      );
      face.position.set(0, 0, 0.08);
      signGrp.add(housing, face);
      group.add(signGrp);
    } else if (prop.kind === "TUNNEL_ARCH") {
      // 40-segment smooth concrete highway tunnel arch + curved structural ribs
      const archGeo = new THREE.CylinderGeometry(
        prop.radius,
        prop.radius,
        prop.length,
        40,
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

      for (let off = -9; off <= 9; off += 6) {
        const ribGeo = new THREE.TorusGeometry(prop.radius - 0.08, 0.14, 8, 28, Math.PI);
        const rib = new THREE.Mesh(ribGeo, s.gantryMat);
        if (prop.axis === "x") {
          rib.position.set(prop.centerX + off, 0.2, prop.centerZ);
          rib.rotation.y = Math.PI / 2;
        } else {
          rib.position.set(prop.centerX, 0.2, prop.centerZ + off);
        }
        group.add(rib);
      }
    } else if (prop.kind === "HIGHWAY_ROAD") {
      const isX = prop.axis === "x";
      const roadW = isX ? prop.length : prop.width;
      const roadD = isX ? prop.width : prop.length;
      const road = new THREE.Mesh(getSharedWorldPlaneGeo(roadW, roadD, 2.4), s.hubRoadMat);
      road.rotation.x = -Math.PI / 2;
      road.position.set(prop.centerX, 0.02, prop.centerZ);
      road.receiveShadow = true;
      group.add(road);

      for (let seg = -9; seg <= 9; seg += 4.5) {
        batch.add(SHARED_GEOS.plane, s.roadLineMat, {
          x: prop.centerX + (isX ? seg : 0),
          y: 0.032,
          z: prop.centerZ + (isX ? 0 : seg),
          rx: -Math.PI / 2,
          sx: isX ? 2.2 : 0.16,
          sy: isX ? 0.16 : 2.2,
        });
      }
      for (const offset of [-prop.width * 0.44, prop.width * 0.44]) {
        batch.add(SHARED_GEOS.plane, s.roadLineMat, {
          x: prop.centerX + (isX ? 0 : offset),
          y: 0.032,
          z: prop.centerZ + (isX ? offset : 0),
          rx: -Math.PI / 2,
          sx: isX ? prop.length : 0.14,
          sy: isX ? 0.14 : prop.length,
        });
      }
    } else if (prop.kind === "SIDEWALK_CURB") {
      const curb = new THREE.Mesh(getSharedBoxGeo(prop.length, 0.22, prop.width, 2.4), s.sidewalkMat);
      curb.position.set(prop.x, 0.11, prop.z);
      curb.receiveShadow = true;
      group.add(curb);
      for (let sx = -9; sx <= 9; sx += 6) {
        batch.add(SHARED_GEOS.box, s.curbRedGlowMat, {
          x: prop.x + sx,
          y: 0.23,
          z: prop.z,
          sx: 0.14,
          sy: 0.08,
          sz: 0.14,
        });
      }
    } else if (prop.kind === "TRAFFIC_GANTRY") {
      const isX = prop.axis === "x";
      const bar = new THREE.Mesh(
        new THREE.BoxGeometry(isX ? 0.24 : 7.6, 0.24, isX ? 7.6 : 0.24),
        s.gantryMat
      );
      bar.position.set(prop.x, 4.25, prop.z);
      group.add(bar);
      for (const [idx, off] of [-2.0, -0.7, 0.7, 2.0].entries()) {
        const box = new THREE.Mesh(new THREE.BoxGeometry(0.66, 0.52, 0.14), s.gantryMat);
        box.position.set(prop.x + (isX ? 0 : off), 4.18, prop.z + (isX ? off : 0));
        if (isX) box.rotation.y = Math.PI / 2;
        group.add(box);

        const faceMat = idx % 2 === 0 ? s.warnSignMat : s.redXSignMat;
        const f1 = new THREE.Mesh(new THREE.PlaneGeometry(0.6, 0.46), faceMat);
        f1.position.copy(box.position);
        f1.position.x += isX ? 0.08 : 0;
        f1.position.z += isX ? 0 : 0.08;
        if (isX) f1.rotation.y = Math.PI / 2;
        const f2 = new THREE.Mesh(new THREE.PlaneGeometry(0.6, 0.46), faceMat);
        f2.position.copy(box.position);
        f2.position.x -= isX ? 0.08 : 0;
        f2.position.z -= isX ? 0 : 0.08;
        f2.rotation.y = isX ? -Math.PI / 2 : Math.PI;
        group.add(f1, f2);
      }
    } else if (prop.kind === "VENT_FAN") {
      // High-poly 20-segment jet fan shroud + ceiling struts + nose cone + 6-blade spinning rotor
      const shroud = new THREE.Mesh(new THREE.CylinderGeometry(0.64, 0.64, 1.55, 20, 1, true), s.fanBodyMat);
      shroud.rotation.z = Math.PI / 2;
      shroud.position.set(prop.x, prop.y, prop.z);
      group.add(shroud);

      const frontRing = new THREE.Mesh(new THREE.TorusGeometry(0.64, 0.045, 8, 24), s.gantryMat);
      frontRing.rotation.y = Math.PI / 2;
      frontRing.position.set(prop.x - 0.77, prop.y, prop.z);
      group.add(frontRing);

      for (const sx of [-0.45, 0.45]) {
        const strut = new THREE.Mesh(new THREE.BoxGeometry(0.1, 0.85, 0.1), s.gantryMat);
        strut.position.set(prop.x + sx, prop.y + 0.82, prop.z);
        group.add(strut);
      }

      const rotorGroup = new THREE.Group();
      rotorGroup.position.set(prop.x, prop.y, prop.z);
      rotorGroup.userData = { isVentRotor: true };
      const hubCone = new THREE.Mesh(new THREE.SphereGeometry(0.18, 12, 10), s.gantryMat);
      rotorGroup.add(hubCone);
      for (let b = 0; b < 6; b += 1) {
        const blade = new THREE.Mesh(new THREE.BoxGeometry(0.06, 0.56, 0.14), s.hazardYellowMat);
        const angle = (b / 6) * Math.PI * 2;
        blade.position.set(0, Math.cos(angle) * 0.3, Math.sin(angle) * 0.3);
        blade.rotation.x = angle;
        blade.rotation.y = 0.35;
        rotorGroup.add(blade);
      }
      group.add(rotorGroup);
      ventFanRotors.push(rotorGroup);
    } else if (prop.kind === "BLUE_TUNNEL_SIGN") {
      const frame = new THREE.Mesh(new THREE.BoxGeometry(0.76, 0.46, 0.1), s.gantryMat);
      frame.position.set(prop.x, 2.15, prop.z);
      const face = new THREE.Mesh(new THREE.PlaneGeometry(0.7, 0.4), s.blueExitSignMat);
      face.position.set(prop.x, 2.15, prop.z + 0.06);
      group.add(frame, face);
    } else if (prop.kind === "CHAMFER_RIB") {
      const isZ = prop.axis === "z";
      const hw = isZ ? 0.62 : 0.36;
      const hd = isZ ? 0.36 : 0.62;
      const pw = isZ ? 0.22 : 0.28;
      const pd = isZ ? 0.28 : 0.22;
      const haunchGeo = getSharedBoxGeo(hw, 0.62, hd, 2.0);
      const pilasterGeo = getSharedBoxGeo(pw, h, pd, 2.0);

      for (const side of (prop.sides || [-1, 1])) {
        batch.add(haunchGeo, mats.ceiling, {
          x: prop.x + (isZ ? side * 1.24 : 0),
          y: h - 0.22,
          z: prop.z + (isZ ? 0 : side * 1.24),
          rx: isZ ? 0 : Math.PI / 4,
          rz: isZ ? Math.PI / 4 : 0,
        });
        batch.add(pilasterGeo, mats.wall, {
          x: prop.x + (isZ ? side * 1.38 : 0),
          y: h * 0.5,
          z: prop.z + (isZ ? 0 : side * 1.38),
          receiveShadow: true,
        });
      }
    } else if (prop.kind === "SIDE_PIPE_RUN") {
      const isX = prop.axis === "x";
      for (const [py, pRad, pMat] of [
        [0.85, 0.08, s.rustPipeMat],
        [1.45, 0.11, s.darkPipeMat],
        [2.05, 0.09, s.rustPipeMat],
      ]) {
        batch.add(getSharedPipeGeometry(pRad, CELL_SIZE, 10), pMat, {
          x: prop.x,
          y: py,
          z: prop.z,
          rx: isX ? 0 : Math.PI / 2,
          rz: isX ? Math.PI / 2 : 0,
        });
        batch.add(getSharedPipeGeometry(pRad * 1.55, 0.09, 10), s.gantryMat, {
          x: prop.x,
          y: py,
          z: prop.z,
          rx: isX ? 0 : Math.PI / 2,
          rz: isX ? Math.PI / 2 : 0,
        });
      }
      batch.add(SHARED_GEOS.box, s.gantryMat, {
        x: prop.x,
        y: 1.45,
        z: prop.z,
        sx: isX ? 0.12 : 0.22,
        sy: 1.55,
        sz: isX ? 0.22 : 0.12,
      });

      if (prop.hasValve) {
        batch.add(getSharedPipeGeometry(0.03, 0.16, 8), s.brassMat, {
          x: prop.x,
          y: 1.45,
          z: prop.z,
          rx: isX ? Math.PI / 2 : 0,
          rz: isX ? 0 : Math.PI / 2,
        });
        batch.add(SHARED_GEOS.torusValve, s.valveRedMat, {
          x: prop.x,
          y: 1.45,
          z: prop.z,
          ry: isX ? 0 : Math.PI / 2,
        });
      }
    } else if (prop.kind === "STEAM_VENT") {
      batch.add(getSharedPipeGeometry(0.28, 0.4, 12), s.rustPipeMat, {
        x: prop.x,
        y: h - 0.2,
        z: prop.z,
      });
    }
  }

  // Interactables (Doors, Crawlspaces, Manila Resting Zone, Stairs, Sculpted Object 2 Keys)
  for (const item of chunkData.interactables) {
    if (item.type === "STAIRS") {
      for (let step = 0; step < 5; step += 1) {
        const sGeo = createWorldScaledBoxGeometry(1.8, 0.28, 0.45, 2.0);
        const sMesh = new THREE.Mesh(sGeo, mats.stairsMat);
        sMesh.position.set(item.x, 0.14 + step * 0.28, item.z - 0.8 + step * 0.4);
        sMesh.castShadow = true;
        sMesh.receiveShadow = true;
        group.add(sMesh);
      }
    } else if (item.type === "CRAWLSPACE_EXIT") {
      const cwGrp = new THREE.Group();
      cwGrp.position.set(item.x, 0, item.z);
      const surround = new THREE.Mesh(new THREE.BoxGeometry(1.36, 1.12, 0.28), s.gantryMat);
      surround.position.set(0, 0.56, 0);
      const voidHole = new THREE.Mesh(new THREE.BoxGeometry(0.98, 0.86, 0.34), s.alcoveVoidMat);
      voidHole.position.set(0, 0.45, 0);
      cwGrp.add(surround, voidHole);
      for (const [wx, rotZ] of [[-0.28, 0.14], [-0.08, -0.18], [0.14, 0.22], [0.3, -0.1]]) {
        const wire = new THREE.Mesh(new THREE.CylinderGeometry(0.012, 0.012, 0.56, 5), s.crawlWireMat);
        wire.position.set(wx, 0.62, 0.18);
        wire.rotation.z = rotZ;
        cwGrp.add(wire);
      }
      const spark = new THREE.Mesh(new THREE.SphereGeometry(0.04, 8, 8), s.crawlSparkMat);
      spark.position.set(0.14, 0.38, 0.19);
      cwGrp.add(spark);
      const plaque = new THREE.Mesh(new THREE.BoxGeometry(0.84, 0.24, 0.22), s.fireExitSignMat);
      plaque.position.set(0, 1.28, 0);
      cwGrp.add(plaque);
      group.add(cwGrp);
    } else if (item.type === "MANILA_REST_ZONE") {
      const wornPad = new THREE.Mesh(new THREE.CircleGeometry(1.15, 24), s.carpetIndentMat);
      wornPad.rotation.x = -Math.PI / 2;
      wornPad.position.set(item.x, 0.012, item.z);
      const warmPool = new THREE.Mesh(new THREE.CircleGeometry(1.5, 24), s.manilaLightPoolMat);
      warmPool.rotation.x = -Math.PI / 2;
      warmPool.position.set(item.x, 0.016, item.z);
      group.add(wornPad, warmPool);
    } else if (item.type === "LORE_DOOR") {
      const doorGroup = new THREE.Group();
      doorGroup.position.set(item.x, 0, item.z);
      const ds = item.context?.doorStyle;
      const frameOuter = new THREE.Mesh(new THREE.BoxGeometry(1.48, 2.48, 0.28), s.gantryMat);
      frameOuter.position.set(0, 1.24, 0);
      const leafMat =
        ds === "gold_phi" ? s.goldPhiMat : ds === "l37_tile" ? s.tileL37Mat : s.neonL154Mat;
      const dMesh = new THREE.Mesh(new THREE.BoxGeometry(1.28, 2.34, 0.22), leafMat);
      dMesh.position.set(0, 1.18, 0);
      dMesh.castShadow = true;
      const handle = new THREE.Mesh(new THREE.BoxGeometry(0.18, 0.05, 0.34), s.brassMat);
      handle.position.set(0.42, 1.05, 0);
      const signMat =
        ds === "gold_phi" ? s.lorePhiSignMat : ds === "l37_tile" ? s.lore37SignMat : s.lore154SignMat;
      const badge = new THREE.Mesh(new THREE.BoxGeometry(0.98, 0.32, 0.26), signMat);
      badge.position.set(0, 2.58, 0);
      doorGroup.add(frameOuter, dMesh, handle, badge);
      group.add(doorGroup);
    } else if (
      item.type === "HUB_LEVEL_DOOR" ||
      item.type === "HUB_DOOR_A" ||
      item.type === "HUB_DOOR_B" ||
      item.type === "EXIT_DOOR" ||
      item.type === "MANILA_PORTAL"
    ) {
      const doorGroup = new THREE.Group();
      doorGroup.position.set(item.x, 0, item.z);

      const frameOuter = new THREE.Mesh(new THREE.BoxGeometry(1.48, 2.48, 0.28), s.gantryMat);
      frameOuter.position.set(0, 1.24, 0);
      doorGroup.add(frameOuter);

      const tgtId = item.context?.targetLevelId;
      const leafMat =
        item.type === "HUB_LEVEL_DOOR" && tgtId && s.hubDoorLeafMats[tgtId]
          ? s.hubDoorLeafMats[tgtId]
          : mats.door;
      const dMesh = new THREE.Mesh(new THREE.BoxGeometry(1.28, 2.34, 0.22), leafMat);
      dMesh.position.set(0, 1.18, 0);
      dMesh.castShadow = true;
      doorGroup.add(dMesh);

      const handle = new THREE.Mesh(new THREE.BoxGeometry(0.18, 0.05, 0.34), s.brassMat);
      handle.position.set(0.42, 1.05, 0);
      doorGroup.add(handle);

      const plaqueMat =
        tgtId && s.doorLabelMats[tgtId]
          ? s.doorLabelMats[tgtId]
          : item.type === "EXIT_DOOR"
          ? s.fireExitSignMat
          : getSharedTintMat(
              s,
              item.context?.doorTint ||
                (item.type === "HUB_DOOR_B" ? 0x4ea8de : item.type === "HUB_DOOR_A" ? 0xf4a261 : 0xd4a259)
            );
      const badge = new THREE.Mesh(new THREE.BoxGeometry(0.98, 0.32, 0.26), plaqueMat);
      badge.position.set(0, 2.58, 0);
      doorGroup.add(badge);

      group.add(doorGroup);
    } else if (item.type === "KEY_PICKUP") {
      if (!state.hasLevelKey) {
        const ped = new THREE.Mesh(new THREE.CylinderGeometry(0.32, 0.42, 0.9, 16), mats.stairsMat);
        ped.position.set(item.x, 0.45, item.z);
        ped.castShadow = true;
        group.add(ped);

        const keyGrp = new THREE.Group();
        keyGrp.position.set(item.x, 1.24, item.z);
        const bow = new THREE.Mesh(new THREE.TorusGeometry(0.11, 0.025, 8, 16), s.brassMat);
        bow.position.set(-0.15, 0, 0);
        const shaft = new THREE.Mesh(new THREE.CylinderGeometry(0.02, 0.02, 0.34, 8), s.brassMat);
        shaft.rotation.z = Math.PI / 2;
        shaft.position.set(0.12, 0, 0);
        const tag = new THREE.Mesh(new THREE.BoxGeometry(0.1, 0.06, 0.02), s.rimMat);
        tag.position.set(-0.15, -0.09, 0);
        keyGrp.add(bow, shaft, tag);
        for (const tx of [0.16, 0.21, 0.26]) {
          const tooth = new THREE.Mesh(new THREE.BoxGeometry(0.025, 0.065, 0.025), s.brassMat);
          tooth.position.set(tx, -0.04, 0);
          keyGrp.add(tooth);
        }
        group.add(keyGrp);
        keyPickupMeshes.push(keyGrp);
      }
    }
  }

  // Per-Level Ceiling Light Fixtures & Halos (Batched meshes + shared halo SpriteMaterial + pooled PointLights)
  const haloMat = getSharedHaloMat(s, chunkData.levelId);

  for (const lt of chunkData.lights) {
    const ry = lt.rotY || 0;
    if (chunkData.levelId === "manila_room") {
      const ltGrp = new THREE.Group();
      ltGrp.position.set(lt.x, lt.y, lt.z);
      const collar = new THREE.Mesh(new THREE.CylinderGeometry(0.16, 0.2, 0.06, 16), s.brassMat);
      collar.position.set(0, 0.06, 0);
      const dome = new THREE.Mesh(new THREE.CylinderGeometry(0.28, 0.34, 0.14, 16), mats.ceilingEmissiveMat);
      ltGrp.add(collar, dome);
      group.add(ltGrp);
    } else if (chunkData.levelId === "level_1") {
      batch.add(SHARED_GEOS.box, s.gantryMat, { x: lt.x, y: lt.y + 0.04, z: lt.z, ry, sx: 2.2, sy: 0.07, sz: 0.16 });
      batch.add(getSharedPipeGeometry(0.032, 2.1, 8), mats.ceilingEmissiveMat, { x: lt.x, y: lt.y, z: lt.z, ry, rz: Math.PI / 2 });
    } else if (chunkData.levelId === "the_hub") {
      batch.add(SHARED_GEOS.box, s.gantryMat, { x: lt.x, y: lt.y + 0.04, z: lt.z, ry, sx: 0.46, sy: 0.1, sz: 0.46 });
      batch.add(SHARED_GEOS.box, mats.ceilingEmissiveMat, { x: lt.x, y: lt.y, z: lt.z, ry, sx: 0.36, sy: 0.12, sz: 0.36 });
    } else if (chunkData.levelId === "level_2") {
      batch.add(SHARED_GEOS.box, s.gantryMat, { x: lt.x, y: lt.y + 0.03, z: lt.z, ry, sx: 0.42, sy: 0.1, sz: 0.24 });
      batch.add(SHARED_GEOS.box, mats.ceilingEmissiveMat, { x: lt.x, y: lt.y, z: lt.z, ry, sx: 0.32, sy: 0.11, sz: 0.16 });
    } else {
      // level_0 flush acoustic troffer
      batch.add(SHARED_GEOS.box, s.outletMat, { x: lt.x, y: lt.y + 0.02, z: lt.z, ry, sx: 1.22, sy: 0.04, sz: 0.6 });
      batch.add(SHARED_GEOS.box, mats.ceilingEmissiveMat, { x: lt.x, y: lt.y, z: lt.z, ry, sx: 1.14, sy: 0.05, sz: 0.52 });
    }

    const halo = new THREE.Sprite(haloMat);
    halo.position.set(lt.x, lt.y - 0.16, lt.z);
    const haloScale = chunkData.levelId === "the_hub" ? 3.4 : chunkData.levelId === "manila_room" ? 2.8 : chunkData.levelId === "level_2" ? 1.6 : 2.1;
    halo.scale.set(haloScale, haloScale, 1);
    group.add(halo);
  }

  batch.flushTo(group);
  scene.add(group);
  chunkMeshes.set(chunkData.key, group);
}

const chunkManager = new ChunkManager({
  levelId: state.currentLevelId,
  worldSeed: state.worldSeed,
  loadRadius: 1,
  unloadRadius: 2,
  enableNonEuclidean: ENABLE_L0_NON_EUCLIDEAN_SHIFT,
  onChunkLoad: (chunkData) => buildChunkGroup(chunkData),
  onChunkUnload: (chunkData) => {
    const group = chunkMeshes.get(chunkData.key);
    if (group) {
      disposeChunkGroup(group);
      chunkMeshes.delete(chunkData.key);
    }
  },
  onChunkReload: (chunkData) => {
    const oldGroup = chunkMeshes.get(chunkData.key);
    if (oldGroup) {
      disposeChunkGroup(oldGroup);
      chunkMeshes.delete(chunkData.key);
    }
    buildChunkGroup(chunkData);
    updateChunkVisibility();
  },
});

function configureChunkStreamRadius(levelId) {
  const tight = levelId === "level_0" || levelId === "level_2" || levelId === "manila_room";
  chunkManager.loadRadius = tight ? 1 : 2;
  chunkManager.unloadRadius = tight ? 2 : 3;
}

// ---------------------------------------------------------------------------
// Level Switching & HUD Updates
// ---------------------------------------------------------------------------
function updateTextureStatusHud() {
  const mats = materialCache.getMaterials(state.currentLevelId);
  const st = mats.status;
  ui.hudTexStatus.textContent =
    st.wikiLoaded > 0
      ? `AI再生成PBR (${st.wikiLoaded}/${st.total})`
      : `Canvasプロシージャル (${st.total}/${st.total})`;
}

function applyLevelEnvironment(levelId) {
  const levelData = getLevelData(levelId);
  const env = levelData.environment;

  scene.background = new THREE.Color(env.fogColor);
  scene.fog = new THREE.FogExp2(env.fogColor, env.fogDensity);
  scene.environment = getLevelEnvironmentTexture(levelId);
  renderer.toneMappingExposure = env.exposure ?? 1.05;
  camera.far = levelId === "manila_room" ? 32 : levelId === "level_0" ? 36 : levelId === "level_2" ? 42 : 85;
  camera.updateProjectionMatrix();

  ambientLight.color.setHex(env.ambientColor);
  ambientLight.intensity = env.ambientIntensity;
  hemiLight.color.setHex(env.hemiSkyColor ?? env.ambientColor);
  hemiLight.groundColor.setHex(env.hemiGroundColor ?? env.fogColor);
  hemiLight.intensity = env.hemiIntensity ?? 0.28;

  ui.hudBadge.textContent = levelData.survivalClass.code;
  ui.hudBadge.style.borderColor = levelData.survivalClass.colorHex;
  ui.hudBadge.style.backgroundColor = `${levelData.survivalClass.colorHex}55`;
  ui.hudLevelName.textContent = levelData.name;
  ui.hudLevelSub.textContent = levelData.subtitle;
  ui.hudClassLabel.textContent = levelData.survivalClass.label;
  ui.hudMmoMode.textContent =
    levelId === "level_2"
      ? "Solo Isolated (Radio Blackout)"
      : levelData.mmoInstanceMode === "solo_isolated"
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
  state.manilaDwellSec = 0;
  state.manilaWarnStep = 0;
  state.l2TremorTimer = 0;
  state.l2TremorActiveTimer = 0;
  state.l0ShiftTimer = 0;
  state.l0ShiftDistAccum = 0;
  state.l0ShiftLogCooldown = 0;
  state.l0LastChunkKey = "";

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
  configureChunkStreamRadius(targetLevelId);
  state.currentLevelId = targetLevelId;
  state.player.x = spawnPos.x;
  state.player.z = spawnPos.z;
  state.player.feetY = 0;
  state.player.vy = 0;
  state.player.grounded = true;
  state.player.crouching = false;
  state.player.eyeHeight = STAND_EYE_HEIGHT;
  state.player.landDip = 0;
  state.player.hazardDip = 0;
  state.player.knockbackVx = 0;
  state.player.knockbackVz = 0;
  state.player.falsePuddleCooldown = 0;
  state.player.y = STAND_EYE_HEIGHT;

  applyLevelEnvironment(targetLevelId);
  chunkManager.update(state.player.x, state.player.z);
  updateChunkVisibility();
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

  if (item.triggerType === "LORE_HINT") {
    audio.playDoorTransition();
    addLog(item.context?.msg || item.label);
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

  if (item.type === "OUTLET_WALL" && state.currentLevelId === "level_1") {
    if (state.blackoutActive) {
      addLog("[BLACKOUT] 停電中のため壁コンセントから給電できません（Nキーで壁面ノークリップのみ可能）。");
    } else {
      audio.playDoorTransition();
      addLog("[OUTLET] 壁コンセントは通電中です（デバイス充電可 / Nキーで壁面ノークリップ）。");
    }
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
  const col = chunkManager.resolveCollision(state.player.x, state.player.z, PLAYER_RADIUS, state.player.feetY);
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
    ui.hudPrompt.textContent = "クリックで視点復帰 / WASD移動 / Spaceジャンプ / C(Ctrl)しゃがみ / F懐中電灯 / E調べる";
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
  if (code === "Space") {
    ev.preventDefault();
  }
  state.keysPressed.add(code);

  if (code === "Space" && state.player.grounded) {
    state.player.vy = JUMP_VELOCITY;
    state.player.grounded = false;
    audio.playJump();
  } else if (code === "KeyC") {
    state.player.crouching = !state.player.crouching;
  } else if (code === "KeyF") {
    state.flashlightOn = !state.flashlightOn;
    flashlight.visible = state.flashlightOn;
    flashlight.castShadow = state.flashlightOn;
    renderer.shadowMap.autoUpdate = state.flashlightOn;
    if (state.flashlightOn) renderer.shadowMap.needsUpdate = true;
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
  } else if (code === "KeyV") {
    state.camcorderVisible = !state.camcorderVisible;
    if (ui.camcorderVignette) {
      ui.camcorderVignette.classList.toggle("hidden", !state.camcorderVisible);
    }
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
const shiftFrustum = new THREE.Frustum();
const shiftProjMatrix = new THREE.Matrix4();
const shiftProbeVec = new THREE.Vector3();

function updatePointLightPool(elapsedSec, currentLightHex, levelData) {
  const env = levelData.environment;
  if (state.blackoutActive) {
    for (const pt of pointLightPool) pt.intensity = 0;
    return;
  }

  const { cx: pcx, cz: pcz } = chunkManager.worldToChunk(state.player.x, state.player.z);
  const candidates = [];
  for (let dz = -1; dz <= 1; dz += 1) {
    for (let dx = -1; dx <= 1; dx += 1) {
      const chunk = chunkManager.chunks.get(`${state.currentLevelId}:${pcx + dx}:${pcz + dz}`);
      if (!chunk) continue;
      for (const lt of chunk.lights) {
        const ddx = lt.x - state.player.x;
        const ddz = lt.z - state.player.z;
        candidates.push({ lt, distSq: ddx * ddx + ddz * ddz });
      }
    }
  }
  candidates.sort((a, b) => a.distSq - b.distSq);

  const range =
    state.currentLevelId === "the_hub"
      ? 24
      : state.currentLevelId === "level_1"
      ? 20
      : state.currentLevelId === "level_2"
      ? 14
      : state.currentLevelId === "level_0"
      ? 12.5
      : 16;
  const decay =
    state.currentLevelId === "the_hub"
      ? 1.35
      : state.currentLevelId === "level_2"
      ? 1.7
      : state.currentLevelId === "level_0"
      ? 1.85
      : 1.45;
  const baseIntensity = env.lightIntensity || 1.3;

  for (let i = 0; i < POINT_LIGHT_POOL_SIZE; i += 1) {
    const pt = pointLightPool[i];
    if (i >= candidates.length) {
      pt.intensity = 0;
      continue;
    }
    const { lt } = candidates[i];
    pt.position.set(lt.x, lt.y - 0.32, lt.z);
    pt.distance = range;
    pt.decay = decay;
    pt.color.setHex(currentLightHex);
    const flicker = env.lightFlicker
      ? 0.92 + 0.08 * Math.sin(elapsedSec * 19 + (lt.flickerPhase || 0))
      : 1.0;
    pt.intensity = baseIntensity * flicker;
  }
}

function updateAtmosphere(dt, elapsedSec) {
  const levelData = getLevelData(state.currentLevelId);
  const env = levelData.environment;
  const mats = materialCache.getMaterials(state.currentLevelId);

  if (env.blackoutIntervalSec > 0) {
    state.blackoutTimer += dt;
    if (!state.blackoutActive && state.blackoutTimer >= env.blackoutIntervalSec) {
      state.blackoutActive = true;
      state.blackoutTimer = 0;
      audio.playBlackout(true);
      ui.blackoutBanner.classList.remove("hidden");
      addLog(
        state.currentLevelId === "level_1"
          ? "[BLACKOUT] 照明と壁コンセントの電源が遮断されました！Smilers に注意し懐中電灯 (F) を確保してください！"
          : "[BLACKOUT] 照明電源が遮断されました！懐中電灯 (F) を確保してください！"
      );
    } else if (state.blackoutActive && state.blackoutTimer >= env.blackoutDurationSec) {
      state.blackoutActive = false;
      state.blackoutTimer = 0;
      audio.playBlackout(false);
      ui.blackoutBanner.classList.add("hidden");
      smilerGroup.visible = false;
      addLog("[POWER RESTORED] 蛍光灯が再点灯しました。");
    }
  }

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

  let currentLightHex = env.lightColor;
  if (env.hueShiftColors && env.hueShiftColors.length > 0) {
    const idx = Math.floor(elapsedSec / 12) % env.hueShiftColors.length;
    currentLightHex = env.hueShiftColors[idx];
    mats.ceilingEmissiveMat.color.setHex(currentLightHex);
  } else {
    mats.ceilingEmissiveMat.color.setHex(state.blackoutActive ? 0x0b0b0c : env.lightColor);
  }

  ambientLight.intensity = state.blackoutActive ? 0.03 : env.ambientIntensity;
  updatePointLightPool(elapsedSec, currentLightHex, levelData);

  // The Hub multi-language wall-mounted TV broadcast cycle (every 8s)
  if (state.currentLevelId === "the_hub" && mats.shared?.newsTvCanvas && mats.shared?.newsTvTex) {
    state.tvTimer += dt;
    if (state.tvTimer >= 8.0) {
      state.tvTimer = 0;
      state.tvChannelIdx = (state.tvChannelIdx + 1) % NEWS_BROADCASTS.length;
      paintNewsBroadcastCanvas(mats.shared.newsTvCanvas, state.tvChannelIdx);
      mats.shared.newsTvTex.needsUpdate = true;
    }
  }

  // Manila Room passive dwell-time exit (Wiki: remaining for extended period leads to Level 1 or Level 2)
  if (state.currentLevelId === "manila_room") {
    state.manilaDwellSec += dt;
    if (state.manilaDwellSec >= 10 && state.manilaWarnStep < 1) {
      state.manilaWarnStep = 1;
      addLog("[MANILA ROOM] 壁紙の安らぎにより五感が鈍くなっていく…（このまま滞在すると別階層へ移行します）");
    } else if (state.manilaDwellSec >= 20 && state.manilaWarnStep < 2) {
      state.manilaWarnStep = 2;
      addLog("[MANILA ROOM] 壁の奥からの囁きが強まる……（まもなく Level 1 / Level 2 へ空間転移）");
    } else if (state.manilaDwellSec >= 30) {
      const res = evaluateTransition({
        currentLevelId: "manila_room",
        triggerType: TRIGGER_TYPES.MANILA_REST,
        worldSeed: state.worldSeed,
        playerPos: { x: state.player.x, z: state.player.z },
        context: {},
      });
      if (res.allowed) {
        audio.playDoorTransition();
        triggerGlitchFlash();
        switchLevel(res.targetLevelId, res.spawnPos, res.reason);
        return;
      }
    }
  }

  // Level 2 seismic tremor events (Wiki: frequent Ring-of-Fire magnitude earthquakes)
  if (state.currentLevelId === "level_2") {
    state.l2TremorTimer += dt;
    if (state.l2TremorTimer >= 42.0) {
      state.l2TremorTimer = 0;
      state.l2TremorActiveTimer = 2.4;
      audio.playTremor();
      addLog("[SEISMIC] 環太平洋帯並みの地震を検知 — 保守坑道が振動しています");
    }
    if (state.l2TremorActiveTimer > 0) {
      state.l2TremorActiveTimer = Math.max(0, state.l2TremorActiveTimer - dt);
    }
  }

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
    const levelData = getLevelData(state.currentLevelId);

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

    const isCrouching =
      state.player.crouching ||
      state.keysPressed.has("ControlLeft") ||
      state.keysPressed.has("ControlRight");
    const targetEyeH = isCrouching ? CROUCH_EYE_HEIGHT : STAND_EYE_HEIGHT;
    state.player.eyeHeight += (targetEyeH - state.player.eyeHeight) * Math.min(1, dt * 12);

    // Damped impulse knockback from hazards + false puddle cooldown
    if (state.player.falsePuddleCooldown > 0) {
      state.player.falsePuddleCooldown = Math.max(0, state.player.falsePuddleCooldown - dt);
    }
    const damp = Math.exp(-8 * dt);
    state.player.knockbackVx *= damp;
    state.player.knockbackVz *= damp;
    if (Math.abs(state.player.knockbackVx) < 0.02) state.player.knockbackVx = 0;
    if (Math.abs(state.player.knockbackVz) < 0.02) state.player.knockbackVz = 0;

    const moving = forward !== 0 || strafe !== 0;
    let vx = state.player.knockbackVx * dt;
    let vz = state.player.knockbackVz * dt;
    let speed = WALK_SPEED;

    if (moving) {
      const len = Math.hypot(forward, strafe);
      const nf = forward / len;
      const ns = strafe / len;
      speed = isCrouching
        ? CROUCH_SPEED
        : state.keysPressed.has("ShiftLeft") || state.keysPressed.has("ShiftRight")
        ? SPRINT_SPEED
        : WALK_SPEED;

      const sinY = Math.sin(state.player.yaw);
      const cosY = Math.cos(state.player.yaw);
      vx += (-sinY * nf + cosY * ns) * speed * dt;
      vz += (-cosY * nf - sinY * ns) * speed * dt;
    }

    const prevPlayerX = state.player.x;
    const prevPlayerZ = state.player.z;

    if (moving || vx !== 0 || vz !== 0) {
      const resolved = chunkManager.resolveCollision(
        state.player.x + vx,
        state.player.z + vz,
        PLAYER_RADIUS,
        state.player.feetY
      );
      state.player.x = resolved.x;
      state.player.z = resolved.z;

      const streamRes = chunkManager.update(state.player.x, state.player.z);
      if (streamRes.loadedKeys.length > 0 || streamRes.unloadedKeys.length > 0) {
        updateChunkVisibility();
        updateHudTelemetry();
      }
    }

    if (ENABLE_L0_NON_EUCLIDEAN_SHIFT && state.currentLevelId === "level_0") {
      state.l0ShiftTimer += dt;
      state.l0ShiftDistAccum += Math.hypot(state.player.x - prevPlayerX, state.player.z - prevPlayerZ);
      if (state.l0ShiftLogCooldown > 0) {
        state.l0ShiftLogCooldown = Math.max(0, state.l0ShiftLogCooldown - dt);
      }
      const curCoord = chunkManager.worldToChunk(state.player.x, state.player.z);
      const curKey = `${curCoord.cx}:${curCoord.cz}`;
      const crossedChunk = state.l0LastChunkKey !== "" && curKey !== state.l0LastChunkKey;
      state.l0LastChunkKey = curKey;

      if (state.l0ShiftTimer >= 3.5 && (state.l0ShiftDistAccum >= 4.5 || crossedChunk)) {
        camera.position.set(
          state.player.x,
          state.player.feetY + state.player.eyeHeight + state.player.landDip + state.player.hazardDip,
          state.player.z
        );
        camera.rotation.order = "YXZ";
        camera.rotation.y = state.player.yaw;
        camera.rotation.x = state.player.pitch;
        camera.updateMatrixWorld();
        shiftProjMatrix.multiplyMatrices(camera.projectionMatrix, camera.matrixWorldInverse);
        shiftFrustum.setFromProjectionMatrix(shiftProjMatrix);

        const forwardX = -Math.sin(state.player.yaw);
        const forwardZ = -Math.cos(state.player.yaw);
        const isPointVisible = (wx, wz) => {
          for (const py of [0.2, 1.6, 3.0]) {
            shiftProbeVec.set(wx, py, wz);
            if (shiftFrustum.containsPoint(shiftProbeVec)) return true;
          }
          return false;
        };

        const shiftRes = chunkManager.tryNonEuclideanShift(
          state.player.x,
          state.player.z,
          forwardX,
          forwardZ,
          { isPointVisible }
        );
        if (shiftRes.shifted) {
          state.l0ShiftTimer = 0;
          state.l0ShiftDistAccum = 0;
          audio.playSpatialShiftHum();
          if (state.l0ShiftLogCooldown <= 0) {
            state.l0ShiftLogCooldown = 22.0;
            addLog(
              shiftRes.mode === "rear_chunk"
                ? "[NON-EUCLIDEAN] 背後で通過済みの空間区画が別構造へと組み替わった気配がする……"
                : "[NON-EUCLIDEAN] 視界外の背後で壁と角の配置が静かに変化した気配がする……"
            );
          }
        }
      }
    }

    // Ground elevation (The Hub raised sidewalk curb vs roadbed)
    let groundY = 0;
    if (state.currentLevelId === "the_hub") {
      const cz = Math.floor(state.player.z / CHUNK_WORLD_SIZE);
      if (cz % 2 === 0) {
        const localZ = ((state.player.z % CHUNK_WORLD_SIZE) + CHUNK_WORLD_SIZE) % CHUNK_WORLD_SIZE;
        if (localZ < 2.25 || (localZ > 9.75 && localZ < 12.0)) {
          groundY = 0.22;
        }
      }
    }

    // Vertical Jump / Gravity / Ceiling Clearance / Landing Dip
    if (!state.player.grounded) {
      state.player.vy -= GRAVITY * dt;
      state.player.feetY += state.player.vy * dt;
      const maxFeetY = Math.max(groundY, levelData.environment.ceilingHeight - state.player.eyeHeight - 0.14);
      if (state.player.feetY > maxFeetY) {
        state.player.feetY = maxFeetY;
        if (state.player.vy > 0) state.player.vy = 0;
      }
      if (state.player.feetY <= groundY) {
        const impact = Math.abs(state.player.vy);
        state.player.feetY = groundY;
        state.player.vy = 0;
        state.player.grounded = true;
        if (impact > 2.2) {
          state.player.landDip = -Math.min(0.14, impact * 0.02);
          audio.playLand(state.currentLevelId);
        }
      }
    } else {
      state.player.feetY += (groundY - state.player.feetY) * Math.min(1, dt * 14);
    }

    const dipDamp = Math.exp(-10 * dt);
    state.player.landDip *= dipDamp;
    state.player.hazardDip *= dipDamp;

    // Level 1 smooth puddle splash & False Puddle damped escape (jumpable above feetY >= 0.12)
    let steppedFoot = false;
    if (moving && state.player.grounded) {
      state.player.bobPhase += dt * (speed > WALK_SPEED ? 13 : isCrouching ? 6.5 : 9);
      state.player.stepAccum += speed * dt;
      if (state.player.stepAccum >= (isCrouching ? 1.6 : 2.15)) {
        state.player.stepAccum = 0;
        steppedFoot = true;
        audio.playFootstep(state.currentLevelId);
      }
    } else if (!moving) {
      state.player.bobPhase = 0;
    }

    if (state.currentLevelId === "level_1" && state.player.feetY < 0.12) {
      const { cx: pcx, cz: pcz } = chunkManager.worldToChunk(state.player.x, state.player.z);
      const curChunk = chunkManager.chunks.get(`${state.currentLevelId}:${pcx}:${pcz}`);
      if (curChunk) {
        for (const p of curChunk.props) {
          if (p.kind !== "PUDDLE") continue;
          const dx = state.player.x - p.x;
          const dz = state.player.z - p.z;
          const dist = Math.hypot(dx, dz);
          if (p.isFalsePuddle && dist <= p.radius * 0.78 && state.player.falsePuddleCooldown <= 0) {
            state.player.falsePuddleCooldown = 2.5;
            state.player.hazardDip = -0.26;
            const inv = dist > 0.05 ? 1 / dist : 0;
            const dirX = dist > 0.05 ? dx * inv : Math.sin(state.player.yaw);
            const dirZ = dist > 0.05 ? dz * inv : Math.cos(state.player.yaw);
            state.player.knockbackVx = dirX * 4.2;
            state.player.knockbackVz = dirZ * 4.2;
            audio.playPuddleSplash();
            addLog("[HAZARD] False Puddle に足を踏み入れた！鋭い歯に引きずり込まれる前に這い上がった！");
            break;
          }
          if (!p.isFalsePuddle && steppedFoot && dist <= p.radius) {
            audio.playPuddleSplash();
            break;
          }
        }
      }
    }

    state.player.y =
      state.player.feetY + state.player.eyeHeight + state.player.landDip + state.player.hazardDip;

    const tremorAmp = state.l2TremorActiveTimer > 0 ? 0.045 * (state.l2TremorActiveTimer / 2.4) : 0;
    const shakeX = tremorAmp > 0 ? Math.sin(elapsedSec * 52) * tremorAmp : 0;
    const shakeY = tremorAmp > 0 ? Math.cos(elapsedSec * 61) * tremorAmp : 0;
    const bobOffset =
      moving && state.player.grounded
        ? Math.sin(state.player.bobPhase) * (isCrouching ? 0.022 : 0.045)
        : 0;
    camera.position.set(state.player.x + shakeX, state.player.y + bobOffset + shakeY, state.player.z);
    camera.rotation.order = "YXZ";
    camera.rotation.y = state.player.yaw;
    camera.rotation.x = state.player.pitch;

    const nearest = chunkManager.findNearestInteractable(state.player.x, state.player.z, 3.0);
    const colProbe = chunkManager.resolveCollision(state.player.x, state.player.z, PLAYER_RADIUS, state.player.feetY);
    if (nearest) {
      ui.hudPrompt.textContent = nearest.label;
    } else if (colProbe.nearbyGlitchWall) {
      ui.hudPrompt.textContent = "空間の不安定境界を検知 — [N] キーでノークリップ";
    } else if (state.pointerLocked) {
      ui.hudPrompt.textContent =
        "WASD移動 | Shiftダッシュ | Spaceジャンプ | C(Ctrl)しゃがみ | F懐中電灯 | E調べる | Nノークリップ";
    }

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

configureChunkStreamRadius("level_0");
applyLevelEnvironment("level_0");
chunkManager.update(state.player.x, state.player.z);
updateChunkVisibility();
updatePointLightPool(0, getLevelData("level_0").environment.lightColor, getLevelData("level_0"));
updateHudTelemetry();
requestAnimationFrame(animate);
