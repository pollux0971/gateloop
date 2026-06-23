# GateLoop 重定向計劃書 — 從「閘的harness」回到「專案驅動、規則即資料」

> 狀態：Proposed（設計定向，尚未動工；`real_api_calls` 維持 `false`）
> 日期：2026-06-23
> 作者：pollux
> 取代/修訂：`docs/architecture/25_GATE_PHILOSOPHY.md`（降格為本計劃的下位文件）、`README_for_release.md`（identity 段落）、`GATELOOP_DEVELOPMENT_PLAN.md`（§0 護欄負擔大幅消解）
> 一句話：**只硬編碼會「產生價值」的流程（BMAD planning spine），把所有「限制」變成資料，沙箱是唯一靠程式守住的牆。**

---

## 0. 為什麼要寫這份（走偏的根因）

我原本的北極星（workspace `README.md`）是：**專案驅動、可復用、可視化配置的 agent 開發工作流**。
但實際做出來的東西（`README_for_release.md` + `GATELOOP_DEVELOPMENT_PLAN.md` + `gate-control`）變成了另一個產品：**一套確定性安全 harness**，信條是 *agents propose, a deterministic harness disposes*、*凡事過閘*、*controllable by construction*。

這就是走偏的根因——**兩種哲學在同一個 codebase 裡互相拉扯**：

- `settings.default.yaml` 開頭白紙黑字寫「DO NOT add global gates here — they are not settings」，刻意把閘排除在可配置之外；
- `gate-control` 把四道閘（`real_api_calls` / `sudo_broker_runtime` / `bypass_workspace_runtime` / `stable_promotion`）寫死成 human-only、不可由設定開；`SettingsPanel.tsx` 還有 `GLOBAL_GATES` 常數把它們渲染成鎖死；
- 整本開發計劃書幾乎都在證明護欄（token cap、kill switch、egress 隔離、read-back）——這是**安全工程**的待辦，不是**工作流引擎**的待辦。

`25_GATE_PHILOSOPHY.md`（6/22）已經往對的方向走了一步（「gates face the agent, not the user」，把 stop 分成 agent guardrails / user-decision blockers / protect-user fallbacks）。本計劃**再往前一步**：連 agent guardrails 都降為「預設開啟的政策資料」，把「唯一靠程式守的牆」收斂到沙箱。

這份文件的目的，就是**停止拉扯、選定一條路、讓程式往那條路收斂**。

---

## 1. 設計哲學（我的想法，寫清楚）

三根支柱，缺一不可：

### 支柱一：唯一的硬編碼 = BMAD planning spine

Planning Steward 的流程（idea → 分類 → PRD（greenfield）／as-is + delta（brownfield）→ architecture → epic/story 圖 → contract）**不可配置、不可關閉、寫死成固定序列**。

理由：這條 spine 正是「漸進式上下文」的引擎——它是讓 agent 產出好東西的那個東西。下游所有角色（Supervisor 路由、Developer、Debugger、Reviewer）都吃它的產物。把它硬編碼，等於保證**每個專案、無論 greenfield 還是 brownfield，都拿到同一條有紀律的骨幹**。

這也是我從 BMAD 學到、且決定保留的唯一核心。BMAD 其餘的 30+ workflow（brainstorming、forge-idea、prfaq、party-mode、retrospective…）**一律簡化掉**，只留 planning spine + 「Ready for Development」品質標準。

### 支柱二：所有「限制」都是資料（policy-as-data）

write-set、additive 檢查、tool 授權、預算、品質門檻、forbidden zone——**全部變成一份可編輯 registry 裡的列**，有合理預設值，可在 cockpit 調。**沒有一條被烘焙進程式碼當成不可改的閘。**

程式只負責「讀 registry 並執行」，不負責「定義規則」。permission gateway 從「規則作者」降級成「規則求值器」。

### 支柱三：沙箱是唯一靠程式守住的牆

容器 + egress 隔離（已學到的教訓：**設了≠生效，必須用真實探測證明**——見 `scripts/cli-mode-e2e/prove-egress.ts`）是唯一 by construction 強制的邊界。

牆內 agent 自由；支柱二的政策資料是**品質/成本護欄，不是安全牆**——因為沙箱已經圈住爆炸半徑。這直接消解了開發計劃書 §0 那整包「每道護欄都要被 fixture 證明是唯一防線」的負擔：**一旦沙箱是真邊界，牆內那些護欄就不再是唯一防線，它們可以被使用者調鬆。**

> **誠實的小例外（不是給 agent 的限制，是保護我自己）**：
> trace/log 的 secret 遮蔽，以及沙箱邊界本身，保留為**靜默自動的預設**（對應 25 文件的 category-3「protect-the-user fallbacks」）。它們保護的是我的金鑰和我的主機，不是在限制 agent 幹活。它們是預設值，不是不可編輯的聖閘。

### 三支柱一句話總結

| 類別 | 處置 | 守在哪 |
|---|---|---|
| 產生價值的流程（BMAD planning spine） | **硬編碼**、不可關 | 程式碼 |
| 限制 agent 的規則（write-set/budget/quality/tool grant…） | **降為資料**、預設開、可在 cockpit 調 | `rule_registry.yaml` |
| 安全邊界 | **唯一硬牆**、真實探測證明 | 沙箱（容器 + egress） |

---

## 2. ADR 異動清單

### 2.1 既有 ADR 的處置

| ADR | 標題 | 處置 | 說明 |
|---|---|---|---|
| ADR-0001 | use-typescript-monorepo | **保留** | 不受影響。 |
| ADR-0002 | planning-steward-before-supervisor | **強化** → 升格 | 改寫為「Planning Steward 是硬編碼、不可關的 BMAD spine」。從「第一個 agent」升格為支柱一的基石。 |
| ADR-0003 | docs-specs-adr-split | **保留** | 文件結構不變。 |
| ADR-0004 | permission-gateway-before-tool-executor | **修訂** | gateway 仍是 tool 必經之路，但規則來自 `rule_registry`（資料）。gateway = 求值器，不是作者。 |
| ADR-0005 | no-raw-secrets-in-agent-context | **修訂為預設** | secret 遮蔽改為「合理預設政策」+ 沙箱本來就擋外洩。預設開，但屬資料層、可由 registry 描述；非不可改的聖閘。 |
| ADR-0006 | bypass-is-workspace-only | **保留 + 升格** | 這其實就是「沙箱是邊界」。改寫為新安全模型的地基：所有自主性都 sandbox-scoped。 |
| ADR-0007 | model-provider-gateway | **保留** | 已是 config-driven，符合方向。 |
| ADR-0008 | skills-require-tests | **修訂** | 測試保留為**預設品質訊號**；但「register 必過測 + promotion 是 human gate」改為：測試是可配置的預設門檻（沙箱專案可允許 draft/未驗證 skill），skill 開關/升級是**使用者決定**（移除審批摩擦，對齊 25 文件 category-2）。codegraph + ponytail 預設安裝。 |
| ADR-0009 | codex-oauth-default-backend | **保留** | 不受影響。 |
| ADR-0010 | supervisor-decides-harness-executes | **保留（重新框定）** | 「腦 vs 手」的解耦是好工程（LLM 不直接跑破壞性操作），保留；但「手」執行的規則改為 registry 定義。 |

### 2.2 新增 ADR

| 新 ADR | 標題 | 記錄什麼 |
|---|---|---|
| **ADR-0011** | the-one-hardcoded-spine-bmad-planning | 支柱一：Planning Steward + idea→PRD→architecture→epic/story（含自動放置）硬編碼、不可關；其餘 BMAD 功能簡化掉。明文終結「everything is configurable」的漂移。 |
| **ADR-0012** | policy-as-data-rule-registry | 支柱二：write-set / tool grant / budget / quality bar / forbidden zone 從程式常數移到 `configs/rule_registry.yaml`，由 registry 求值器讀取，cockpit 編輯。 |
| **ADR-0013** | sandbox-is-the-sole-trust-boundary | 支柱三：容器 + egress 隔離是唯一 by-construction 的牆，由真實探測證明；牆內護欄是品質/成本預設，非安全牆。**取代** `README_for_release` 的「four human-only gates / controllable by construction」框架；**修訂** ADR-0013 與 25 文件的關係（25 降為下位）。 |
| **ADR-0014** | work-mode-greenfield-brownfield-skill-axis | skills 以 Work Mode（greenfield/brownfield）分組、不混搭；一個 Mode = 可編輯的 {active skills, 預設政策, 入場假設} bundle。**與 Builder Mode（provider/cli，見 `18_DUAL_MODE_BUILDER.md`）是不同軸，務必別混淆。** |
| **ADR-0015** | codegraph-ponytail-default-installed-skills | codegraph 與 ponytail 抽離成自包含、test-gated、預設開啟的 skill；使用者可關，但出廠即裝即開。 |

---

## 3. 文件異動清單（docs/ 與根目錄）

| 文件 | 動作 |
|---|---|
| `docs/architecture/25_GATE_PHILOSOPHY.md` | **降格**：保留三分類的判準（agent guardrail / user blocker / protect-user），但標注「agent guardrail 不再硬編碼，改由 ADR-0012 的 registry 承載」，整份成為 ADR-0013 的下位說明。 |
| `README_for_release.md` | **改寫 identity 段**：「agents propose, deterministic harness disposes / four human-only gates」→「sandbox is the wall; rules are data; the BMAD planning spine is the only hardcoded process」。 |
| `GATELOOP_DEVELOPMENT_PLAN.md` | **大砍 §0**：「每道護欄都要 fixture 證明是唯一防線」的負擔在 ADR-0013 下消解；token cap / budget / kill switch 改列為 registry 的預設項，仍保留但不再是安全命脈。 |
| `docs/architecture/00_SYSTEM_OVERVIEW.md` | 更新總覽圖：兩層（聖閘 vs 軟設定）→ 單一資料層 + 沙箱牆 + 硬編碼 spine。 |
| `docs/architecture/08_HARNESS_ENGINEERING_MODEL.md` | 重新定義「harness engineering」：不是「凡事過閘」，是「確定性地執行 registry + 守住沙箱 + 跑 BMAD spine」。 |
| `docs/architecture/18_DUAL_MODE_BUILDER.md` | 釐清命名：**Builder Mode**（provider/cli，怎麼產 diff）≠ **Work Mode**（greenfield/brownfield，做哪種專案）。 |
| `docs/architecture/24_UNIFIED_SKILL_TOOL_SYSTEM.md` | 擴充：加入 Work Mode 分組 + 預設 skill（codegraph/ponytail）+ 修補 skill-body→prompt 斷線。 |
| `CLAUDE.md` / `gateloop/CLAUDE.md` / `AGENTS.md` | **大幅縮短 Forbidden actions**：從一長串硬規則 → 「沙箱邊界 + 合理預設（secret 遮蔽、force-push 前自動備份）」。 |

---

## 4. Skills 重新分組：greenfield / brownfield（不混搭）

### 4.1 問題

現在 ~45 個 skill 按 **agent role** 分組（planning-steward / supervisor / developer / debugger / reviewer / shared）。對使用者來說，一個 greenfield 專案的 session 裡同時掛著一堆 brownfield 專用 skill（如 `architecture-recovery`、`as-is-documentation`），**混淆視聽**。

### 4.2 設計：保留 role 作者歸屬，引入 Mode manifest 控制掛載

skill 仍按 role 撰寫與測試（那是它的自然生命週期），但新增 **Work Mode manifest**：宣告每個 Mode 掛載哪些 skill。

- greenfield session → 只載 greenfield + shared；
- brownfield session → 只載 brownfield + shared。

→ agent 永遠只看到「當前 mode 相關」的 skill。直接解掉「不要把所有 skill 混搭」。

新增檔案：

```
configs/work_modes/
  greenfield.yaml     # mounts: [greenfield/*, shared/*], 預設政策, 入場假設
  brownfield.yaml     # mounts: [brownfield/*, shared/*], 預設政策, 入場假設
```

`skills/skill_manifest.json` 每個 skill 加一個欄位 `work_mode: greenfield | brownfield | shared`。

### 4.3 現有 skill 的分類（盤點，照搬到 manifest）

**greenfield-only（從零建）**
- `planning-steward/prd-authoring`
- `planning-steward/architecture-design`
- `planning-steward/interface-contract-spec`
- `planning-steward/program-spec-assembly`
- `planning-steward/acceptance-test-scaffold`
- `planning-steward/machine-checkable-acceptance`
- `developer/crud-web-app-template`
- `developer/rest-api-template`
- `developer/cli-tool-template`

**brownfield-only（既有碼上動工）**
- `planning-steward/architecture-recovery`
- `planning-steward/as-is-documentation`
- `planning-steward/delta-spec-authoring`
- `planning-steward/documented-stub-registry`
- `planning-steward/behavior-test-derivation`
- `planning-steward/epic-story-sharding`

**shared（兩種 mode 都要的執行/品質/安全核心）**
- `planning-steward/idea-to-epic`（已吃 greenfield/brownfield/patch 分類為輸入，天生跨 mode）
- `planning-steward/write-set-and-guards`
- `supervisor/*`（全 7 個）
- `developer/patch-proposal`、`pre-flight-check`、`spec-conformance`、`ponytail-lazy`
- `debugger/*`（全 5 個）
- `reviewer/*`（全 7 個）
- `shared/*`（`codegraph-query`、`structured-escalation`、`task-decomposition`）

> 註：`ponytail-lazy`（developer）與 `ponytail-review`（reviewer）會在 §5 合併成單一 ponytail skill。

---

## 5. codegraph & ponytail：分離成「預設安裝」的 skill

兩者都是「可自主配置 skill」的旗艦範例——**出廠預設裝上且開啟**，但使用者能在 cockpit 關。

### 5.1 先修一個前置斷線（一次修、全 skill 受益）

`24_UNIFIED_SKILL_TOOL_SYSTEM.md` 已盤出：**registered skill 的 `SKILL.md` body 從不進 live prompt**——`composeSystemPrompt` 只注入 name+summary，role callsite 完全沒傳 `mountedSkills`。

→ **STORY：修 skill-body→prompt wire**。這是 ponytail（純 prompt 注入）能生效的前提，也讓所有 skill 真的能把內容送進模型，不只是名字。

### 5.2 ponytail（純 prompt 注入，~100 行 SKILL.md）

- 本質：MIT、Dietrich Gebert、"lazy senior dev" 階梯（YAGNI → stdlib → native → installed dep → one line → minimum code）。無 enforcement engine、無 AST、無 hook——GateLoop 只需要把那段文字放對地方。
- 動作：把現有 `developer/ponytail-lazy` + `reviewer/ponytail-review` **合併成單一 canonical `skills/shared/ponytail` skill**（一份 SKILL.md，含 lite/full/ultra 強度、「何時不偷懶」的 carve-out）。
- 兩個協調點（沿用 23 文件結論，且被既有 gate 硬兜底）：
  1. 「刪碼」必須讓位給 contract + additive 檢查（別讓 ponytail 的「刪優於增」凌駕保留既有行為）；
  2. 「質疑需求」要 route 到 escalation，不可靜默省略。
- **預設**：`enabled: true, builtin: true`，掛進 greenfield + brownfield 的 shared 段。

### 5.3 codegraph（已是註冊工具，現在收成自包含 skill）

- 現況：引擎 vendored 在 `external_references/open_source_projects/codegraph/`（MIT, colbymchenry/codegraph, pinned 0.9.9）；**已是 tool registry 裡的 `query_codegraph`**，wired 在 `provider-driver/confinement.ts`，可由 `scale_relevant` 開關；`shared/codegraph-query` skill 已存在。
- 「分離出來」的意思：把它**封裝成自包含的預設 skill package**——skill 自己擁有 tool grant + index lifecycle（`/goal` Step 0 建索引、checkpoint 後增量重建、`.codegraph/` 為 harness state），不再散落在特定 agent 的 hardwire 裡。
- 規模感知保留：小專案開銷 > 收益，所以 skill 內建「可選啟用」；但依你要求 **預設開啟**（`enabled: true, builtin: true`）。大專案自動受益，小專案一鍵關。
- 兩者都掛 shared 段（greenfield + brownfield 都用得到結構分析）。

---

## 6. 硬編碼 BMAD planning spine + epic/story 自動放置

### 6.1 把 planning spine 寫死

Planning Steward 的序列固定為（依分類分叉）：

```
idea
  → classify {greenfield | brownfield | patch}
  → greenfield: prd-authoring → architecture-design
    brownfield: as-is-documentation → architecture-recovery → delta-spec-authoring
  → idea-to-epic（產出 epic/story DAG）
  → 物化成檔案（§6.2）
  → supervisor story-contract
```

這條序列**不進 `decision_matrix.yaml` 的可編輯區**（其餘工作流可編輯，唯獨 spine 不行）。其餘 BMAD 功能簡化掉，只留這條 + 「Ready for Development」標準（actionable / testable / complete / single goal）。

### 6.2 epic/story 自動放置（零配置）

現況：epic/story 散在 build 側 `builder/epics/` + `builder/stories/`，產品側沒有乾淨慣例。

決定：**Planning Steward 在 planning 結束時，自動把 backlog 物化到從 project root 推導的固定路徑**，不需任何路徑設定：

```
<project-root>/.gateloop/backlog/
  epics/EPIC-<id>.md
  stories/STORY-<id>.md
  sprint-status.yaml
```

- `idea-to-epic` 輸出的 DAG 由一個**確定性 harness step** 寫到上述固定位置（不是 LLM 決定路徑）。
- 這是我**刻意新增的一處硬編碼慣例**——因為這正是你要的「零 config 摩擦」。路徑常數可改名，但「自動放置、不問使用者」是寫死的行為。
- greenfield 與 brownfield 共用同一放置慣例（差別只在 spine 分叉與掛載的 skill，不在放哪）。

---

## 7. 沙箱作為唯一邊界（落實支柱三）

- 沿用 `18_DUAL_MODE_BUILDER.md` 已建的隔離原語：ephemeral sandbox、RO repo copy、default-deny net、`--internal` 網路 + filtering proxy 為唯一 egress。
- **證明先於信任**：用 `prove-egress.ts` 的四項真實探測（allowlist 連得到 / 非 allowlist 被擋 / 繞 proxy 直連全失敗 / proxy.log 非空）證明牆有效，才允許把牆內護欄降鬆。
- 牆內：write-set、additive、budget、quality bar 全部變 registry 預設項（§2.2 ADR-0012），使用者可調可關。
- 唯二保留為靜默預設：secret 遮蔽（trace/log）、force-push 前自動 bundle 備份（沿用 CLAUDE.md 既有 git 教訓）。

---

## 8. 遷移路線圖（宏觀分期 / epic）

> 依賴順序排列。**Phase 0 必須最先**——它終結哲學拉扯，是後面一切的前提。
> **Phase 1（證明沙箱）必須在 Phase 2（降閘）之前**——牆沒證明有效，不准拆閘。

| Phase | 名稱 | 內容 | 產出/驗收 |
|---|---|---|---|
| **0** | 定向與 ADR | 寫 ADR-0011~0015、修 ADR-0002/0004/0005/0006/0008/0010、改寫 §3 文件 | ADR 全數 Accepted；25 文件降格；README/dev-plan identity 更新。**無程式碼。** |
| **1** | 沙箱即唯一牆 | 跑 `prove-egress.ts` 四項探測、把沙箱定為 by-construction 邊界 | 四項探測全綠且 proxy.log 非空（對照 034.5 空 log 事故）。 |
| **2** | policy-as-data | 從 `gate-control`/`permission-gateway` 抽出硬規則 → `configs/rule_registry.yaml` + registry 求值器；四道全域閘從程式常數降為 registry 預設 | fixture：規則改 registry 即生效、無需改程式；gateway 只讀不寫規則。 |
| **3** | Work Mode + skill 重分組 | 建 `configs/work_modes/{greenfield,brownfield}.yaml`、skill manifest 加 `work_mode`、mode-scoped 掛載 | fixture：greenfield session 不掛載 brownfield skill，反之亦然。 |
| **4** | skill-body→prompt + 預設 skill | 修 `composeSystemPrompt` 斷線；合併 ponytail 成單一 skill；codegraph 封成自包含預設 skill | fixture：skill SKILL.md body 真的進 prompt；ponytail/codegraph 預設開且可關。 |
| **5** | 硬編碼 BMAD spine + 自動放置 | Planning Steward 固定序列；確定性 step 自動物化 backlog 到 `<root>/.gateloop/backlog/`；簡化掉其餘 BMAD 功能 | fixture：跑一個 idea，backlog 自動出現在固定路徑、七要素齊備、無需路徑設定。 |
| **6** | cockpit 可視化 | 把 `SettingsPanel`/`SkillsPage` 接到 rule_registry + work_modes + skill 開關（多數已存在，補 registry/mode 編輯） | UI 能改規則/Mode/skill 並即時生效；UI 非 enforcer（伺服器端求值）。 |

---

## 9. 風險與一個我必須有意識做的取捨

### 9.1 取捨：thesis 新穎性 vs 工具好用性

gate-centric 框架在學術上更好賣——`paper_feature_traceability.md` 自己標了：`FailureGene`/`RepairOperator`/`decideRepairRoute` 直接對應 Gene、GRASP、MUSE-Autoskill 那幾篇 paper，「controllable by construction」是清楚的貢獻。

轉成「可配置引擎 + 沙箱、無硬閘」更好用，但純安全角度的新穎性會弱一點。

**我的立場**：兩者不衝突。「**policy-as-data 的 agent harness，唯一硬邊界是沙箱，BMAD planning spine 是唯一硬編碼流程**」本身就是一個站得住的設計貢獻——它是對「凡事過閘」那派的明確反論，且有可量測的論點（同一條 spine 跨 greenfield/brownfield 復用、規則改資料即生效、沙箱真實探測）。重點是選定寫這一篇，別再漂。

### 9.2 其他風險

| 風險 | 緩解 |
|---|---|
| 拆閘後若沙箱沒證明有效 → 真的失防 | Phase 1 卡死在 Phase 2 之前；探測四項全綠才放行。 |
| Builder Mode（provider/cli）與 Work Mode（greenfield/brownfield）命名混淆 | ADR-0014 + 改 `18_DUAL_MODE_BUILDER.md` 明確分軸。 |
| 「簡化掉其餘 BMAD」誤砍到 spine | ADR-0011 把 spine 七要素列為不可動；其餘才可砍。 |
| skill 重分組造成既有測試斷裂 | skill 仍按 role 撰寫/測試，只加 `work_mode` 欄位 + 掛載過濾，不動 skill 內容。 |

---

## 10. 附錄：本計劃的設計立場（我的想法，一句句寫出來）

1. **我要的不是一個更安全的牢籠，是一個更聰明、可復用的工作流。** 安全交給沙箱一道牆，剩下的腦力花在流程和可配置性上。
2. **會產生價值的東西才值得硬編碼。** 那就是 BMAD 的 planning spine——尤其 Planning Steward 和 epic/story 自動放置。其餘 BMAD 是裝飾，砍掉。
3. **任何「限制」都該是我能在 cockpit 看到、能改的一列資料**，不是藏在程式碼裡、要改 yaml 或改 code 才動得了的閘。
4. **沙箱證明有效之前，我不拆任何牆；證明有效之後，牆內我不設不必要的限制。**
5. **greenfield 和 brownfield 是兩種工作模式，不是兩坨混在一起的 skill。** 我在哪個模式，就只看到那個模式的 skill。
6. **codegraph 和 ponytail 是「可配置 skill」的示範**——預設裝好開好，但我隨時能關。它們證明這個系統的 skill 是真的模組化、可插拔。
7. **我選擇寫「policy-as-data + 沙箱單一邊界 + BMAD spine 硬編碼」這一篇論文，不再在兩種哲學之間漂。**
