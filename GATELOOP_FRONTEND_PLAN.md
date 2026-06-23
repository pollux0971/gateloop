# GateLoop 前端重定向計劃書 — cockpit 跟上後端 + planning 流程圖重寫

> 狀態：Proposed（設計定向）
> 日期：2026-06-23
> 作者：pollux
> 配對文件：`GATELOOP_REALIGNMENT_PLAN.md`（後端）。本文件是它的前端對位。
> 一句話：**後端把「規則變資料、spine 硬編碼、沙箱兜底」，前端就要把這些變成看得到、能改的面板；而 planning 流程圖要從「靜態 story 依賴圖」改成「會長、會跳的 planning 狀態圖」。**

---

## 0. 現況診斷（為什麼醜 + 哪裡沒跟上）

掃過 `apps/web/src` 後，問題具體是：

1. **沒有 planning 專屬視覺**。現在的 `PipelineBoard.tsx` 裡的 `DagView` 畫的是 **story 依賴 DAG**，不是 planning 階段流程。它：直線無箭頭、固定 `XSTEP/YSTEP` 座標、20×120 小方塊、`fontSize:10` mono、**無轉場無動畫**——節點變動就硬跳。
2. **設計 token 沒落地**。`theme.css` 定義了 MD3 + role 變數，但元件**到處寫死 hex**（`#18242F`、`#0D1B26`、`#5BD6C0`、`rgba(230,237,243,.34)`）、**滿版 9.5–11px JetBrains Mono**。醜的根因就是：字級過小且全 mono、色票不一致、零留白層次。
3. **後端新能力沒有面板**。`rule_registry`（ADR-0012）、Work Mode（ADR-0014）、預設 skill codegraph/ponytail（ADR-0015）目前在 cockpit 沒有對應 UI。（原列於此的「沙箱探測」已移除——見下方 STORY-TRUST.4 註記與 §4.4。）

> ⚠️ **STORY-TRUST.4 / ADR-0013 cascade applied（2026-06-23）**：依 `ADR/ADR-0013-no-sandbox-operator-trust.md`，執行端**沒有沙箱/egress 牆**。原 §4.4 `SandboxStatusBadge`（四項 egress 探測燈號）與 §1 對照表中的該列**已刪除**——沒有牆可證明，不放假裝有防護的徽章（leave no phantom defense）。誠實替代：cockpit 可顯示一行純狀態「**執行：直接在主機（無沙箱）**」。其餘模組（`PlanningGraph`、`RuleRegistryEditor`、`WorkModeSwitcher`、`SkillsPanel`）不受影響。
4. **`App.tsx` 沒有 Planning 分頁**，planning 無處可看。

---

## 1. 對齊：前端模組 ↔ 後端能力對照

| 後端（ADR） | 前端模組 | 需要的 API | 動作 |
|---|---|---|---|
| ADR-0011 BMAD spine + 自動放置 epic/story | **`PlanningGraph`**（核心，§3） | `GET /api/trace`（新增 planning 事件） | 新建：動態流程圖 + Planning 分頁 |
| ADR-0012 policy-as-data rule registry | **`RuleRegistryEditor`**（§4.1） | `GET/PUT /api/rule-registry` | 新建：規則列表可視化編輯 |
| ADR-0014 Work Mode greenfield/brownfield | **`WorkModeSwitcher`** + 全域過濾（§4.2） | `GET/PUT /api/work-mode` | 新建：模式切換；切換後 `SkillsPanel`/`PlanningGraph` 隨之過濾 |
| ADR-0015 codegraph/ponytail 預設 skill | **`SkillsPanel`** 擴充（§4.3） | `GET /api/skills`、`POST /api/skills/control` | 擴充：依 work_mode 分組、builtin/enabled 徽章 |
| ~~ADR-0013 沙箱唯一邊界~~ | ~~`SandboxStatusBadge`~~ | — | **已刪除（STORY-TRUST.4 / ADR-0013）**：執行端無沙箱/egress 牆，無探測可顯示。誠實替代＝一行狀態「執行：直接在主機（無沙箱）」。 |

---

## 2. 前端整體優化（設計層，先立 token）

### 2.1 設計方向（一句話 brief）

cockpit 的主角是「**planning 會自己長出來**」——一句話或讀一次 repo，進度就跳、章節就冒。所以視覺的記憶點（signature）不是靜態管線，而是**節點生滅與進度跳躍的那一刻**。其餘一切保持安靜克制。

### 2.2 落地 `tokens.css`（停止 inline hex）

```css
/* apps/web/src/tokens.css —— 取代散落各處的 hex，全部走變數 */
:root {
  color-scheme: dark;
  /* surfaces */
  --bg:        #0E1620;   /* page */
  --surface-1: #16212C;   /* card */
  --surface-2: #1B2935;   /* raised / hover */
  --line:      rgba(230,237,243,.10);
  --line-2:    rgba(230,237,243,.20);
  /* text */
  --tx-1: #E7EEF5;        /* primary */
  --tx-2: rgba(231,238,245,.62);
  --tx-3: rgba(231,238,245,.38);
  /* status (節點狀態，跨明暗都可讀) */
  --st-pending: #7E8C99;
  --st-active:  #8AB4F8;  /* blue  */
  --st-asking:  #C792EA;  /* purple */
  --st-done:    #5BD6C0;  /* teal  */
  --st-leap:    #F2A65A;  /* amber，進度跳躍/新增高亮 */
  /* type scale —— 重點：標題用 sans，mono 只給 id/代碼 */
  --font-sans: Inter, ui-sans-serif, system-ui, sans-serif;
  --font-mono: "JetBrains Mono", ui-monospace, monospace;
  --t-title: 14px;  --t-body: 13px;  --t-meta: 11px;
  --r-md: 8px; --r-lg: 12px;
}
```

規則：元件一律用上述變數；**mono 只用在 story_id / epic_id / 數值**，標題與說明用 sans、字級不低於 13px。光這一步，醜就去掉一半。

---

## 3. PlanningGraph（核心）— 生成邏輯 + 樣子 + 動態

### 3.1 心智模型：planning 是非單調、會湧現的

關鍵真相（也是你要的需求）：**一句話或讀 repo，可能讓進度大幅前進、或長出新的問題章節**。所以流程圖不能是寫死的靜態管線，必須：

- 由一份**宣告式資料模型 `PlanningGraph`** 生成（不是寫死座標）；
- 模型由 **trace 事件串流 reduce 出來**（事件進來 → 模型變 → UI 動畫過渡 diff）；
- 節點**數量會增減**、進度**會跳**。

### 3.2 資料模型 `planningGraph.ts`

```ts
// apps/web/src/planning/planningGraph.ts
export type NodeKind = 'phase' | 'chapter' | 'epic' | 'story';
export type NodeStatus = 'pending' | 'active' | 'asking' | 'done';

export interface PlanningNode {
  id: string;
  kind: NodeKind;
  title: string;
  meta?: string;            // ch.3、parallel_safe、repo scanned…（顯示用 mono）
  status: NodeStatus;
  progress: number;         // 0–100
  col: 0 | 1 | 2 | 3;       // 對應四個硬編碼 spine 階段
  parent: string | null;    // chapter→phase, story→epic, epic→phase
  source?: 'user' | 'repo' | 'spine';  // 章節從哪冒出來（高亮用）
}
export interface PlanningGraph { nodes: PlanningNode[]; }

// 四個 spine 階段是硬編碼的常數（對應後端 ADR-0011）
export const SPINE: PlanningNode[] = [
  { id: 'p0', kind: 'phase', col: 0, title: 'idea',         status: 'pending', progress: 0, parent: null },
  { id: 'p1', kind: 'phase', col: 1, title: 'discovery',    status: 'pending', progress: 0, parent: null },
  { id: 'p2', kind: 'phase', col: 2, title: 'architecture', status: 'pending', progress: 0, parent: null },
  { id: 'p3', kind: 'phase', col: 3, title: 'backlog',      status: 'pending', progress: 0, parent: null },
];
```

### 3.3 生成邏輯：reducer(events) → PlanningGraph

後端 planning spine 在 `/api/trace` 多吐幾個 planning 事件（這是後端要配合的小改，對應 ADR-0011）；前端純粹 reduce：

```ts
// apps/web/src/planning/planningReducer.ts
import type { TraceEvent } from '@gateloop/harness-core';
import { type PlanningGraph, type PlanningNode, SPINE } from './planningGraph';

// 後端新增的 planning 事件（payload 形狀）
type P =
  | { type: 'planning_phase_update'; phase: PlanningNode['id']; status: PlanningNode['status']; progress: number; meta?: string }
  | { type: 'planning_chapter_added'; id: string; phase: PlanningNode['col']; title: string; source: 'user' | 'repo' }
  | { type: 'planning_node_update'; id: string; status?: PlanningNode['status']; progress?: number; meta?: string }
  | { type: 'planning_epic_added';  id: string; title: string; meta?: string }
  | { type: 'planning_story_added'; id: string; epic: string; title: string; meta?: string };

export function reducePlanning(events: TraceEvent[]): PlanningGraph {
  const nodes = new Map<string, PlanningNode>(SPINE.map(n => [n.id, { ...n }]));
  for (const raw of events) {
    const e = raw as unknown as P;
    switch (e.type) {
      case 'planning_phase_update': {
        const n = nodes.get(e.phase); if (!n) break;
        n.status = e.status; n.progress = e.progress; if (e.meta) n.meta = e.meta;
        break;
      }
      case 'planning_chapter_added':
        nodes.set(e.id, { id: e.id, kind: 'chapter', col: e.phase, title: e.title,
          status: 'active', progress: 0, parent: `p${e.phase}`, source: e.source });
        break;
      case 'planning_epic_added':
        nodes.set(e.id, { id: e.id, kind: 'epic', col: 3, title: e.title, meta: e.meta,
          status: 'active', progress: 0, parent: 'p3', source: 'spine' });
        break;
      case 'planning_story_added':
        nodes.set(e.id, { id: e.id, kind: 'story', col: 3, title: e.title, meta: e.meta,
          status: 'pending', progress: 0, parent: e.epic, source: 'spine' });
        break;
      case 'planning_node_update': {
        const n = nodes.get(e.id); if (!n) break;
        if (e.status) n.status = e.status;
        if (typeof e.progress === 'number') n.progress = e.progress;
        if (e.meta) n.meta = e.meta;
        break;
      }
    }
  }
  return { nodes: [...nodes.values()] };
}
```

事件 → 圖的對照（即你的需求逐條落點）：

| 觸發 | 事件 | 圖的反應 |
|---|---|---|
| 使用者一句話帶出新類別 | `planning_chapter_added{source:'user'}` | discovery 下長出新章節（高亮 amber）、siblings 滑開讓位 |
| 讀取程式庫，進度大幅進展 | `planning_phase_update{progress:92,status:'done'}` + 多個 `planning_chapter_added{source:'repo'}` | discovery 進度環跳到 92 並 pulse、自動冒出數個既有碼章節、architecture 解鎖 |
| 拆 backlog | `planning_epic_added` / `planning_story_added` | backlog 下長出 epic→story 串 |

### 3.4 hook：接 useTraceStream

```ts
// apps/web/src/planning/usePlanningGraph.ts
import { useMemo } from 'react';
import { useTraceStream, type TraceMode } from '../useTraceStream';
import { reducePlanning } from './planningReducer';

export function usePlanningGraph(mode: TraceMode = 'live') {
  const { events, loading, error } = useTraceStream({
    mode,
    typeFilter: ['planning_phase_update', 'planning_chapter_added', 'planning_node_update', 'planning_epic_added', 'planning_story_added'],
  });
  const graph = useMemo(() => reducePlanning(events), [events]);
  return { graph, loading, error };
}
```

### 3.5 樣子 + 動態：`PlanningGraph.tsx`

設計重點（對照上面互動 demo）：
- **layout = spine + branches**：四個硬編碼階段橫向排成主軸；章節/epic/story 從各自階段「向下長」。這在視覺上編碼後端哲學——**主軸固定、其餘是長出來的資料**。
- **曲線連接 + 箭頭**（非直線），邊線顏色隨子節點狀態。
- **動態過渡**：節點位置變動用 `transform` transition 滑移（FLIP-lite）；新節點 `scale+opacity` 冒出；進度環 `stroke-dashoffset` 補間；跳躍時 amber pulse；邊線在過渡期間用 rAF 跟著節點重畫。
- `prefers-reduced-motion` 一律尊重。

```tsx
// apps/web/src/planning/PlanningGraph.tsx
import { useLayoutEffect, useRef } from 'react';
import type { PlanningGraph, PlanningNode } from './planningGraph';
import './planningGraph.css';

const COLX = [8, 172, 336, 500], PW = 150, CW = 134, PH = 54, CH = 42, CY0 = 92, CSTEP = 52;
const ICON: Record<PlanningNode['kind'], string> = {
  phase: 'ti-flag-3', chapter: 'ti-help-circle', epic: 'ti-stack-2', story: 'ti-file-text',
};

interface Pos { x: number; y: number; w: number; h: number }
function layout(nodes: PlanningNode[]): Map<string, Pos> {
  const pos = new Map<string, Pos>(), perCol: Record<number, PlanningNode[]> = {};
  for (const n of nodes) if (n.kind === 'phase') pos.set(n.id, { x: COLX[n.col], y: 14, w: PW, h: PH });
  for (const n of nodes) if (n.kind !== 'phase') (perCol[n.col] ??= []).push(n);
  for (const col of Object.keys(perCol)) perCol[+col].forEach((n, i) =>
    pos.set(n.id, { x: COLX[+col] + 8, y: CY0 + i * CSTEP, w: CW, h: CH }));
  return pos;
}
const C = 2 * Math.PI * 8;
const dashOffset = (p: number) => (C * (1 - p / 100)).toFixed(2);

export function PlanningGraph({ graph }: { graph: PlanningGraph }) {
  const wrapRef = useRef<HTMLDivElement>(null);
  const edgeRef = useRef<SVGSVGElement>(null);
  const prev = useRef<Set<string>>(new Set());      // 上一輪存在的節點（判斷哪些是新冒出的）

  useLayoutEffect(() => {
    const wrap = wrapRef.current!, pos = layout(graph.nodes);
    const seen = new Set<string>();
    for (const n of graph.nodes) {
      seen.add(n.id);
      const p = pos.get(n.id)!;
      const el = wrap.querySelector<HTMLElement>(`#pn-${n.id}`);
      if (!el) continue;
      const isNew = !prev.current.has(n.id);
      if (isNew) {                                    // 冒出動畫
        el.style.opacity = '0';
        el.style.transform = `translate(${p.x}px,${p.y}px) scale(.86)`;
        requestAnimationFrame(() => requestAnimationFrame(() => {
          el.style.opacity = '1'; el.style.transform = `translate(${p.x}px,${p.y}px) scale(1)`;
        }));
      } else {                                        // 滑移（FLIP-lite）
        el.style.opacity = '1'; el.style.transform = `translate(${p.x}px,${p.y}px) scale(1)`;
      }
    }
    const maxB = Math.max(...graph.nodes.map(n => pos.get(n.id)!.y + pos.get(n.id)!.h), 0);
    wrap.style.height = `${maxB + 18}px`;
    animateEdges(wrap, edgeRef.current!, graph.nodes, pos);
    prev.current = seen;
  }, [graph]);

  return (
    <div className="pg-wrap" ref={wrapRef} role="img"
         aria-label="planning 流程圖：固定主軸與動態章節/epic/story">
      <svg className="pg-edges" ref={edgeRef} xmlns="http://www.w3.org/2000/svg">
        <defs><marker id="pgArr" viewBox="0 0 10 10" refX="8" refY="5" markerWidth="6" markerHeight="6" orient="auto-start-reverse">
          <path d="M2 1L8 5L2 9" fill="none" stroke="context-stroke" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" />
        </marker></defs>
      </svg>
      {graph.nodes.map(n => (
        <div key={n.id} id={`pn-${n.id}`} className={`pnode s-${n.status} ${n.source === 'repo' || n.source === 'user' ? 'leap' : ''}`}>
          <span className="rail" />
          <i className={`nicon ti ${ICON[n.kind]}`} aria-hidden="true" />
          <div className="ntext">
            <div className="ntitle">{n.title}</div>
            {n.meta && <div className="nmeta">{n.meta}</div>}
          </div>
          <svg className="ring" width="22" height="22" viewBox="0 0 22 22">
            <circle className="rt" cx="11" cy="11" r="8" />
            <circle className="rp" cx="11" cy="11" r="8" strokeDasharray={C.toFixed(2)} strokeDashoffset={dashOffset(n.progress)} />
          </svg>
        </div>
      ))}
    </div>
  );
}

// 邊線在過渡期間跟著節點重畫（讀真實 DOM 位置）
function animateEdges(wrap: HTMLElement, svg: SVGSVGElement, nodes: PlanningNode[], pos: Map<string, Pos>) {
  const byId = new Map(nodes.map(n => [n.id, n]));
  const color = (n: PlanningNode) =>
    n.status === 'done' ? 'var(--st-done)' : n.status === 'pending' ? 'var(--st-pending)' : 'var(--st-active)';
  const center = (id: string, side: 'r'|'l'|'t'|'b') => {
    const el = wrap.querySelector<HTMLElement>(`#pn-${id}`)!, host = wrap.getBoundingClientRect(), r = el.getBoundingClientRect();
    const x = r.left - host.left, y = r.top - host.top;
    return side === 'r' ? { x: x + r.width, y: y + r.height / 2 }
         : side === 'l' ? { x, y: y + r.height / 2 }
         : side === 'b' ? { x: x + r.width / 2, y: y + r.height }
         : { x: x + r.width / 2, y };
  };
  const draw = () => {
    let d = '';
    for (let i = 0; i < 3; i++) {                       // spine 主軸
      const a = byId.get(`p${i}`), b = byId.get(`p${i + 1}`); if (!a || !b) continue;
      const s = center(a.id, 'r'), t = center(b.id, 'l'), dx = (t.x - s.x) / 2;
      d += `<path d="M${s.x} ${s.y} C${s.x + dx} ${s.y},${t.x - dx} ${t.y},${t.x} ${t.y}" fill="none" stroke="${color(b)}" stroke-width="1.5" stroke-opacity=".55" marker-end="url(#pgArr)"/>`;
    }
    const groups: Record<string, PlanningNode[]> = {};
    for (const n of nodes) if (n.kind !== 'phase' && n.parent) (groups[n.parent] ??= []).push(n);
    for (const pid of Object.keys(groups)) {            // 章節/epic/story 串成一條 thread（避免扇形雜亂）
      let prevId = pid;
      for (const n of groups[pid]) {
        const s = center(prevId, 'b'), t = center(n.id, 't'), dy = (t.y - s.y) / 2;
        d += `<path d="M${s.x} ${s.y} C${s.x} ${s.y + dy},${t.x} ${t.y - dy},${t.x} ${t.y}" fill="none" stroke="${color(n)}" stroke-width="1.5" stroke-opacity=".5"/>`;
        prevId = n.id;
      }
    }
    const defs = svg.querySelector('defs')!.outerHTML;
    svg.innerHTML = defs + d;
    svg.setAttribute('width', `${wrap.clientWidth}`); svg.setAttribute('height', `${wrap.clientHeight}`);
  };
  const reduce = matchMedia('(prefers-reduced-motion: reduce)').matches;
  if (reduce) { draw(); return; }
  const t0 = performance.now();
  const loop = () => { draw(); if (performance.now() - t0 < 780) requestAnimationFrame(loop); };
  requestAnimationFrame(loop);
}
```

```css
/* apps/web/src/planning/planningGraph.css */
.pg-wrap { position: relative; width: 100%; min-height: 300px; }
.pg-edges { position: absolute; inset: 0; pointer-events: none; z-index: 0; }
.pnode {
  position: absolute; left: 0; top: 0; display: flex; align-items: center; gap: 9px;
  padding: 0 11px; box-sizing: border-box; z-index: 1; overflow: hidden;
  border: .5px solid var(--line); border-radius: var(--r-lg); background: var(--surface-1);
  transition: transform .55s cubic-bezier(.22,.61,.36,1), opacity .42s ease, border-color .35s ease;
}
.pnode .rail { position: absolute; left: 0; top: 0; bottom: 0; width: 3px; background: var(--acc); transition: background .35s; }
.pnode .nicon { font-size: 17px; color: var(--acc); flex: 0 0 auto; transition: color .35s; }
.pnode .ntext { min-width: 0; flex: 1; }
.pnode .ntitle { font: 500 var(--t-body)/1.25 var(--font-sans); color: var(--tx-1); white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
.pnode .nmeta { font: var(--t-meta)/1.2 var(--font-mono); color: var(--tx-2); white-space: nowrap; overflow: hidden; text-overflow: ellipsis; margin-top: 1px; }
.pnode .ring .rt { fill: none; stroke: var(--line); stroke-width: 2.5; }
.pnode .ring .rp { fill: none; stroke: var(--acc); stroke-width: 2.5; stroke-linecap: round; transform: rotate(-90deg); transform-origin: center;
  transition: stroke-dashoffset .65s cubic-bezier(.22,.61,.36,1), stroke .35s; }
.pnode.s-pending { --acc: var(--st-pending); }
.pnode.s-active  { --acc: var(--st-active);  border-color: var(--line-2); }
.pnode.s-asking  { --acc: var(--st-asking);  border-color: var(--line-2); }
.pnode.s-done    { --acc: var(--st-done); }
.pnode.leap      { border-color: var(--st-leap); }
@media (prefers-reduced-motion: reduce) { .pnode, .pnode .rp { transition: none; } }
```

> 依賴策略（ponytail 紀律）：**不引入 React Flow / d3 / elkjs**。一個 ~120 行 layout + FLIP 已足夠，避免為這個圖拉重套件。若日後節點數爆增（>數百），再評估 `elkjs` 只做 layout。

---

## 4. 其餘互動模組（對應後端，精簡寫法）

### 4.1 `RuleRegistryEditor`（ADR-0012）

把後端 `configs/rule_registry.yaml` 的每條規則變成一列可編輯卡，存檔即 PUT。**這就是「規則可視化修改」的本體。**

```tsx
// 形狀：Rule = { id, type:'write_set'|'budget'|'quality'|'tool_grant'|'forbidden', scope, value, enabled }
function RuleRegistryEditor() {
  const [rules, setRules] = useState<Rule[]>([]);
  useEffect(() => { fetch('/api/rule-registry').then(r => r.json()).then(setRules); }, []);
  const save = (r: Rule) => fetch(`/api/rule-registry/${r.id}`, {
    method: 'PUT', headers: { 'content-type': 'application/json' }, body: JSON.stringify(r),
  });
  return (
    <div className="rules">
      {rules.map(r => (
        <div key={r.id} className="rule-row">
          <span className="badge">{r.type}</span>
          <span className="scope">{r.scope}</span>
          <input defaultValue={String(r.value)} onBlur={e => save({ ...r, value: e.target.value })} />
          <Toggle checked={r.enabled} onChange={v => save({ ...r, enabled: v })} />
        </div>
      ))}
    </div>
  );
}
```

### 4.2 `WorkModeSwitcher`（ADR-0014）+ 全域過濾

切 greenfield / brownfield；切換後把 `mode` 灌進 context，`SkillsPanel` 與（未來的）skill 掛載、`PlanningGraph` 的 spine 分叉都隨之變。**這就是「工作模式可復用、不混搭」的入口。**

```tsx
const WorkModeCtx = createContext<'greenfield' | 'brownfield'>('greenfield');
function WorkModeSwitcher() {
  const [mode, setMode] = useState<'greenfield' | 'brownfield'>('greenfield');
  useEffect(() => { fetch('/api/work-mode').then(r => r.json()).then(d => setMode(d.mode)); }, []);
  const pick = (m: typeof mode) => { setMode(m); fetch('/api/work-mode', { method: 'PUT', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ mode: m }) }); };
  return (
    <div className="seg">
      {(['greenfield', 'brownfield'] as const).map(m => (
        <button key={m} aria-pressed={mode === m} className={mode === m ? 'on' : ''} onClick={() => pick(m)}>{m}</button>
      ))}
    </div>
  );
}
```

### 4.3 `SkillsPanel` 擴充（ADR-0015）

`SkillsPage.tsx` 已有 `enabled` / `builtin` 欄位與 toggle/delete。只需：**(1) 依 `work_mode` 分組三段（greenfield / brownfield / shared，不混搭）；(2) codegraph、ponytail 顯示「預設安裝」徽章且預設開**。

```tsx
const GROUPS = ['greenfield', 'brownfield', 'shared'] as const;
function SkillsPanel({ skills }: { skills: SkillEntry[] }) {
  return <>{GROUPS.map(g => (
    <section key={g}>
      <h3>{g}</h3>
      {skills.filter(s => s.work_mode === g).map(s => (
        <SkillRow key={s.skill_id} skill={s}
          badge={s.builtin && ['shared.codegraph-query', 'shared.ponytail'].includes(s.skill_id) ? '預設安裝' : undefined} />
      ))}
    </section>
  ))}</>;
}
```

### 4.4 ~~`SandboxStatusBadge`（ADR-0013）~~ — 已刪除（STORY-TRUST.4 / ADR-0013）

> 本小節（原 `SandboxStatusBadge` 四盞 egress 探測燈）已**刪除**。依 `ADR/ADR-0013-no-sandbox-operator-trust.md`，執行端**沒有沙箱/egress 牆**（cage 從未真正建起來），因此**沒有牆可證明**，也**不放**一顆宣稱「沙箱牆已證明有效」的徽章——那會是幻影防線（leave no phantom defense）。`GET /api/sandbox/egress-proof` 不需新建。
>
> **誠實替代（可選，一行純狀態）**：cockpit 顯示「**執行：直接在主機（無沙箱）**」，誠實標示沒有防護，而非假裝有。

---

## 5. 落地順序（對應後端 Phase 6 cockpit）

| 步 | 內容 | 依賴 |
|---|---|---|
| F1 | 落 `tokens.css`、把現有元件的 inline hex 換成變數、字級/字體歸位 | 無（先做，立刻變好看） |
| F2 | `App.tsx` 新增 **Planning 分頁**；接 `usePlanningGraph` + `PlanningGraph` 元件 | 後端吐 planning trace 事件（ADR-0011） |
| F3 | 後端事件接通後，逐條驗證動態：一句話加章節 / 讀 repo 跳進度 / 拆 backlog 長 epic-story | F2 |
| F4 | `WorkModeSwitcher` + 全域過濾；`SkillsPanel` 三段分組 + 預設 skill 徽章 | 後端 work_mode / skills API（ADR-0014/0015） |
| F5 | `RuleRegistryEditor`（+ 可選：一行「執行：直接在主機（無沙箱）」狀態） | 後端 rule_registry API（ADR-0012）。~~`SandboxStatusBadge` / egress-proof API~~ 已刪除（STORY-TRUST.4 / ADR-0013）。 |

> 後端需配合新增的 API：`/api/rule-registry`、`/api/work-mode`，以及 `/api/trace` 上的 planning 事件。這些列入後端 Phase 6 一起做。（`/api/sandbox/egress-proof` 已移除——無沙箱牆。）

---

## 6. 我的想法（前端立場，一句句寫出來）

1. **後端把規則變資料，前端就有義務把每條資料變成看得到、按得到的一列**——否則「可視化配置」只是口號。
2. **planning 流程圖的主角是「變化的那一刻」**：進度跳、章節冒。靜態管線是錯的隱喻，因為 planning 本來就是非單調、會湧現的。
3. **主軸固定、其餘向下生長**——這個 layout 本身就在替後端哲學說話：spine 硬編碼，章節/epic/story 是長出來的資料。
4. **能用 120 行 layout + FLIP 解決，就不拉 React Flow**——前端也守 ponytail 紀律。
5. **誠實勝過裝飾（ADR-0013 / STORY-TRUST.4）**：執行端沒有沙箱牆，所以**不放**宣稱「沙箱牆有效」的徽章——那是幻影防線。若要顯示，就誠實標一行「執行：直接在主機（無沙箱）」。UI 只反映真實之物（policy 旋鈕、work mode、skill、planning），不假裝一個不存在的保護。
