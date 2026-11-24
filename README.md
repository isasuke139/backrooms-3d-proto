# The Backrooms Wiki 3D FPS Exploration Prototype

> **ライセンスおよび一次出典 (CC-BY-SA-3.0)**  
> 本プロトタイプおよび関連テキスト・画像・メタデータは、Fandom版「The Backrooms Wiki」（[https://backrooms.fandom.com/wiki/Backrooms_Wiki](https://backrooms.fandom.com/wiki/Backrooms_Wiki)）の一次記事を出典としており、**[CC-BY-SA-3.0](https://creativecommons.org/licenses/by-sa/3.0/)** ライセンスの下で提供されます。

---

## 1. クイックスタート

```bash
cd /content/work_br_wiki
python3 -m http.server 8080
```

ブラウザで `http://localhost:8080/src/` を開いてください。（`src/` をルートとして配信した場合も `./assets/textures/` からWiki画像が読み込まれ、`file://` 直開きやオフライン時は自動的に Canvas 2D プロシージャルテクスチャへフォールバックします。）

---

## 2. 操作方法

| キー / 操作 | 機能 |
| :--- | :--- |
| `W / A / S / D`（`↑ / ↓`） | 移動・ストレイフ |
| `Shift` | ダッシュ |
| マウス移動 (Pointer Lock) / `← / →` / `Q` | 視点回転 |
| `F` | 懐中電灯 ON/OFF |
| `E` | インタラクト（階段 / 扉 / Manila休息 / Door B→A / Object 2 Level Key 取得） |
| `N` | 不安定壁・コンセント壁面からのノークリップ (Noclip) |
| `M` | Web Audio API 効果音・環境音ミュート切替 |
| `H` | HUD 表示切替 |

---

## 3. 実装階層と Backrooms Wiki 一次準拠ポイント

1. **Level 0: "The Lobby"** (`https://backrooms.fandom.com/wiki/Level_0`)
   - 黄ばんだ矢印壁紙・湿潤カーペット・不規則配置の蛍光灯と 60/120/180Hz ハム音。
   - **Phenomenon 15**（実体・他探索者ゼロの孤立空間）準拠。
   - ノークリップ（`N`）、120m以上の長距離移動による Level 1 への自然移行（`DISTANCE_DRIFT`）、上り階段、および東側隣接チャンク `(1, 0)` の **The Manila Room** 入口を実装。
2. **The Manila Room** (`https://backrooms.fandom.com/wiki/Level_0#The_Manila_Room`)
   - マニラ調壁紙、暗いオレンジ色の単一照明、壁の背後からの微かな囁き音響、Phenomenon 12 停電、および Level 1 / Level 2 への安定脱出。
3. **Level 1: "The Parking Lot"** (`https://backrooms.fandom.com/wiki/Level_1`)
   - 天井高4.5mのコンクリート駐車場・無銘車両・Hydrolitis水たまり・突発ブラックアウト（停電時 Smilers の眼が暗所に現れ、懐中電灯で消滅）。
   - **Object 2 (Level Key)** ドロップ配置、および **The Hub 確定シーケンス（Door B → Door A）** を実装。
4. **The Hub** (`https://backrooms.fandom.com/wiki/The_Hub`, `Class Nexus`)
   - 地下トンネル・アスファルト道路・天井配管・色相変化する照明・氷点下空調音響。
   - 階層カラー別に装飾された金属製 Level Doors（`Object 2: Level Key` 所持時に解錠遷移可能）。
5. **Level 2: "Pipe Dreams"** (`https://backrooms.fandom.com/wiki/Level_2`)
   - 錆びた配管と高圧蒸気音の狭隘保守トンネル、非常口（Fire Exit）およびノークリップ帰還経路。

---

## 4. デュアルテクスチャ読込 & 疎結合モジュール設計（Godot 4.3 MMO拡張対応）

- **デュアルテクスチャローダー (`LevelMaterialCache`)**: 起動直後に `createProceduralTextureCanvas()` で即座に描画可能なプロシージャルテクスチャを割り当て、非同期で `./assets/textures/` および `../dataset/images/` の取得済み Wiki 画像を読み込み成功時のみ差し替えます。
- **純粋ESモジュール分離**:
  - `lore_data.js`: 階層・エンティティ・出典URL・CC-BY-SA-3.0メタデータ（DOM非依存 → Godot `.tres` 変換対応）
  - `world_gen.js`: シード決定論的 8×8 チャンク迷宮生成・境界シーム整合・AABB衝突解決・遠方破棄（`loadRadius=2`, `unloadRadius=3`）
  - `transition_rules.js`: ノークリップ・Door B→A・Level Key 判定の純粋ステート評価器（Godot サーバー権威 `TransitionAuthority` 対応）
  - `audio_synth.js`: Web Audio API 階層別プロシージャル音響
  - `main.js`: Three.js WebGL 描画・入力・HUD プレゼンテーション層

---

## 5. 自動検証テストの実行

```bash
cd /content/work_br_wiki
node test_backrooms.js
```

全検証結果の詳細は `/content/work_br_wiki/test_report.txt` に出力されます。

---

## 6. 一次出典リンク一覧 (CC-BY-SA-3.0)

- Backrooms Wiki Main: https://backrooms.fandom.com/wiki/Backrooms_Wiki
- Level 0: https://backrooms.fandom.com/wiki/Level_0
- Level 1: https://backrooms.fandom.com/wiki/Level_1
- The Hub: https://backrooms.fandom.com/wiki/The_Hub
- Level 2: https://backrooms.fandom.com/wiki/Level_2
- Object 1 (Almond Water): https://backrooms.fandom.com/wiki/Object_1
- Object 2 (Level Keys): https://backrooms.fandom.com/wiki/Object_2
- License Deed: https://creativecommons.org/licenses/by-sa/3.0/
