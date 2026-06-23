# ADR-0013 — 不要沙箱；採「操作者完全信任」執行模型（取代「沙箱即唯一邊界」）

## Status

Accepted（取代 `GATELOOP_REALIGNMENT_PLAN.md` 裡 Proposed 的舊 ADR-0013「sandbox is the sole trust boundary」）。
日期：2026-06-23。作者：pollux。

## Context

- 重定向計劃的舊 ADR-0013 把「容器沙箱 + egress + prove-egress」當成唯一硬牆。**但這套基礎已不存在**：
  - `agent-delegate`：network-isolated **delegation sandbox** 在 EPIC-035 TIER B 被退役（只服務 spawn-CLI lane）。
  - `external-agent` / STORY-035.7 cleanup：spawn-CLI 的 `controlledBash`(034.3)、`isolation`(034.4) 模組已清除。
  - `provider-driver`：改為 **in-process**（Vercel AI SDK）驅動 backend。
  - `container-runtime`：自述「No real container is ever invoked here — schema-level only (v0)」，且**沒有任何 package import 它**。真正的容器從未被叫起來過。
- 重建容器沙箱是一個**前置工程**（需 orchestration + network grant + 與 in-process 的關係釐清）。本專題是**單一操作者在自己機器上、建自己的專案**。
- 決定不承擔重建沙箱的成本。

## Decision

1. **不要沙箱。** 不重建容器/egress 牢籠。生成碼、測試、build、codegraph 索引一律**直接在主機上執行**。
2. **使用者輸入的 skill 不驗證。** 直接安裝、直接執行。**退役舊 ADR-0008 的 test-gate**：測試降為「可選的自我檢查」，永遠不是 gate、不 quarantine、不 leakage-audit。
3. **信任模型明文化**：工具層只塑形 **agent 的提案**（`tool-interface` by construction 不給 Bash——這部分為真、保留），但系統**完全信任操作者**。執行端**沒有硬牆**。

## Consequences（誠實寫出，遵守自己的「設了≠生效，不留虛防線」鐵則）

- 「sandbox is the sole trust boundary」作廢。**任何文件都不得再暗示一個不存在的保護**（對照既有教訓：6/15 sed 靜默失敗、概念沙箱非真牢籠）。
- 生成碼/測試/skill 以**操作者的主機權限、網路、環境**執行。具體曝險面：`validator-suite`(跑測試)、`preflight-runner`(build/typecheck)、`skill-tester`(pytest)、`codegraph-client`(`npx @colbymchenry/codegraph`)。一個惡意/有 bug 的測試或 `postinstall` 會直接在主機上跑。
- **風險等級 = 在本機開 auto-run 跑任何 AI coding 工具**（Claude Code / Cursor / aider）。對單一操作者、自己的機器、自己的專案而言可接受；**若日後要給不可信的多租戶使用，必須重開此 ADR**。
- policy-as-data 護欄（write-set、additive、budget、quality）**降為純粹的品質/成本旋鈕**，非安全機制——使用者可調可移除，且**沒有任何東西兜底**。這與「規則即資料、操作者說了算」一致；只是要在文件講明它們不是牆。

## 保留的兩個衛生預設（非牆，是保護操作者自己）

- **trace/log 的 secret 遮蔽**：避免你自己的金鑰被寫進 commit 的 trace / 截圖。in-process、便宜、與「信任操作者」不衝突（它防的是意外外洩，不是限制 agent）。
- **force-push 前自動 bundle 備份**：沿用既有 git 教訓。
- 兩者都明確標注：**是衛生，不是安全牆**。若你連這兩個也要拿掉，再說。

## Cascade — 對兩份計劃的連鎖修改

### `GATELOOP_REALIGNMENT_PLAN.md`
- 舊 ADR-0013 →（本文件取代）。
- **退役 ADR-0008**（skills-require-tests）：改記為「user skills 不驗證、不 test-gate」。
- **刪除 Phase 1（沙箱即唯一牆 / prove-egress）**：整個 prove-egress 相依消失。
- **刪除 §7（沙箱作為唯一邊界）**；其結論改為本 ADR。
- 支柱三從「沙箱是唯一硬牆」改寫為：「**沒有硬牆；工具層塑形 agent 提案，執行直接在主機，操作者完全信任**」。
- 支柱一（BMAD spine 硬編碼）、支柱二（policy-as-data）**不受影響**——計劃不再倚賴缺失的基礎，因此**站得穩了**。

### `GATELOOP_FRONTEND_PLAN.md`
- **刪除 §4.4 `SandboxStatusBadge`** 與 §1 對照表中該列（沒有牆可證明）。
- 可選：以一行純狀態「執行：直接在主機（無沙箱）」取代，誠實標示而非假裝有防護。
- 其餘模組（`PlanningGraph`、`RuleRegistryEditor`、`WorkModeSwitcher`、`SkillsPanel`）不受影響。

## 對 thesis 的影響

論點從「沙箱兜底的 harness」轉為「**唯一硬編碼是 BMAD planning spine；規則皆資料；執行採操作者信任模型，刻意不設沙箱**」。這仍是一個可辯護的設計立場（對「凡事過閘」的明確反論），而且現在**沒有懸空的基礎**。代價：純安全角度的賣點變弱——這是你已知並接受的取捨。
