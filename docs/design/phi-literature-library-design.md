# Phi 文献检索与知识库技术方案

## 0. 分层与范围

文献相关能力分两层，边界要严格分开，理由见 [phi-db-connector-technical-design.md §12](phi-db-connector-technical-design.md)：

| 层                                     | 职责                                           | 数据所有权      | 已定义位置                          |
| -------------------------------------- | ---------------------------------------------- | --------------- | ----------------------------------- |
| **检索层**（`lit_search`/`lit_fetch`） | 查外部文献源（PubMed/Europe PMC/预印本），只读 | 第三方          | db-connector 文档 §12，本文档不重复 |
| **知识库层**（本文档，`library` 模块） | 用户自己的文献收藏、笔记、去重、深读产出       | 用户/项目自己的 | 本文档                              |

知识库层**不是**检索层的一个功能开关，是独立子系统——原因见 db-connector 文档 §0.1（连接器只能是只读声明式配置，不能长出本地写状态）。

设计参考了三个真实存在的系统，具体对应关系贯穿全文：[literature-agent](https://github.com/Xin-Jiaqi/literature-agent)（个人文献雷达，MUST/WEEKLY/RADAR/DROP 分级 + A/B/C/D 处理深度 + 三级去重）、[tolaria](https://github.com/refactoringhq/tolaria)（markdown 知识库，files-first/git-first 存储哲学）、[karpathy 的 LLM Wiki gist](https://gist.github.com/karpathy/442a6bf555914893e9891c11519de94f)（Ingest/Query/Lint 三操作模式）。

## 1. 存储位置——项目级，不是全局

```
<project>/.phi/library/
  index.json              # 结构化索引：去重、xref、查询都靠这个，不靠解析 markdown
  papers/<canonical_id>/
    note.md               # 人类可读、可编辑、随项目 git 一起版本化
    meta.json              # 该篇的完整结构化元数据（冗余存一份，index.json 只放查询用的精简字段）
  review-queue.json         # 待复核候选池（见 §4）
  dedup-review.json          # 去重疑难队列（见 §5）
```

`~/.phi/`(全局)只放 connector 层的限流/缓存(db-connector 文档 §8)，不放文献库——文献库是研究项目的产出物，应该跟着项目的 git 仓库走，这是吸收 tolaria "files-first/git-first"（数据属于用户，不属于 app）的直接结果。`index.json` 是机器事实来源，`note.md` 是人类前台，这个分工照抄 literature-agent 的 `literature.db`（机器）+ `_文献包/A.md`（人类）二元结构，不是新发明。

## 2. 数据模型——两条独立轴，不是单一"已保存"标志

```typescript
interface SavedPaper {
  canonicalId: string // 见 §5，DOI 优先，否则 source+sourceId
  source: string // 'ncbi' | 'europepmc' | 'preprint' | ...
  title: string
  authors: string[]
  abstract?: string
  doi?: string

  priorityTier: 'must' | 'weekly' | 'radar' | 'drop' // 推荐轴——多值得看
  processingStage: 'discovered' | 'skimmed' | 'deep_read' | 'synthesized' // 处理轴——处理到哪一步

  tags: string[] // 用户自己管理，agent 不自动写（§7）
  notes?: string
  collectionId?: string

  provenance: 'manual' | 'auto' // 用户主动收藏 vs agent 自动推入候选池
  xrefs: { targetId: string; relation: string }[] // 联动的相关论文/领域实体，见 §8

  savedAt: string
  fullTextStatus: 'available' | 'unavailable' | 'not_attempted' // 见 §6，禁止伪造
}
```

两条轴独立，理由见 literature-agent README："`MUST/WEEKLY/RADAR/DROP`（推荐轴）与 `A/B/C/D`（阅读轴）是两条独立维度"——一篇 `must` 级别的论文完全可以还停在 `discovered` 阶段没来得及深读，一篇 `radar` 级别的论文也可能因为用户个人兴趣被深读到 `synthesized`。

## 3. 三层管道——候选池 → 用户复核前台 → 正式入库

这是本方案里最关键的一条边界，直接照搬 literature-agent 的架构角色划分：

```
lit_search 结果 → (自动分级) → review-queue.json（候选池，机器事实来源）
                                      ↓ 用户在复核界面勾选 read/later/ignore
                                lib.save(...)（正式写入 index.json，SavedPaper.provenance='manual'）
```

**硬性边界**：`priorityTier='must'` 的候选可以被 agent 自动推入 `review-queue.json`（这一步是"候选池写入"，approval tier 可以是 `read` 级别，因为候选池不是正式库，随时可清空重建），但 agent **永远不能**自己决定把候选池条目提升为正式 `SavedPaper`——那必须是用户动作触发的 `lib.save` 调用，approval tier 是 `write`。这条边界直接对应 literature-agent 的原则："Python 后台自动到 collect→dedup→screen→…→overview 为止……用户只做最终决定"。

## 4. 工具集

复用 db-connector 文档 §12 已定义的 `lit_search`/`lit_fetch`（`approval: 'read'`），本模块新增：

```typescript
lib.save(candidateId | { source, id }, priorityTier?, collection?)  // approval: 'write'
lib.update(id, { processingStage?, tags?, notes?, collection? })     // approval: 'write'
lib.remove(id)                                                        // approval: 'write'
lib.find(query, { tags?, collection?, processingStage? })              // approval: 'read' —— 查本地收藏，不查外部
lib.list(collection?)                                                   // approval: 'read'
lib.export(format: 'bibtex' | 'ris' | 'csl-json', ids?)                  // approval: 'read'
lib.request_deep_read(id)                                                // approval: 'write'，见 §6
lib.audit()                                                                // approval: 'read'，见 §7
```

命名刻意避开和 `lit_search` 撞脸（`lit_*` 查外部，`lib.*` 查本地收藏），这是从批评 OpenClaw `pubmed-search` vs `pubmed-database` 命名歧义里直接吸取的教训，不是随手起的名字。

`ToolTier` 严格按 Phi SDK 实际定义的 `"read" | "write" | "exec"` 三级标注（已在 `@oh-my-pi/pi-agent-core` 里验证过这个类型存在），不是自造的分级词汇。

## 5. 去重——三级匹配，fail-closed，不是 DOI 单字段匹配

照抄 `la_dedup.py` 的方法论（不抄代码，抄的是分级策略）：

```
exact_match     —— DOI / arXiv ID / 规范化标题完全一致 → 自动合并，不问用户
probable_match  —— 标题模糊相似 + 作者姓重叠 / 措辞改写 / 摘要高重合 → 写入 dedup-review.json，不静默合并
manual_review   —— 同名不同文 / 勘误-评论-原文关系 / 系列标题尾缀 / 缩写与全称 → 写入 dedup-review.json
```

标题规范化要处理 Unicode NFKC、LaTeX 数学符号/希腊字母、HTML 实体、破折号族——因为 arXiv 预印本和期刊发表版标题常有排版级差异，纯字符串相等判断会漏掉真实重复。**DOI 不是唯一判据**，只是 `exact_match` 里最强的一种；预印本往往还没 DOI，这时退化到规范化标题精确匹配，仍然是 `exact_match` 级别，只是判据换了字段。

`probable_match`/`manual_review` 永远不自动合并——宁可让用户在 `dedup-review.json` 里多看一眼，不猜。这是 fail-closed 原则，照抄 literature-agent："查重/查询失败时不创建条目，进入退避重试"。

## 6. 深读任务——排队 + 结构校验，不是一次性工具调用直接写入正式笔记

"深读全文并写结构化笔记"是一个足够重的任务，不该是模型一次工具调用就把结果直接标记为最终版本。照抄 literature-agent 的 A-job/`a-complete` 模式：

1. `lib.request_deep_read(id)` 生成一个任务，状态是 `pending`
2. agent（或后续对话里的 agent）完成深读，调用 `lib.update(id, { processingStage: 'synthesized', notes: <结构化笔记> })`
3. 写入前**校验笔记是否符合最低结构要求**（比如强制包含"研究问题/方法/关键结果/局限性"这几个字段），不符合就拒绝写入并提示补全，不是"模型写什么就存什么"

`fullTextStatus` 字段在这一步至关重要：如果全文拿不到（付费墙、无授权），`lib.request_deep_read` 必须让模型知道这一点并如实反映在笔记里，**禁止**模型只凭摘要编一段假装读过全文的笔记——这是 literature-agent"获取失败如实标注，不伪造"原则的直接应用，也是防止幻觉的具体机制，不是一句空洞的提醒。

## 7. 审计/Lint——常驻能力，不只是写入时校验一次

`lib.audit()` 做的事，同时对应 literature-agent 的 `la_audit.py`（18 项一致性检查）和 karpathy gist 里的 Lint 操作（健康检查矛盾、过期结论、孤立页面、缺失交叉引用）——两个独立来源收敛到同一个结论，说明这不是可选项：

- 唯一性：同一 `canonicalId` 只能有一条 `SavedPaper`（照抄 `canonical_a_unique` 的思路）
- 孤立引用：`xrefs` 指向的 `targetId` 是否还存在
- 陈旧候选：`review-queue.json` 里长期未处理的候选（超过阈值时间未被用户决定 read/later/ignore）
- `dedup-review.json` 积压：长期未处理的疑难去重项

建议接入 §9 分阶段计划的 Phase 2，不是 v1 必须项，但要在架构里留好这个工具位置，不要等到库里脏数据一大堆才想起来补。

## 8. 联动更新——Ingest 不是孤立写入

吸收 karpathy gist 的"Ingest 处理新来源时联动更新 10~15 篇相关页面"这条：`lib.save` 成功后，如果新论文的 `xrefs` 指向已有的 `SavedPaper`（比如同一个基因/同一个研究问题），应该在那条已有记录的 `xrefs` 里补一条反向引用，不是只在新记录里单向记一次。这个联动逻辑放在 `library-store.ts` 内部的写入路径里，对模型不可见，模型只调用 `lib.save`，联动是存储层自己的职责。

## 9. 目录结构（代码，镜像 session/notebook 而不是 db-connector）

```
src/main/agent/library/
  library-types.ts        # SavedPaper 等类型定义
  library-store.ts         # 读写 <project>/.phi/library/*.json，对齐 session-store.ts 的文件读写方式
  note-sync.ts               # index.json ⇄ papers/<id>/note.md 双向同步（结构化字段 ⇄ YAML frontmatter）
  dedup.ts                    # 三级匹配逻辑（§5）
  review-pipeline.ts           # 候选池写入、复核状态流转（§3）
  deep-read-jobs.ts             # 任务队列 + 结构校验（§6）
  audit.ts                       # lib.audit() 实现（§7）
  export.ts                       # BibTeX/RIS/CSL-JSON
  library-tools.ts                 # 四个工具的 CustomTool 注册
```

不放进 `src/main/agent/db/`——数据所有权不同（§0），也不挂 `plugins.ts` 的通用插件体系，理由和 db-connector 文档 §0.1 完全一致（写操作 + 结构校验这类逻辑不该是任意代码可以绕过的）。

## 10. 分阶段落地计划

**Phase 0**：`library-types.ts` + `library-store.ts`（JSON 读写，项目级路径）+ `lib.save`/`lib.list`/`lib.find`/`lib.remove` 最小实现，`processingStage` 先只支持 `discovered`/`skimmed`，`priorityTier` 先手动指定（不做自动分级）。dedup 先只做 `exact_match`（DOI/规范化标题）。

**Phase 1**：三层管道上线（`review-pipeline.ts`，候选池 + 复核前台），`dedup.ts` 补齐 `probable_match`/`manual_review` 两级，`note-sync.ts` 打通 markdown 笔记双向同步。

**Phase 2**：深读任务队列 + 结构校验（`deep-read-jobs.ts`）、审计工具（`audit.ts`）、xref 联动更新（§8）。

**Phase 3**：导出格式补全、跨项目文献库检索（如果确认有需求——默认库是项目级，跨项目检索不是 v1 假设）。

## 11. 测试计划

对齐仓库 `tests/agent-*.test.ts` 组织方式：

- `dedup.ts` 三级匹配的边界用例（DOI 相同标题不同、标题相同 DOI 缺失、LaTeX/Unicode 标题变体、系列标题尾缀）——直接参考 `la_dedup.py` 暴露的这几类真实边界情况来设计测试输入，不要自己凭空造测试数据。
- `review-pipeline.ts`：候选池写入 approval tier 是 `read`、正式入库 approval tier 是 `write` 这条边界要有测试锁住，防止后续改动误把两者混同。
- `deep-read-jobs.ts`：笔记结构校验的拒绝路径（缺字段应该拒绝写入，不是警告后照样写入）。
- `audit.ts`：人为构造脏数据（孤立 xref、重复 canonicalId）验证能检测到。

## 12. 与其他子系统的边界

- 不依赖、不修改 `db-connector`/`wrappers` 本身，`lit_search`/`lit_fetch` 是 library 的唯一外部数据入口，library 自己不直接打外部 API。
- `note.md` 的 YAML frontmatter 字段集合要和 `SavedPaper` 类型保持同步，但**不**反过来要求 `index.json` 从 markdown 解析——`index.json` 永远是权威来源，`note.md` 是投影，这条方向不能反，否则会重新引入"手写文档和真实状态漂移"的老问题（db-connector 文档 §11.1 已经踩过这个坑）。
