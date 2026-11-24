/**
 * Deterministic Backrooms level transition rules and Noclip state evaluator.
 *
 * Pure ES module with zero DOM or Three.js dependencies.
 * Designed to mirror a future Godot 4.3 server-authoritative TransitionAuthority.
 *
 * Source: The Backrooms Wiki (Fandom) — https://backrooms.fandom.com/wiki/Backrooms_Wiki
 * License: CC-BY-SA-3.0 — https://creativecommons.org/licenses/by-sa/3.0/
 */

import { LEVELS } from "./lore_data.js";

const CHUNK_WORLD_SIZE = 24.0;

export const TRIGGER_TYPES = Object.freeze({
  NOCLIP_WALL: "NOCLIP_WALL",
  DISTANCE_DRIFT: "DISTANCE_DRIFT",
  MANILA_ENTER: "MANILA_ENTER",
  MANILA_REST: "MANILA_REST",
  HUB_SEQUENCE: "HUB_SEQUENCE",
  HUB_DOOR: "HUB_DOOR",
  STAIRWELL: "STAIRWELL",
  OUTLET_NOCLIP: "OUTLET_NOCLIP",
  EXIT_DOOR: "EXIT_DOOR",
});

export const TRANSITION_GRAPH = Object.freeze([
  {
    id: "L0_NOCLIP",
    from: "level_0",
    to: ["level_1", "level_2"],
    trigger: TRIGGER_TYPES.NOCLIP_WALL,
    label: "壁面境界からのノークリップ（Level 1 / Level 2）",
    wikiCitation: "https://backrooms.fandom.com/wiki/Level_0#Exits",
  },
  {
    id: "L0_DRIFT_L1",
    from: "level_0",
    to: ["level_1"],
    trigger: TRIGGER_TYPES.DISTANCE_DRIFT,
    label: "長距離彷徨によるガレージ境界への自然移行（≥120m）",
    wikiCitation: "https://backrooms.fandom.com/wiki/Level_0#Exits",
  },
  {
    id: "L0_STAIRS_L1",
    from: "level_0",
    to: ["level_1"],
    trigger: TRIGGER_TYPES.STAIRWELL,
    label: "階段を上って Level 1 へ移動",
    wikiCitation: "https://backrooms.fandom.com/wiki/Level_1#Entrances",
  },
  {
    id: "L0_MANILA",
    from: "level_0",
    to: ["manila_room"],
    trigger: TRIGGER_TYPES.MANILA_ENTER,
    label: "空間異常 The Manila Room へ入室",
    wikiCitation: "https://backrooms.fandom.com/wiki/Level_0#The_Manila_Room",
  },
  {
    id: "MANILA_EXIT",
    from: "manila_room",
    to: ["level_1", "level_2"],
    trigger: TRIGGER_TYPES.MANILA_REST,
    label: "Manila Room 内での滞在・休息による脱出（Level 1 / Level 2）",
    wikiCitation: "https://backrooms.fandom.com/wiki/Level_0#The_Manila_Room",
  },
  {
    id: "MANILA_BACK_L0",
    from: "manila_room",
    to: ["level_0"],
    trigger: TRIGGER_TYPES.EXIT_DOOR,
    label: "Level 0 の黄色い廊下へ戻る",
    wikiCitation: "https://backrooms.fandom.com/wiki/Level_0#The_Manila_Room",
  },
  {
    id: "L1_STAIRS",
    from: "level_1",
    to: ["level_0", "level_2"],
    trigger: TRIGGER_TYPES.STAIRWELL,
    label: "階段による階層移動（Level 0 / Level 2）",
    wikiCitation: "https://backrooms.fandom.com/wiki/Level_1#Exits",
  },
  {
    id: "L1_HUB_SEQ",
    from: "level_1",
    to: ["the_hub"],
    trigger: TRIGGER_TYPES.HUB_SEQUENCE,
    label: "Door B → Door A 確定シーケンスによる The Hub 到達",
    wikiCitation: "https://backrooms.fandom.com/wiki/Level_1#Exits",
  },
  {
    id: "L1_OUTLET_NOCLIP",
    from: "level_1",
    to: ["level_2", "level_0"],
    trigger: TRIGGER_TYPES.OUTLET_NOCLIP,
    label: "コンセント付き壁面からのノークリップ（Wiki上 Level 188／試作版は隣接実装階層）",
    wikiCitation: "https://backrooms.fandom.com/wiki/Level_1#Exits",
  },
  {
    id: "HUB_KEY_DOOR",
    from: "the_hub",
    to: ["level_0", "level_1", "level_2"],
    trigger: TRIGGER_TYPES.HUB_DOOR,
    label: "Object 2 (Level Key) による番号付き階層ドアの解錠遷移",
    wikiCitation: "https://backrooms.fandom.com/wiki/The_Hub#Exits",
  },
  {
    id: "L2_FIRE_EXIT",
    from: "level_2",
    to: ["level_1"],
    trigger: TRIGGER_TYPES.EXIT_DOOR,
    label: "非常口 (Fire Exit) / 狭い這い穴からの Level 1 帰還遷移",
    wikiCitation: "https://backrooms.fandom.com/wiki/Level_2#Exits",
  },
]);

function deterministicRoll(worldSeed, tag, cx, cz) {
  let h = (Number(worldSeed) || 1999) >>> 0;
  const input = `${tag}:${cx}:${cz}`;
  for (let i = 0; i < input.length; i += 1) {
    h ^= input.charCodeAt(i);
    h = Math.imul(h, 0x01000193) >>> 0;
  }
  h ^= h >>> 16;
  h = Math.imul(h, 0x85ebca6b) >>> 0;
  h ^= h >>> 13;
  h = Math.imul(h, 0xc2b2ae35) >>> 0;
  h ^= h >>> 16;
  return (h >>> 0) / 4294967296;
}

function defaultSpawnFor(targetLevelId) {
  if (!LEVELS[targetLevelId]) {
    return { x: 1.5, z: 1.5 };
  }
  return { x: 1.5, z: 1.5 };
}

/**
 * Pure deterministic evaluator for level transitions & noclip triggers.
 */
export function evaluateTransition({
  currentLevelId,
  triggerType,
  worldSeed = 1999,
  playerPos = { x: 0, z: 0 },
  context = {},
}) {
  const px = Number(playerPos?.x ?? 0);
  const pz = Number(playerPos?.z ?? 0);
  const cx = Math.floor(px / CHUNK_WORLD_SIZE);
  const cz = Math.floor(pz / CHUNK_WORLD_SIZE);

  if (!LEVELS[currentLevelId]) {
    return {
      allowed: false,
      targetLevelId: null,
      ruleId: "INVALID_SOURCE_LEVEL",
      reason: `未知の現在階層: ${currentLevelId}`,
      wikiCitation: "https://backrooms.fandom.com/wiki/Backrooms_Wiki",
      spawnPos: { x: 1.5, z: 1.5 },
      requiresKey: false,
    };
  }

  // LEVEL 0 rules
  if (currentLevelId === "level_0") {
    if (triggerType === TRIGGER_TYPES.NOCLIP_WALL) {
      const roll = deterministicRoll(worldSeed, "l0_noclip", cx, cz);
      const target = roll < 0.7 ? "level_1" : "level_2";
      return {
        allowed: true,
        targetLevelId: target,
        ruleId: "L0_NOCLIP",
        reason: `壁面ノークリップ成功 → ${LEVELS[target].name} へ転移`,
        wikiCitation: "https://backrooms.fandom.com/wiki/Level_0#Exits",
        spawnPos: defaultSpawnFor(target),
        requiresKey: false,
      };
    }
    if (triggerType === TRIGGER_TYPES.DISTANCE_DRIFT) {
      const dist = Math.hypot(px, pz);
      if (dist >= 120) {
        return {
          allowed: true,
          targetLevelId: "level_1",
          ruleId: "L0_DRIFT_L1",
          reason: `長距離彷徨 (${dist.toFixed(1)}m ≥ 120m) により空間が Level 1 の駐車場へ変質`,
          wikiCitation: "https://backrooms.fandom.com/wiki/Level_0#Exits",
          spawnPos: defaultSpawnFor("level_1"),
          requiresKey: false,
        };
      }
      return {
        allowed: false,
        targetLevelId: null,
        ruleId: "L0_DRIFT_TOO_CLOSE",
        reason: `長距離移行には 120m 以上の移動が必要です (現在 ${dist.toFixed(1)}m)`,
        wikiCitation: "https://backrooms.fandom.com/wiki/Level_0#Exits",
        spawnPos: defaultSpawnFor("level_0"),
        requiresKey: false,
      };
    }
    if (triggerType === TRIGGER_TYPES.STAIRWELL || triggerType === TRIGGER_TYPES.EXIT_DOOR) {
      const target =
        context.targetLevelId && LEVELS[context.targetLevelId]
          ? context.targetLevelId
          : "level_1";
      return {
        allowed: true,
        targetLevelId: target,
        ruleId: "L0_STAIRS_L1",
        reason: `階段を経由して ${LEVELS[target].name} へ到達`,
        wikiCitation: "https://backrooms.fandom.com/wiki/Level_1#Entrances",
        spawnPos: defaultSpawnFor(target),
        requiresKey: false,
      };
    }
    if (triggerType === TRIGGER_TYPES.MANILA_ENTER) {
      return {
        allowed: true,
        targetLevelId: "manila_room",
        ruleId: "L0_MANILA",
        reason: "マニラ模様の壁紙が漂う空間異常 The Manila Room へ入室",
        wikiCitation: "https://backrooms.fandom.com/wiki/Level_0#The_Manila_Room",
        spawnPos: defaultSpawnFor("manila_room"),
        requiresKey: false,
      };
    }
  }

  // MANILA ROOM rules
  if (currentLevelId === "manila_room") {
    if (triggerType === TRIGGER_TYPES.MANILA_REST) {
      let target;
      if (["level_1", "level_2", "level_0"].includes(context.preferredTarget)) {
        target = context.preferredTarget;
      } else {
        const roll = deterministicRoll(worldSeed, "manila_exit", cx, cz);
        target = roll < 0.5 ? "level_1" : "level_2";
      }
      return {
        allowed: true,
        targetLevelId: target,
        ruleId: "MANILA_EXIT",
        reason: `Manila Room での滞在により ${LEVELS[target].name} へ安定脱出`,
        wikiCitation: "https://backrooms.fandom.com/wiki/Level_0#The_Manila_Room",
        spawnPos: defaultSpawnFor(target),
        requiresKey: false,
      };
    }
    if (triggerType === TRIGGER_TYPES.EXIT_DOOR || triggerType === TRIGGER_TYPES.STAIRWELL) {
      return {
        allowed: true,
        targetLevelId: "level_0",
        ruleId: "MANILA_BACK_L0",
        reason: "Level 0 の黄色い廊下へ帰還",
        wikiCitation: "https://backrooms.fandom.com/wiki/Level_0#The_Manila_Room",
        spawnPos: defaultSpawnFor("level_0"),
        requiresKey: false,
      };
    }
    if (triggerType === TRIGGER_TYPES.NOCLIP_WALL) {
      const roll = deterministicRoll(worldSeed, "manila_noclip", cx, cz);
      const target = roll < 0.5 ? "level_1" : "level_2";
      return {
        allowed: true,
        targetLevelId: target,
        ruleId: "MANILA_NOCLIP",
        reason: `Manila Room からのノークリップ → ${LEVELS[target].name}`,
        wikiCitation: "https://backrooms.fandom.com/wiki/Level_0#The_Manila_Room",
        spawnPos: defaultSpawnFor(target),
        requiresKey: false,
      };
    }
  }

  // LEVEL 1 rules
  if (currentLevelId === "level_1") {
    if (triggerType === TRIGGER_TYPES.HUB_SEQUENCE) {
      if (context.sequenceStep === "door_a_after_b" || context.sequenceCompleted === true) {
        return {
          allowed: true,
          targetLevelId: "the_hub",
          ruleId: "L1_HUB_SEQ",
          reason: "Door B → Door A 確定シーケンス完了！ The Hub へ到達",
          wikiCitation: "https://backrooms.fandom.com/wiki/Level_1#Exits",
          spawnPos: defaultSpawnFor("the_hub"),
          requiresKey: false,
        };
      }
      return {
        allowed: false,
        targetLevelId: null,
        ruleId: "L1_HUB_SEQ_INCOMPLETE",
        reason: "Door B → Door A sequence required (先に Door B を通過してください)",
        wikiCitation: "https://backrooms.fandom.com/wiki/Level_1#Exits",
        spawnPos: defaultSpawnFor("level_1"),
        requiresKey: false,
      };
    }
    if (triggerType === TRIGGER_TYPES.STAIRWELL || triggerType === TRIGGER_TYPES.EXIT_DOOR) {
      const target =
        context.targetLevelId === "level_0" || context.targetLevelId === "level_2"
          ? context.targetLevelId
          : "level_2";
      return {
        allowed: true,
        targetLevelId: target,
        ruleId: "L1_STAIRS",
        reason: `階段・無施錠扉を経由して ${LEVELS[target].name} へ移動`,
        wikiCitation: "https://backrooms.fandom.com/wiki/Level_1#Exits",
        spawnPos: defaultSpawnFor(target),
        requiresKey: false,
      };
    }
    if (triggerType === TRIGGER_TYPES.OUTLET_NOCLIP || triggerType === TRIGGER_TYPES.NOCLIP_WALL) {
      const roll = deterministicRoll(worldSeed, "l1_noclip", cx, cz);
      const target = roll < 0.65 ? "level_2" : "level_0";
      return {
        allowed: true,
        targetLevelId: target,
        ruleId: "L1_OUTLET_NOCLIP",
        reason: `壁コンセント境界からのノークリップ（Wiki上 Level 188 行き／試作版は ${LEVELS[target].name} へ転送）`,
        wikiCitation: "https://backrooms.fandom.com/wiki/Level_1#Exits",
        spawnPos: defaultSpawnFor(target),
        requiresKey: false,
      };
    }
  }

  // THE HUB rules
  if (currentLevelId === "the_hub") {
    if (triggerType === TRIGGER_TYPES.HUB_DOOR) {
      const target = context.targetLevelId;
      if (target === "manila_room") {
        return {
          allowed: false,
          targetLevelId: null,
          ruleId: "HUB_NO_MANILA_DOOR",
          reason: "Manila Room は Level 0 内部の空間異常のため The Hub に直通扉は存在しません",
          wikiCitation: "https://backrooms.fandom.com/wiki/The_Hub#Exits",
          spawnPos: defaultSpawnFor("the_hub"),
          requiresKey: false,
        };
      }
      if (!context.hasLevelKey) {
        return {
          allowed: false,
          targetLevelId: null,
          ruleId: "HUB_KEY_REQUIRED",
          reason: "Object 2 (Level Key) required — 周囲の台座から Level Key を取得してください",
          wikiCitation: "https://backrooms.fandom.com/wiki/Object_2",
          spawnPos: defaultSpawnFor("the_hub"),
          requiresKey: true,
        };
      }
      if (!target || !LEVELS[target] || target === "the_hub") {
        return {
          allowed: false,
          targetLevelId: null,
          ruleId: "HUB_INVALID_TARGET",
          reason: `無効な扉の遷移先: ${String(target)}`,
          wikiCitation: "https://backrooms.fandom.com/wiki/The_Hub#Exits",
          spawnPos: defaultSpawnFor("the_hub"),
          requiresKey: true,
        };
      }
      return {
        allowed: true,
        targetLevelId: target,
        ruleId: "HUB_KEY_DOOR",
        reason: `Level Key で解錠し ${LEVELS[target].name} へ転移`,
        wikiCitation: "https://backrooms.fandom.com/wiki/The_Hub#Exits",
        spawnPos: defaultSpawnFor(target),
        requiresKey: true,
      };
    }
    if (triggerType === TRIGGER_TYPES.NOCLIP_WALL || triggerType === TRIGGER_TYPES.EXIT_DOOR) {
      const target =
        context.targetLevelId &&
        LEVELS[context.targetLevelId] &&
        context.targetLevelId !== "the_hub" &&
        context.targetLevelId !== "manila_room"
          ? context.targetLevelId
          : "level_1";
      return {
        allowed: true,
        targetLevelId: target,
        ruleId: "HUB_FALLBACK_EXIT",
        reason: `トンネル境界から ${LEVELS[target].name} へ転移`,
        wikiCitation: "https://backrooms.fandom.com/wiki/The_Hub#Exits",
        spawnPos: defaultSpawnFor(target),
        requiresKey: false,
      };
    }
  }

  // LEVEL 2 rules
  if (currentLevelId === "level_2") {
    if (triggerType === TRIGGER_TYPES.STAIRWELL || triggerType === TRIGGER_TYPES.EXIT_DOOR) {
      if (context.targetLevelId && context.targetLevelId !== "level_1") {
        return {
          allowed: false,
          targetLevelId: null,
          ruleId: "L2_NON_CANON_EXIT",
          reason: `Level 2 からは非公式遷移先 (${context.targetLevelId}) へは直接戻れません（Fire Exit / 這い穴 → Level 1）`,
          wikiCitation: "https://backrooms.fandom.com/wiki/Level_2#Exits",
          spawnPos: defaultSpawnFor("level_2"),
          requiresKey: false,
        };
      }
      return {
        allowed: true,
        targetLevelId: "level_1",
        ruleId: "L2_FIRE_EXIT",
        reason: `非常口 / 狭い這い穴から ${LEVELS.level_1.name} へ帰還`,
        wikiCitation: "https://backrooms.fandom.com/wiki/Level_2#Exits",
        spawnPos: defaultSpawnFor("level_1"),
        requiresKey: false,
      };
    }
    if (triggerType === TRIGGER_TYPES.NOCLIP_WALL) {
      return {
        allowed: true,
        targetLevelId: "level_1",
        ruleId: "L2_NOCLIP",
        reason: `保守管路壁面からのノークリップ → ${LEVELS.level_1.name}`,
        wikiCitation: "https://backrooms.fandom.com/wiki/Level_2#Exits",
        spawnPos: defaultSpawnFor("level_1"),
        requiresKey: false,
      };
    }
  }

  return {
    allowed: false,
    targetLevelId: null,
    ruleId: "UNSUPPORTED_TRIGGER",
    reason: `${currentLevelId} ではトリガー ${triggerType} は使用できません`,
    wikiCitation: LEVELS[currentLevelId].wikiUrl,
    spawnPos: defaultSpawnFor(currentLevelId),
    requiresKey: false,
  };
}

export function getAvailableExits(levelId) {
  return TRANSITION_GRAPH.filter((edge) => edge.from === levelId);
}
