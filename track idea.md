# Vigil — HackAI 2026 Track 02 想法记录

> 本文件记录 HackAI 2026 Track 02（Secure Logistics & Digital Trust）的完整方案讨论：想法是什么、用什么工具、以及这个想法怎么解决问题。

---

## 目录

1. [比赛信息](#1-比赛信息)
2. [赛道要求拆解](#2-赛道要求拆解)
3. [核心想法](#3-核心想法)
4. [问题陈述](#4-问题陈述)
5. [核心论点：为什么不去证明送达](#5-核心论点为什么不去证明送达)
6. [系统架构](#6-系统架构)
7. [Agent 层设计](#7-agent-层设计)
8. [演示场景 S0–S6](#8-演示场景-s0s6)
9. [实验设计](#9-实验设计)
10. [工具栈](#10-工具栈)
11. [评分对照](#11-评分对照)
12. [已知限制](#12-已知限制)
13. [范围纪律](#13-范围纪律)
14. [待办清单](#14-待办清单)

---

## 1. 比赛信息

| 项 | 内容 |
|---|---|
| 名称 | GDEX × ANON × UTAR Agentic AI Cybersecurity Hackathon 2026 |
| 网址 | https://hackai.my/ |
| 赛道 | Track 02 — Secure Logistics & Digital Trust |
| 项目名 | **Vigil** |
| 队名 | XM3 |
| 队伍 | 单人（Ho Qi Yuan, Multimedia University） |
| 提交截止 | **2026 年 10 月 15 日** |
| 入围路演 | 2026 年 11 月 11 日，UTAR 金宝校区 |
| 奖金 | RM5,000（冠军 2,500 / 亚军 1,500 / 季军 1,000） |
| 费用 | 免费 |

### 提交物

| 项 | 状态 |
|---|---|
| PDF / Proposal | **必填**，已交一页草稿卡位 |
| Pitch deck | 可选 |
| Demo video | 可选（MP4 / MOV / WEBM） |
| POC / Source code | 可选（ZIP / PDF / 图片） |
| Prototype / GitHub | 可选（HTTPS 链接） |
| Team profile / CV | 可选 |

注册后会拿到一个 **private management link**，截止前可以随时回来更新。

### 评分权重

| 维度 | 权重 |
|---|:---:|
| Technical implementation | 25% |
| Problem relevance | 20% |
| Effective use of Agentic AI | 20% |
| Cybersecurity value | 20% |
| Presentation & usability | 15% |

---

## 2. 赛道要求拆解

### Brief 原文的关键句

> Build one agent, a coordinated multi-agent system or an agent-enabled platform for a specific trust problem such as route deviation, suspicious handoff, cold-chain failure, **proof-of-delivery fraud** or supplier risk.

> Deliver a working, testable prototype that follows at least one realistic shipment scenario **from normal activity to a meaningful exception**.

> Show the events received, the checks and tools selected, the evidence behind the decision and the next action—such as requesting verification, escalating a handoff or **proposing a safe reroute**. Include **operator approval for disruptive actions**, keep an **audit trail** and demonstrate a **useful result** such as earlier detection, fewer false alerts or reduced review time.

### 四个项目方向

| # | 方向 | 我们选的 |
|---|---|:---:|
| 01 | Route anomaly agent | |
| 02 | Cold-chain guardian | |
| 03 | **Handoff trust verifier** — Cross-check scans, identity and location before accepting proof of delivery or custody | ✅ |
| 04 | Supplier-risk monitor | |

### 演示必须包含的六项

```
01  Problem & user
02  Inputs & evidence
03  Agent workflow
04  Defensive action
05  Human approval
06  Result & limitations
```

### 提交必须证明的五条

```
Clear problem
Working flow or prototype
Evidence of value
Human oversight
Known limitations
```

### 官方参考资料

- GS1 EPCIS 2.0 — 供应链事件标准（what / when / where / why / how，含传感器数据与 JSON）
- GS1 EPCIS 实施指南 — 用事件模型设计真实的合成运单与托管数据
- CISA 供应链风险资源 — 供应商、技术与运营风险的框架材料

Brief 明确允许：**「run locally with synthetic delivery data that you document clearly」**。所以合成数据本身不是扣分项，但必须有清楚的文档。

---

## 3. 核心想法

**Vigil 是一个 agent 系统，它不试图证明一次送达真的发生了——它检测物理上不可能的声明、识别跨次数的欺诈模式，并且把操作员的批准变成密码学上必需的一步，而不是界面上的一个按钮。**

三个支柱：

| 支柱 | 一句话 |
|---|---|
| **交叉信号一致性** | 单个信号都能伪造，但让所有信号同时自洽很难 |
| **正交门** | 单次矛盾和累积模式是两个独立维度，模式才是欺诈 |
| **构成性批准** | 没有操作员的签名，高风险交接在密码学上凑不齐有效凭证 |

---

## 4. 问题陈述

三条独立的痛，各自成立：

### 1. 签收扫描是整条信任链的终点，而它本身从未被验证

后续的争议处理、赔付、SLA 考核、快递员绩效，全部建立在一次手持机上的按键之上。这个按键没有任何东西为它背书。

### 2. 内部欺诈和操作失误在数据上是同一个形状

快递员在楼下把整车扫成「已送达」再慢慢送，和真的伪造签收，产生的事件记录完全一样。事后只能靠抽查。

### 3. 异常检测出来之后，链条断在「谁有权处理」

告警升级给操作员，操作员点一下确认——这个确认没有作用域、没有上限、没有冷却，而且**如果没人点，流程就死在那里**。

> ⚠️ **待补**：这三条里需要真实的马来西亚数字（快递争议率、"已送达但未收到"投诉量）。问题陈述里有两个真数字，比整个架构图都值钱。

---

## 5. 核心论点：为什么不去证明送达

### 诚实的前提

照片、GPS、OTP、签名，**单独每一个都能伪造**。任何声称能证明送达真实性的系统都在说谎。

### 所以换问题

> 不是「这次送达是真的吗」，而是
> **「这组声明彼此自洽吗」**，以及
> **「一个欺诈者在暴露之前能撑几次」**。

要伪造 GPS 很容易。要让 GPS、基站 ID、WiFi 扫描、加速度计、照片时间戳、服务器接收时间**同时讲同一个故事**，而且**重复几十次不留下模式**，成本会陡增到不划算。

这个框架的好处是它**可以量化**——前一个不行。

### 真实世界的五层防线（我们实现其中三层）

| 层 | 做法 | Vigil |
|---|---|:---:|
| 1. 设备完整性证明 | Play Integrity、mock location 检测、硬件密钥库签名 | 模拟 |
| 2. **交叉信号一致性** | GPS vs 基站 vs WiFi vs 加速度计的矛盾检测 | ✅ 核心 |
| 3. 收件人独立通道 | OTP 走另一条网络到另一台设备；异步确认 | 部分 |
| 4. 物理邻近证明 | NFC / BLE 签名挑战，不依赖 GPS | 不做 |
| 5. **统计与经济层** | 信任分、争议率、抽样复核；给风险定价而非验证每一次 | ✅ 核心 |
| 6. 结构性消除 | 改按「收件人确认」计件；包裹柜 | 写进 roadmap |

---

## 6. 系统架构

### 第一层 · 证据模型（GS1 EPCIS 2.0）

| EPCIS 维度 | 字段 | 用来查什么 |
|---|---|---|
| **what** | `epcList` | 包裹是否在该快递员作用域内 |
| **when** | `eventTime` / `recordTime` / `eventTimeZoneOffset` | **两个时间的差值是免费的篡改检测器** |
| **where** | `readPoint` / `bizLocation` | 扫描位置 vs 收件地址；与上一事件的物理可达性 |
| **why** | `bizStep` / `disposition` / `bizTransactionList` | 托管链连续性 |
| **how** | `sensorElementList` | 设备 ID、加速度、气压、电量 |

事件类型：`ObjectEvent`（扫描）+ `TransactionEvent`（交接）+ `AssociationEvent`（设备绑定）。
`eventID` 自带 UUID，直接当 nonce 用。

**为什么用 EPCIS 而不是自定义 JSON**：这是 GS1 的国际标准，GDEX 这类企业的系统就是按它建的。评委一看就知道你没在编数据。

---

### 第二层 · 确定性引擎

#### 硬性检查 — 任一失败即整体中止

| # | 检查 | 失败含义 |
|---|---|---|
| H1 | 托管链连续性：上一事件的 `disposition` 允许本次 `bizStep` | 状态跳跃，包裹凭空出现 |
| H2 | EPC 在快递员 mandate 作用域内 | 越权扫描 |
| H3 | mandate 为 active 且在有效期内 | 已撤销 / 暂停 / 过期 |
| H4 | `eventID` 重放检查 | 伪造复用 |

四项是一个整体，**不允许部分接受**。

#### 不一致性计分 — 累加，上限 100

每一条都是**跨信号矛盾**，不是单信号真伪判断：

| # | 矛盾 | 分 | 标记文案 |
|---|---|:---:|---|
| I1 | GPS 位置与基站 ID / WiFi 扫描冲突 | **+40** | 位置信号相互矛盾 |
| I2 | 加速度计静止但 GPS 显示移动 | **+40** | 运动数据与轨迹不符 |
| I3 | 上一事件→本事件所需速度 > 120 km/h | +40 | 物理上不可能的移动 |
| I4 | `eventTime - recordTime` ≥ 30 分钟（设备时间在服务器接收之后） | +30 | 设备时间戳可能被篡改 |
| I5 | `recordTime - eventTime` ≥ 480 分钟（服务器延迟收到离线事件） | +10 | 事件离线积压超过一个班次 |
| I6 | 设备 ID 与快递员绑定不符 | +25 | 使用未绑定设备 |
| I7 | 检测到 mock location provider | **+50** | 位置来自模拟器 |
| I8 | 设备完整性证明失败（root / 篡改） | **+50** | 设备环境不可信 |
| I9 | 照片 EXIF 时间与事件时间不一致 | +25 | 照片可能非现场拍摄 |
| I10 | 扫描位置偏离收件地址 > 2km | +40 | 位置严重偏离 |
| I11 | 同上 > 200m | +20 | 位置偏离 |
| I12 | 签收证据缺失（照片/OTP/签名，每缺一项） | +15 | 缺少签收凭证 |
| I13 | 超出 mandate 允许时间窗 | +20 | 非授权时段 |
| I14 | 电量曲线与声称移动距离不匹配 | +10 | 能耗与轨迹不符 |

**每一分带一条大白话标记，且指向具体的字段值。** 直接命中 brief 的「the evidence behind the decision」。

#### 模式分 — 独立计算，按快递员滚动窗口

| # | 模式 | 分 |
|---|---|:---:|
| P1 | 10 分钟内签收数超阈值 | +25 |
| P2 | 「已送达但客户称未收到」争议率高于队列基线 | **+40** |
| P3 | 单次不一致性得分的方差异常低（太干净） | +20 |
| P4 | 送达地点聚集度异常 | +30 |
| P5 | 近 N 次中重复出现同一类矛盾 | +25 |

---

### 第三层 · 正交门（招牌设计）

单次不一致性和累积模式是**两个独立维度**：

| 单次矛盾 | 累积模式 | 输出 |
|:---:|:---:|---|
| 高 | 低 | **标记，要求补证据** — 很可能是设备故障（隧道里 GPS 漂移） |
| 低 | **高** | **升级调查该快递员** — 每一次单独看都合格，但形状不对 |
| 高 | 高 | **立即冻结作用域** |
| 低 | 低 | 自动接受 |

**第二行是整个方案最强的一幕。** 所有别的系统都在做逐次判定。一个足够小心的欺诈者可以让每一次都通过阈值，但他改变不了自己的分布。

界面上做成**可拖动的双轴门探索器**：评委自己拖两个阈值，看着同一批事件的判决重新分布。

---

### 第四层 · 授权对象（不是权限表）

```
CourierMandate {
  mandate_id, courier_id

  scope: {
    epc_prefixes: []           # 哪些包裹
    biz_locations: []          # 哪些路线
    biz_steps: []              # 允许哪些动作
  }

  limits: {
    max_handoffs_per_shift
    cod_cash_cap               # 代收货款上限
    max_parcel_value
  }

  validity: { not_before, not_after, time_windows: [] }
  cooldown_seconds             # 高风险交接后的冷却

  requires_cosign_if: [
    parcel_value > threshold,
    recipient_address not in scope,
    inconsistency_score >= 30,
    pattern_score >= 40
  ]

  status: active | paused | revoked
  nonce_counter
}
```

#### 关键设计：批准必须是构成性的，不是装饰性的

| 风险等级 | 验证要求 |
|---|---|
| 低风险交接 | 快递员密钥单签的 token 即可通过 |
| **高风险交接** | 需要**快递员密钥 + 操作员密钥共同签出**的 token。快递员那一半单独提交，服务端**验签直接不通过** |

操作员的批准不是数据库里的 `approved = true`，而是**没有它，这次交接在密码学上凑不齐有效凭证**。

> 评委问「那个批准按钮是不是假的」——答案是「不是，不点它验签过不了」。

#### 两档预设

| | Standard Route | Trusted Route |
|---|---|---|
| 适合 | 新快递员、高价值路线 | 长期记录良好 |
| 未列出的收件地址 | **需 co-sign** | 允许 |
| 单次代收上限 | RM 200 | RM 1,000 |
| 班次交接上限 | 60 | 150 |
| 确定性引擎 | **总是** | **总是** |
| 模式分监控 | **总是** | **总是** |

**两档都不关闭引擎或模式监控。班次上限永远是硬性停止，即使有 co-sign。**

---

### 第五层 · 幂等与重放

```
收到 eventID = X
├─ 不在注册表 → 处理，记录 (X, sha256(payload), verdict)
├─ 在注册表 且 hash 相同 → NO-OP，返回原判决
│    （信号差的地方快递员按了两次，不该产生两条记录）
└─ 在注册表 但 hash 不同 → ABORT + EVENT_ID_REUSE
     （有人拿合法 eventID 套了不同内容 = 伪造）
```

注册表从 **append-only JSONL 账本**重建。演示时把服务重启，重放照样被拦。

**这个账本刻意用文件不用数据库表**——append-only 文件本身就是不可篡改的论证。

---

### 第六层 · 活性路径

所有系统都止步于「检测 → 升级」。没人问：**如果升级之后没人处理呢？**

| 情况 | 超时路径 |
|---|---|
| 交接待验证，操作员 N 分钟无响应 | **不默认视为已送达**。状态回退到「在途·待复核」，通知收件方 |
| 交接完成但收件方 M 小时未提异议 | 自动结案，证据封存 |
| 快递员已提交证据但服务端未判定 | 超时后按最保守档处理，记录一条服务降级事件 |

> **任何一方都无法通过不作为拖死另一方。**

---

## 7. Agent 层设计

```
1. parse             EPCIS 事件 → 结构化 what/when/where/why/how

2. lookup            EPC → 包裹注册表；courier → mandate 注册表
                     未匹配 → { known: false, risk: "high" }

3. plan          ← LLM，但只能从封闭 zod 枚举里选 0–2 个工具：
                     fetch_route_history
                     check_traffic_weather
                     lookup_recipient_history
                     出错或 lite 模式 → 完全相同的确定性启发式

4. verify            确定性引擎 — **轴 1：单次不一致性**
                     H1–H4（硬性检查）+ I1–I14（矛盾计分）
                     不需要历史，只看这一条事件自身

5. fetch_history     （条件）该快递员/路线近期行为
                     — **轴 2：累积模式** P1–P5（滑动窗口）

6. external_context  （条件）天气/交通，用于解释异常停留

7. gate              **两个轴在这里交汇，而且只在这里**
                     正交矩阵 → accept | flag | escalate | freeze
                     检查 mandate 上限、冷却、co-sign 要求
                     ← **判决在这里产生**

8. explain       ← LLM，写给操作员的解释与升级说明
                     schema 强制只能引用已收集的证据 ID
                     引用不存在的 ID → fail closed
```

### 为什么判决在 gate 而不在 verify

原先的设计把 H1–H4 + I1–I14 + P1–P5 全放在节点 4，但 P1–P5 是按快递员滑动窗口算的，而历史要到节点 5 才取——依赖倒置了。

拆开之后不只是修好了顺序，而是让**状态机的形状本身讲出了正交门的论证**：

| 节点 | 产出 | 依赖 |
|---|---|---|
| `verify` | 轴 1 — 单次不一致性（H1–H4, I1–I14） | 只需要本条事件 |
| `fetch_history` | 轴 2 — 累积模式（P1–P5） | 需要快递员历史 |
| `gate` | 判决 | 两个轴 |

两个分数**存为两个字段，永远不相加**。相加就让正交矩阵的第二行（低单次 + 高模式 → 升级）变得不可达，而那一行是整个项目唯一别人不会有的东西。

> 写进 CLAUDE.md：这个拆分是故意的，不允许后续“简化”回一次评分。

### 核心断言

> **把整个 LLM 层拔掉，系统产出完全相同的判决；只有给操作员的解释会退化成结构化的标记列表。**

这一句同时覆盖 Technical 25% 和 Agentic AI 20%，而且是评委最难问倒的答案。

### 可见性

前端通过 **SSE 实时流**显示 `tool_start` / `tool_end` / `thought` / `result` 帧，让 agent 的推理过程可见。

这算在 **Agentic AI 那 20 分**里，不是演示的 15 分——这是唯一一处「前端投入换技术分」的地方。

---

## 8. 演示场景 S0–S6

每个场景都是**一条完整的运单时间线**，不是孤立的单点事件：

```
揽收（正常）
  → 分拣中心入库（正常）
  → 干线运输（正常）
  → 派件网点出库（正常）
  → 派送扫描 ①（正常）
  → 派送扫描 ②（正常）
  → 派送扫描 ③ ← 异常在这里出现
  → agent 介入 → 升级 → 操作员 co-sign → 处置
```

| # | 场景 | 考什么 |
|---|---|---|
| **S0** | 正常送达 | **证明系统不会乱标**（brief 明文要 fewer false alerts）。**且全程不需要 co-sign** |
| S1 | GPS 欺骗 | 派送扫描位置与基站矛盾 → I1 / I7 |
| **S2** | **整栋公寓批量签收** | **单次都干净，模式分暴露** → 正交门第二行。P1 + P2 |
| S3 | **eventID 复用** | 同 eventID 不同内容 → H4 ABORT |
| S4 | 越作用域 | 快递员扫了不属于他路线的包裹 → H2 |
| S5 | 时钟篡改 | `eventTime` 比服务器接收时间快 105 分钟 → I4 |
| **S6** | 设备问题（假阳性对照） | 地库 GPS 精度劣化，看起来像 S1 但模式干净 → **系统正确地不升级** |

> **S3 命名更正**：原表写「EPC 复用」，但描述的机制和真正拦下它的检查（H4）都是 **eventID 复用**，不是包裹标识复用。已按机制正名。

### S2 为什么从「货车上批量扫」改成「整栋公寓」

原设计是快递员把车停在路边，把一车**地址分散**的包裹全扫成已送达。**把这个场景对着引擎推演一遍，它做不成招牌案例**：

- 在一个点上扫地址分散的包裹 → 每一次扫描都离收件地址几百米到几公里 → **I10/I11 每一次都触发**，单次不干净；
- 若为了修这个而把声称位置铺到各个地址上 → 连续两次扫描之间的隐含速度爆表 → **I3 触发**，单次还是不干净。

两条路都被轴 1 抓住，S2 就不再是「只有模式轴能看见」的那个案例了。

**改成整栋公寓（40 件同一栋楼、20 秒一件、事后客户投诉）之后每一次都真干净**：

- 收件地址本来就聚集 → **P4 正确地不响**（这是一栋楼，不是欺诈）；
- 扫描点就在各户门口 → I10/I11 干净；
- 相邻两户只差几米 → I3 干净；
- 每一次单次得分为 **0**。

剩下的只有形状：**P1** 看见没人走得出来的派送速率，**P2** 看见客户投诉。两者都不存在于任何单次事件里——P1 是**集合的属性**，P2 是**事后才到达的结果**。

> **这是一句可以直接拿去讲的话**：欺诈者可以伪造**在哪里**，但伪造不了**有多快**，也伪造不了**客户到底收到没有**。
>
> 这也是模式轴不是单次轴的「补充」而是**结构上不同种类的证据**的最清楚说明。

（此处的改动是**推演**发现的，不是跑出来发现的——写代码之前对着已建成的引擎逐条核对场景，就看出原版自相矛盾。）

### 三个必演的画面

1. **S2** — 每一次单独看都合格，但形状不对 → 升级调查（别人没有这一幕）
2. **S6** — agent 主动调用天气 API 发现该时段暴雨，**决定不升级**（证明工具选择有意义 + 系统不一味标红）
3. **快递员单签的高风险交接验签失败**，操作员 co-sign 后通过；再演一次超班次上限的，**即使 co-sign 也被拒**

留 15 秒给「系统拒绝」那一幕。

---

## 9. 实验设计

### 招牌实验：攻击者成本

在合成数据里造一个欺诈者，让他伪造的信号数量递增，测**在被标记之前他能完成多少次假送达**：

| 伪造了什么 | 需要的能力 | 预期结果 |
|---|---|---|
| 只改 GPS | 装一个 mock location app | I7 第 1 次就抓 |
| GPS + WiFi / 基站 | root 设备 | I8 完整性证明拦下 |
| + 加速度计 | 打补丁的 app | 撑 N 次，被模式分抓 |
| + 收件人不投诉 | 与收件人串通 | 撑更久，靠争议率关联 |
| 全部 + 系统性内部串通 | — | **抓不到 → 写进 Known Limitations** |

最后一行把「抓不到有准备的攻击者」从弱点变成**一个测出来的边界**。

### 另外五组

| # | 实验 | 命中 |
|---|---|---|
| 2 | 五类注入攻击的逐类检出率 | Cybersecurity value |
| 3 | 正常交接的误报率 | brief 明文的 "fewer false alerts" |
| 4 | LLM 单独判决的不稳定性（同输入跑 5 次，报告不一致率） | 支撑「判决必须确定性」的论证 |
| 5 | 引用幻觉率（schema 校验前 vs 后，**两个数字都放**） | Agentic AI |
| 6 | 阈值敏感度曲线（80→160 km/h 扫描，画检出率 vs 误报率） | 消掉「阈值是编的」质疑 |

### 实验设计的五条纪律

合成数据本身 brief 允许，但**假实验有问题**。避免循环论证：

1. **生成器和检测器用不同的抽象** — 生成器造行为，检测器看统计量，两边不共享参数
2. **加负对照** — 跑纯正常数据，报告误报率
3. **参数扫描而不是单点** — 让欺诈者的「小心程度」连续变化，画曲线
4. **盲化** — 先造 200 个场景，随机分 100/100，只在前 100 上调参
5. **写进限制清单** — 明说生成器与检测器的抽象层分离，但真实分布未经检验

> 阈值不要说「我们选了 120」，改成引用来源：马来西亚高速限速 110 km/h + GPS 误差余量 = 120。有出处的数字就不再是拍脑袋。

---

## 10. 工具栈

### AI 模型

| 用途 | 选型 | 理由 |
|---|---|---|
| 主力 | **Gemini**（Google AI Studio） | 免费额度，OpenAI 兼容格式。额度去 `ai.google.dev` 确认 |
| 对照实验 | **Claude API** | 需要第二个模型家族做一致性对照。模型和价格看 `docs.claude.com` |
| 本地兜底 | **Ollama** + Llama / Qwen | 断网也能演；「敏感物流数据不出本地」是架构加分 |

Brief 原文：「use Claude, Gemini or open-source models; or run locally」——三条全占。

### Agent 编排

```
自己写状态机（约 150 行 switch + context）
zod                    ← 核心依赖，不是辅助
```

`zod` 撑起两个卖点：节点 3 的封闭工具枚举、节点 8 的引用校验（fail closed）。

不用 LangGraph——8 个节点用框架是负担，而且多一层要向评委解释的东西。

### 后端与存储

| 选型 | 用途 |
|---|---|
| Next.js（App Router） | 前后端一体，单人别分两个仓库 |
| TypeScript | schema 类型前后端共用 |
| Node 22+ | **内置 Ed25519**，省一个依赖 |
| SQLite + better-sqlite3 | 事件、mandate、判决、时间线 |
| Drizzle ORM | schema 与迁移 |
| 纯 `.jsonl` append-only | **nonce 账本**（刻意不放数据库） |

### 密码学

```js
// Node 内置 crypto，零依赖
crypto.generateKeyPairSync('ed25519')
crypto.sign(null, msg, privKey)
crypto.verify(null, msg, pubKey, sig)
crypto.createHash('sha256')   // 账本哈希链
```

需要浏览器端签名时才装 `@noble/curves`。

### 数据生成

| 工具 | 用途 |
|---|---|
| **`@turf/turf`** | 距离、点在多边形内、沿路线插值。**必需**，别自己写 haversine |
| **`seedrandom`** | 可复现种子。**留出集和对照实验的前提** |
| `@faker-js/faker` | 姓名、电话、订单号 |
| OSM Nominatim / 静态坐标表 | 真实的吉隆坡 / 雪兰莪地址 |
| `date-fns` | 班次、时间窗、时区 |

**EPCIS 没有好用的 npm 库** — 从 GS1 规范手抄类型定义成 zod schema。

### 外部 API

| API | 用途 | Key |
|---|---|:---:|
| **Open-Meteo** | 天气，用在 **S6 假阳性场景** | 不需要 |
| OSM Nominatim / Overpass | 地址反查、道路数据 | 不需要 |
| 模拟的完整性证明 | Play Integrity 替身，标注 mocked | — |

Brief 点名了 mapping / weather / identity / sensor 四类 API，我们占了三类半。

### 统计与测试

| 工具 | 用途 |
|---|---|
| `simple-statistics` | 方差、z-score、百分位 — 模式分靠它 |
| `vitest` | 单元测试 + 实验批跑脚本 |

### 前端（受限动画：只用 `motion`）

| 选型 | 用途 |
|---|---|
| Tailwind CSS 4 | 样式 |
| shadcn/ui | 表格、tabs、dialog、时间线 |
| **ECharts**（`echarts-for-react`） | **双轴门探索器**（散点 + 两条可拖阈值线） |
| `react-leaflet` + OSM 瓦片 | 地图，免 key |
| `lucide-react` | 图标 |
| **原生 `EventSource`** | SSE 实时推理流，不需要库 |
| **`motion`** | 只用于时间线节点入场、展开自有卡片时的布局过渡、判决徽章状态变化 |

动画不是统一的视觉装饰，而是按证据的含义受限使用：

- **允许**：时间线节点在播放时入场、自有卡片展开时的布局过渡、判决徽章状态变化。
- **双轴门探索器禁止动画**：拖阈值时必须立刻重着色；缓动会被读成延迟，破坏「我拖，它现在就变」的证据价值。ECharts 保持 `animation: false`。
- **SSE 推理流禁止入场动画**：节点本来就有真实执行时间；装饰动画会让观众分不清延迟来自计算还是表演，反而削弱 Agentic AI 证据。
- **flag 展开不弹跳**：操作员一班会重复点几十次。shadcn/Radix 自己管理 `data-state` 生命周期，绝不再套 `AnimatePresence`，避免双重卸载造成 ghosting。

所以只装一个 `motion`，不装 GSAP；这里没有滚动叙事，两套动画库只有负担。

### 部署

**建议：本地跑 + 录视频。** Brief 允许「prototype link **or** concise demo video」。

| 选项 | 坑 |
|---|---|
| Vercel 免费层 | **SSE 在 serverless 上会被超时切断**，要测 |
| Railway / Render 免费层 | Render 闲置后冷启动很慢 |
| Fly.io | 要跑本地模型时用 |

### 开发工具

| 工具 | 用途 |
|---|---|
| Claude Code | 主力编码 |
| Git + GitHub | **第一天就开始 commit**，历史是原创性证据 |
| OBS Studio | 录演示视频 |
| Excalidraw | 架构图放 deck |

### 完整装机清单

```
Node 22+ / pnpm
Next.js + TypeScript + Tailwind 4

zod                      ← 核心
drizzle-orm
better-sqlite3

@turf/turf               ← 数据生成必需
seedrandom               ← 实验可复现必需
@faker-js/faker
date-fns
simple-statistics

echarts-for-react
react-leaflet + leaflet
lucide-react
motion

vitest

（Ed25519 和 sha256 用 Node 内置 crypto，不装）
（SSE 用原生 EventSource，不装）
```

依赖全部免费，总成本接近零；`motion` 的使用面由测试锁死，不会扩散到门探索器或 SSE 流。

三个最容易被低估的：`@turf/turf`（地理检测的正确性）、`seedrandom`（实验可复现是 evidence of value 的前提）、Open-Meteo（唯一能演出「找证据后决定不升级」的免费 API）。

---

## 11. 评分对照

| 评分项 | 权重 | 命中方式 |
|---|:---:|---|
| **Technical implementation** | 25% | EPCIS 标准建模、确定性引擎、幂等 append-only 账本、Ed25519 co-sign、zod schema 强制 |
| **Problem relevance** | 20% | GDEX 是冠名方，这是他们的真实痛点；三条痛点各带具体后果 |
| **Effective use of Agentic AI** | 20% | 封闭枚举工具选择、LLM 不产判决、SSE 可见推理、schema 防幻觉、诚实限制 |
| **Cybersecurity value** | 20% | 攻击者成本量化、五类注入攻击检出率、重放防护、作用域授权 |
| **Presentation & usability** | 15% | 双轴门探索器、四档判决可展开、三个反直觉案例 |

### Brief 六项演示要求逐项对照

| # | 要求 | 演什么 |
|---|---|---|
| 01 | Problem & user | 操作中心复核员，每班面对 N 笔标记交接 |
| 02 | Inputs & evidence | 真实形状的 EPCIS 事件流滚过 |
| 03 | Agent workflow | **SSE 实时流**：8 个节点逐个亮起 |
| 04 | Defensive action | 四档各演一次：接受 / 标记补证 / 升级 / 冻结 |
| 05 | **Human approval** | 快递员单签验签失败 → 操作员 co-sign 通过 → 超班次上限即使 co-sign 也被拒 |
| 06 | Result & limitations | 六组数字 + 限制清单 |

---

## 12. 已知限制

全部要**测出来**，不是声称的：

- **系统抓的是懒惰的攻击者。** 一个 root 过设备、打过补丁、且与收件人串通的内部人，在当前架构下抓不到。这是想法层面的边界，不是原型的缺陷。
- 合成数据依 EPCIS 规范构造，**未用真实车队数据校准**；所有阈值手调。
- GPS 在室内与高楼区精度约 X 米，实测在市中心导致 Y% 误报；已用 hysteresis 缓解到 Z%。
- 时钟偏移检测依赖设备时间。一台完全受控的设备可同时伪造 `eventTime` 和 `recordTime`。
- 作用域检查防越权，防不了在合法作用域内作案的内部人——那需要更长的行为基线。
- co-sign 密钥在演示中存在环境变量里，生产需 HSM 或托管密钥服务。
- 设备完整性证明在演示中是模拟的；真实部署需接入 Play Integrity / DeviceCheck。
- 模式分需要足够的历史样本才稳定，冷启动的新快递员是盲区。
- 生成器与检测器使用不同抽象层以避免循环论证，但真实车队的行为分布可能与假设不同，这是未经检验的。

> 参考：写了 Known Limitations 的项目，工程质量普遍更高。这里它是**明文计分项**，不是加分技巧。

---

## 13. 范围纪律

单人 37 天，明确**不做**：

- ❌ 移动端 app —— 用事件注入器模拟设备
- ❌ 真实的 Play Integrity 接入 —— 模拟其输出并标注
- ❌ 地图路线优化 —— 位置只用于一致性检查
- ❌ 区块链 —— append-only JSONL + 哈希链够了
- ❌ 多语言、无障碍、动画
- ❌ 用户管理 —— 两个硬编码角色：快递员、操作员

### 如果时间不够，保什么

按优先级：

1. **正交门第二行**（低单次 + 高模式 → 升级）—— 唯一别人不会有的东西
2. **构成性 co-sign** —— 做对了是新原语，做成 DB flag 就退化成 RBAC
3. **攻击者成本实验** —— 把弱点变成测出来的边界
4. 双轴门探索器 —— 可交互的论证
5. 其余 I/P 检测项可以从 14+5 砍到 6+2

---

## 14. 待办清单

### 已完成

- [x] 确定赛道（Track 02）与方向（03 Handoff Trust Verifier）
- [x] 注册队伍（XM3，Multimedia University）
- [x] 提交一页草稿 PDF 卡位
- [x] 拿到 private management link
- [x] 确定工具栈

### Brief 对照后必须补的

- [ ] **完整运单时间线视图** —— brief 字面要求「from normal activity to a meaningful exception」，不改会被扣「minimum working outcome」
- [ ] **补厚身份维度** —— brief 方向 03 是「cross-check scans, **identity** and location」三样，目前身份最薄（只有 I6 + mandate 作用域）
- [ ] **加 reroute 作为第三种 next action** —— brief 明示的三种之一，且 reroute 也要走 co-sign
- [ ] **接 Open-Meteo** —— 用在 S6 假阳性场景
- [ ] **写合成数据集文档** —— brief 要求 "documented clearly"
- [ ] **引用 CISA 供应链风险资源** —— brief 列出的三个参考之一，目前只用了 GS1 两个

### 内容缺口

- [ ] 找马来西亚真实的快递争议数据 / "已送达但未收到"投诉统计 —— **问题陈述里有两个真数字，比整个架构图都值钱**
- [ ] 阈值的引用来源（马来西亚限速 110 km/h + GPS 误差余量）

### 提交物

- [ ] 完整 PDF Proposal（替换草稿）
- [ ] Pitch deck
- [ ] Demo video（OBS 录制）
- [ ] GitHub 仓库链接
- [ ] Source code 打包

### 提升胜率的关键动作

- [ ] **找一到两个队友** —— 这是唯一一个现在能控制、且能实质提升胜率的变量。三个人能把模式分和 co-sign 都做透，一个人大概率只能做透一个。

---

## 附：结论摘要

**这个想法的上限比单人 37 天能做出来的上限高。** 瓶颈不是想法，是执行容量。

- 进前 10（路演资格）：可能性不错 —— 最低提交门槛只是一份文档，中位数投稿会很弱
- 拿前 3：取决于评委构成、参赛队数、以及那两三个招牌功能有没有做透

最有效的两件事不是继续打磨设计，而是：**找队友**，以及**砍掉一半功能把剩下的做到无可挑剔**。
