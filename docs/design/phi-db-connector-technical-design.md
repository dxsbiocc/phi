# Phi 数据库连接器（DB Connector）技术方案

## 0. 架构结论

科研辅助智能体需要接入几十到上百个生物医学数据库/公共 API（NCBI、UniProt、cBioPortal、Ensembl、PDB、KEGG 等），但不能把每个数据库都做成一个独立 skill、一个独立 MCP server、或一个可执行 plugin。那三种做法都会让工具面、权限面和维护面随数据库数量线性膨胀。

**统一结论：DB Connector 是 Phi 内置模块；connector 是声明式资源；skill 是导航层；MCP 是可选出口。**

| 层         | 形式                            | 责任                                                                              |
| ---------- | ------------------------------- | --------------------------------------------------------------------------------- |
| 核心运行时 | 内置模块 `src/main/agent/db/`   | manifest 校验、catalog、adapter、认证、限流、缓存、审计、安全策略、agent 工具执行 |
| 数据库定义 | 声明式 `connector.yaml`         | 描述 source/domain/字段/协议族/限流/认证引用；不能执行代码                        |
| Agent 导航 | 自动生成的 `db-navigator` skill | 告诉模型“什么问题查哪个库/哪个 domain”；不负责网络请求或认证                      |
| 外部互操作 | 可选的单个 `phi-db` MCP facade  | 让其他客户端复用 Phi DB 能力；消费同一套内置模块，不重新实现连接逻辑              |

一句话记忆：**内置模块是骨架，connector.yaml 是扩展点，skill 是地图，MCP 是出口。**

### 0.1 为什么不是通用 plugin

`src/main/agent/plugins.ts` 的通用 plugin 体系面向可执行扩展代码。DB connector 不应走这条路，即使用户体验上可以像“安装一个数据源”：

- 数据库 connector 的核心安全前提是：第三方只提交声明式配置，不能运行任意代码。
- 如果 connector 是 npm/plugin，它可以绕开统一的 baseUrl 校验、认证脱敏、限流、审计和工具数量控制。
- 通用 plugin 可以注册任意工具 schema，会让“每个数据库一套工具”的反模式从后门长回来。

正确边界是：Phi 可以提供插件式安装体验，但底层只安装受约束的 `connector.yaml`，由 Phi 内置 adapter 解释执行。

### 0.2 为什么不是纯 skill

Skill 适合承载领域导航知识，不适合承担真实数据库访问。纯 skill 会把认证、缓存、错误处理、字段 schema、限流和安全策略重新交给模型临场拼 API 请求，这正是本方案要避免的。

`db-navigator` 只能回答“去哪里查、用哪个 domain、常见问题怎么串联”，实际执行必须走 `db_*` 内置工具。

### 0.3 为什么不是每库一个 MCP

MCP 适合跨应用互操作，不适合作为 Phi 内部第一形态。每个数据库一个 MCP 会带来 N 倍进程/协议/配置/权限开销。未来如果要给外部客户端开放能力，应做一个单独的 `phi-db` MCP facade，把 `db_search`、`db_domain`、`db_query`、`db_docs_search` 暴露出去；这个 facade 仍然调用 `src/main/agent/db/`，不是第二套实现。

### 0.4 Roadmap 状态

`docs/roadmap/internal-beta-implementation.md` 当前没有 DB Connector 的正式 beta 里程碑。DB Connector 不应顺手混入 internal beta 的 session、approval、wrapper、notebook 主线；当前允许的实现范围是 core-only 打样、测试，以及默认注册但可显式关闭的 experimental agent-tool。进入产品化前，应先作为明确的后续 milestone 加入 roadmap。

## 1. 四条正交设计轴

这些轴必须分开建模，不能混用一个 `tier` 字段表达所有含义。

| 轴       | 字段/来源              | 作用                               | 示例                                                      |
| -------- | ---------------------- | ---------------------------------- | --------------------------------------------------------- |
| 学科分类 | 生成到 skill           | 帮模型按问题找到相关 source/domain | 序列/基因组、蛋白/结构、变异/临床、通路/功能              |
| 协议族   | `protocolFamily`       | 决定 adapter 代码量                | `entrez`、`rest-json`、`sparql`、`ontology`、`bulk-index` |
| 信任来源 | `.source.json` sidecar | 决定默认可见性和是否可执行         | `bundled`、`custom`，未来可扩展到 signed/verified         |
| 策展等级 | `curationTier`         | 决定字段词典、xref、测试投入       | `curated`、`generic`                                      |

### 1.1 协议族

| 协议族         | 覆盖示例                                                                             | 说明                                                      |
| -------------- | ------------------------------------------------------------------------------------ | --------------------------------------------------------- |
| `entrez`       | NCBI Gene/Protein/PubMed/dbSNP/dbVar/SRA/Taxonomy/ClinVar                            | 一个 adapter，靠 `db=` / domain 参数区分子库              |
| `rest-json`    | cBioPortal、STRING、PubChem PUG-REST、PDBe、Ensembl REST、Reactome、GDC、ChEMBL、HPA | 通用 REST + JSON，connector 负责声明 URL、参数和字段映射  |
| `sparql`       | UniProt SPARQL、WikiPathways SPARQL                                                  | 支持结构化查询，也保留受限 `rawQuery` 逃生舱              |
| `ontology`     | GO、HPO、Disease Ontology、MeSH                                                      | term、synonym、parent/child、xref 结构统一                |
| `bulk-index`   | GEO 部分元数据、KEGG 纯文本、参考基因组索引                                          | 无稳定实时 API，走本地预索引                              |
| `generic-http` | 长尾简单 HTTP API                                                                    | 仅允许声明 URL 模板和 JSONPath/字段映射；不做协议智能处理 |

`generic-http` 是长尾兜底，不是任意 HTTP 客户端。它必须继承 §9 的网络策略、重定向检查、大小限制、超时和认证脱敏。

### 1.2 信任来源与策展等级

`trustTier` 不属于 manifest 自报字段，必须由安装来源 sidecar 决定：

- `bundled`：随 Phi 发布，允许进入默认 agent 工具能力面。
- `custom`：用户本地安装，默认只可被发现，不可被 `db_query` 执行，除非用户显式允许该 connector。

`curationTier` 属于 manifest：

- `curated`：人工维护字段词典、常见问法、xref、测试覆盖，适合 Tier 1 source。
- `generic`：只提供最小连接配置和 domain 摘要，字段可缺省，依赖 `db_docs_search` / `rawQuery` 兜底。

这样可以表达“官方内置但只是 generic”或“用户自装但字段很完整”这类真实状态，而不会把安全信任和内容质量混在一起。

## 2. 目录结构

```
resources/db-connectors/                     # bundled，只读，随应用发布
  entrez/ncbi/connector.yaml
  rest-json/cbioportal/connector.yaml
  rest-json/ensembl/connector.yaml
  sparql/uniprot/connector.yaml
  ontology/go/connector.yaml

~/.phi/db-connectors/installed/              # custom，用户安装
  <family>/<id>/connector.yaml
  <family>/<id>/.source.json

src/main/agent/db/
  manifest-types.ts       # ConnectorManifest 类型
  manifest.ts             # connector.yaml 解析 + 校验
  catalog.ts              # bundled + custom 发现
  store.ts                # 安装目录、缓存目录、允许列表
  adapters/
    types.ts
    entrez-adapter.ts
    rest-json-adapter.ts
    sparql-adapter.ts
    ontology-adapter.ts
    bulk-index-adapter.ts
    generic-http-adapter.ts
  policy.ts               # 网络策略、egress transport、限流、缓存、重试、审计
  result-writer.ts        # 小结果内联，大结果写入 session artifact/tool-output
  tools.ts                # db_search / db_domain / db_query / db_docs_search
  docs-generator.ts       # 生成 db-navigator/SKILL.md 与 field-glossary.md
  xref.ts                 # curated source 的跨库引用规则
  docs/
    field-glossary.md     # 可选构建产物；运行时生成产物写入 ~/.phi/db-connectors/docs/

src/shared/dbConnectorTypes.ts               # renderer 可复用的共享类型
```

这套形态复用 wrapper 系统已经验证过的模式：manifest + catalog + installed store + 来源 sidecar。等 wrapper 和 DB connector 都跑稳后，如果出现第三类同构资源，再考虑抽一个共享内部资源框架；现在不要提前抽象。

## 3. Manifest 格式

`connector.yaml` 只能描述数据源，不承载可执行代码，也不声明自己的信任等级。

```yaml
phiDbConnectorVersion: 1
id: entrez/ncbi
name: NCBI Entrez
protocolFamily: entrez
curationTier: curated
baseUrl: https://eutils.ncbi.nlm.nih.gov/entrez/eutils
networkPolicy:
  allowedHosts: [eutils.ncbi.nlm.nih.gov]
  allowRedirects: false
auth:
  type: api_key_query_param
  envVar: NCBI_API_KEY
  paramName: api_key
rateLimit:
  withAuth: { requestsPerSecond: 10 }
  withoutAuth: { requestsPerSecond: 3 }
retryPolicy:
  maxAttempts: 3
  baseDelayMs: 500
  maxDelayMs: 5000
domains:
  - id: gene
    dbParam: gene
    summary: 基因基本信息、位置、别名
    commonFields: [uid, symbol, description, chromosome, aliases]
    fields:
      - name: symbol
        type: string
        description: 官方基因符号
        synonyms: [gene_symbol, hgnc_symbol]
        namespace: hgnc.symbol
  - id: pubmed
    dbParam: pubmed
    summary: 文献摘要与元数据
    commonFields: [uid, title, authors, abstract, pubdate]
  - id: clinvar
    dbParam: clinvar
    summary: 变异临床意义注释
    commonFields: [variation_id, clinical_significance, gene]
xref:
  - from:
      domain: gene
      field: symbol
      namespace: hgnc.symbol
      species: '9606'
    to:
      database: sparql/uniprot
      domain: protein
      field: gene_name
      namespace: uniprot.gene_name
```

校验规则：

- 一次性收集所有 manifest 错误，不在第一个错误处中断。
- `id` 必须是 `<protocol-family>/<short-id>`，并与目录位置一致。
- `protocolFamily` 必须属于已注册 adapter。
- `curationTier` 必须是 `curated` 或 `generic`。
- `trustTier`、`installedAt`、`sourcePath` 只能来自 `.source.json`，manifest 中出现这些字段应报错或忽略并告警。
- `auth.envVar` 只能引用环境变量名；manifest 不能内嵌 secret。
- `baseUrl` 与 `networkPolicy.allowedHosts` 必须可静态校验。
- `connector.yaml` 不能声明 VPN、代理或本机网络出口。出口选择属于 Phi 运行时/用户环境策略，不属于第三方数据源描述。
- `retryPolicy` 可选；缺省由 `policy.ts` 提供保守默认值。
- `protocolFamily: rest-json` 的每个 domain 必须声明 `rest.request`；Phase 1 只允许声明式 GET 映射，不允许 connector 携带可执行脚本。`request.path` 支持 `{filter:<field>}`、`{rawQuery}`、`{limit}`、`{cursor}` 模板；未被模板消费的 filters 按 `filterParamMap` 或字段名写入 query string。`response.rowsPath` / `totalRowsPath` / `nextCursorPath` / `fieldMap` 用点路径从 JSON 响应中提取结构化 rows。
- `protocolFamily: sparql` 的每个 domain 必须声明 `sparql.query`。Phase 1 只支持只读 `SELECT` 查询模板，支持 `{filter:<field>}` 字符串模板；adapter 会统一追加/覆盖 `LIMIT` 和 `OFFSET`，避免 rawQuery 绕过结果大小治理。

## 4. Adapter 接口

Adapter 按协议族实现。具体 connector 只是 adapter + manifest 的参数化实例，不新增 TypeScript 代码。

```typescript
export interface DomainSummary {
  id: string
  summary: string
  commonFields: string[]
}

export interface FieldSchema {
  name: string
  type: 'string' | 'number' | 'boolean' | 'date' | 'object' | 'array'
  description?: string
  synonyms?: string[]
  namespace?: string
  nullable?: boolean
}

export type FilterOp = '=' | '!=' | '>' | '<' | '>=' | '<=' | 'in' | 'between' | 'like' | 'is_null'

export interface Filter {
  field: string
  op: FilterOp
  value?: unknown
}

export interface DbQueryParams {
  domain: string
  filters?: Filter[]
  fields?: string[]
  limit: number
  cursor?: string
  rawQuery?: string
}

export interface DbAdapterQueryResult {
  rows: Record<string, unknown>[]
  totalRows?: number
  truncated: boolean
  nextCursor?: string
  provenance: {
    database: string
    domain: string
    retrievedAt: string
    sourceVersion?: string
    citations?: string[]
    rawQueryUsed?: boolean
  }
}

export interface DbAdapter {
  listDomains(): Promise<DomainSummary[]>
  describeDomain(domain: string): Promise<FieldSchema[]>
  query(params: DbQueryParams): Promise<DbAdapterQueryResult>
}
```

`filters` 是 portable DSL，只覆盖常见查表用例。复杂查询允许用 `rawQuery`，但 `rawQuery` 仍受 §9 的限流、超时、大小、host、custom 允许列表和审计约束。

Phase 1 的 `rest-json-adapter.ts` 已接入同一 Adapter 接口和 `policy.ts`。它只负责声明式 GET JSON 查询：路径模板、query 参数、JSON rows 路径、可选字段映射和字段投影；不支持 connector 自定义代码、POST mutation、任意脚本解析或绕过 host allow-list。当前 bundled 打样是 `rest-json/ensembl`，用 Ensembl REST 的 human symbol lookup / xrefs symbol 端点验证通用路径。

Phase 1 的 `sparql-adapter.ts` 也接入同一 Adapter 接口和 `policy.ts`。它通过 GET 向 SPARQL endpoint 发送 `query` 和 `format=json`，解析 SPARQL JSON results binding 为结构化 rows。当前 bundled 打样是 `sparql/uniprot`，用 UniProt SPARQL 的 human gene-name protein lookup 验证通用路径；普通测试继续使用 mock response，不依赖公网。

## 5. 结果返回协议

DB 查询结果必须**结构化优先**。不要把数据库响应作为一大段自然语言或原始 JSON 文本直接交给 agent。Adapter 返回结构化 rows，`tools.ts` / `result-writer.ts` 再决定哪些内容内联、哪些内容落盘、哪些内容摘要化。

### 5.1 小结果内联

当结果同时满足以下条件时，`db_query` 可以把完整 rows 放进工具结果：

- 行数不超过 25 行。
- 序列化后不超过约 20KB。
- 字段值不包含超长文本、序列、全文、base64、HTML 或大数组。

小结果的 tool result 仍然是结构化对象，至少包含：

```typescript
{
  kind: 'db_query_result'
  mode: 'inline'
  summary: DbResultSummary
  rows: Array<Record<string, unknown>>
  provenance: DbQueryProvenance
  resolvedQuery?: DbResolvedQuery
}
```

### 5.2 大结果落盘

超过内联阈值时，完整结果必须写入文件，agent 只拿摘要、样本和路径引用。

优先写入当前 Phi session 的 `artifacts/` 或 `tool-outputs/`，对齐 internal beta roadmap 里的“大输出写入 tool-outputs 或 artifacts 并在 timeline 引用”规则。若执行上下文暂时拿不到 session id，才退回 `~/.phi/db-connectors/results/`，并在后续 UI 集成时迁回 session 级 artifact。

落盘格式：

- **必选 JSONL**：每行一条标准化 row，适合嵌套字段和流式写入。
- **可选 CSV**：仅当 rows 是扁平标量表时额外生成，方便用户打开。
- **必选 metadata JSON**：记录 summary、provenance、`resolvedQuery`、字段 schema、数据 artifact 列表和 hash。

大结果 tool result 形态：

```typescript
{
  kind: 'db_query_result'
  mode: 'artifact'
  summary: DbResultSummary
  sampleRows: Record<string, unknown>[] // 默认最多 5 行
  artifact: {
    kind: 'db_query_result'
    path: string
    format: 'jsonl'
    bytes: number
    rowCount?: number
    sha256?: string
  }
  artifacts: DbQueryArtifact[] // JSONL + metadata JSON + optional CSV
  metadataArtifact: DbQueryArtifact
  csvArtifact?: DbQueryArtifact
  outputPath: string
  outputArtifact: { kind: 'tool_output'; path: string; bytes: number }
  provenance: DbQueryProvenance
  resolvedQuery?: DbResolvedQuery
}
```

`resolvedQuery` 是 tool 层的查询回执，记录最终使用的 `database/domain`、是否自动推断、目标选择来源、谓词来源、输入 query/term/keyword、最终 `filters/rawQuery/fields` 和简短 reasons。它和 adapter `provenance` 分开：前者说明“为什么这样查”，后者说明“数据从哪里来、如何取回”。`artifact` 是主 JSONL 数据；`artifacts` 返回完整落盘集合；`metadataArtifact` 指向包含 `summary`、`provenance`、`resolvedQuery`、字段 schema 和数据 artifact 列表的 metadata JSON；`csvArtifact` 仅在 rows 是扁平标量表时出现。`outputPath` / `outputArtifact` 用来复用现有工具输出 UI，后续可以接专门的数据表预览器。

### 5.3 摘要而不是全量上下文

大结果必须生成结构化摘要，默认控制在几 KB 内。摘要至少包含：

- `rowCount` / `returnedRows` / `truncated` / `nextCursor`。
- 字段列表、字段类型、缺失率或 nullable 线索（能廉价获得时）。
- 最多 5 行代表性样本。
- 数值字段的 min/max，低基数字段的 top values（只在不额外放大请求成本时生成）。
- 命中条件、排序/分页说明、provenance、warnings。
- 如果结果被写入文件，明确告诉 agent “完整数据在 artifact，不要要求重新查询只为看全量内容”。

摘要生成不能触发昂贵二次请求。它只能基于当前响应、adapter 已有 metadata 或本地落盘文件的轻量扫描。

### 5.4 错误与空结果

错误也必须结构化返回，不要把上游原始错误全文直接交给 agent，尤其不能包含 URL query secret、headers 或环境变量值。`db_query` 的错误详情使用共享类型：

```typescript
interface DbQueryToolErrorDetails {
  kind: 'db_query_error'
  code: DbQueryToolErrorCode
  message: string
  retryable: boolean
  attempts?: number
  status?: number
  lastStatus?: number
  nextSuggestedWaitMs?: number
  safeDetails?: {
    redactedUrl?: string
    transportName?: string
  }
}
```

内置错误码至少包括 tool 层的 `connector_not_found`、`connector_not_enabled`、`invalid_query`、`adapter_missing`、`query_failed`，以及 policy 层的 `DB_PROXY_UNAVAILABLE`、`DB_POLICY_BLOCKED`、`DB_HTTP_STATUS`、`DB_REQUEST_FAILED`、`DB_REQUEST_CANCELLED`、`DB_RESPONSE_TOO_LARGE`、`DB_RETRIES_EXHAUSTED`。`safeDetails` 只能放脱敏 URL、transport 名称等可展示信息。

空结果不是错误。返回 `rowCount: 0`、查询条件摘要、可选的字段建议和下一步建议。

## 6. Agent 工具

只注册四个 DB 相关工具，全部由内置模块提供，默认 `approval: 'read'`。不要按数据库动态生成工具。

### `db_search`

搜索或列出已安装 connector 与 domain。空查询表示列出全部；可按 category、protocolFamily、trustTier、curationTier 过滤。

返回字段至少包括：`id`、`name`、`protocolFamily`、`trustTier`、`curationTier`、`enabledForQuery`、`domains` 摘要。

### `db_domain`

返回某个 database/domain 的字段详情、同义词、namespace、常见过滤方式和引用说明。

### `db_query`

执行结构化查询。参数：

```typescript
{
  database?: string
  domain?: string
  query?: string
  term?: string
  keyword?: string
  filters?: Filter[]
  fields?: string[]
  limit?: number
  cursor?: string
  rawQuery?: string
}
```

约束：

- `database/domain` 可以显式提供；如果缺省，tool 层会用 `query` / `term` / `keyword` 做轻量意图推断，覆盖 NCBI Gene、PubMed、ClinVar、Ensembl symbol lookup、UniProt protein lookup 等内置 connector 的常见入口。
- 意图推断只负责选择 installed catalog 中已启用的 connector/domain，并把基因符号、PubMed 文本检索、UniProt gene_name 等转换成 `filters` 或 `rawQuery`；它不绕过 allow-list、policy、limit、审计或 adapter 校验。
- 自动推断和显式参数都会写入 `resolvedQuery`，让 agent 能检查最终命中的 database/domain、谓词形式和选择原因。
- `filters` 与 `rawQuery` 二选一；同时传入时报错。
- `limit` 默认 50，最大 500。
- 每次执行重新读取 catalog 和 allow-list，不依赖启动时快照。
- custom connector 未显式允许时拒绝执行，但仍可被 `db_search` / `db_domain` 发现。
- 结果必须遵守 §5：小结果结构化内联，大结果写入文件并只向 agent 返回摘要、样本和 artifact 引用。
- 结果必须携带 provenance，便于用户判断来源和时间。

### `db_docs_search`

检索自动生成的字段词典和 curated source 的说明文本。用于长尾字段、同义词、domain 描述和使用提示。

Phase 0 先基于已安装 connector manifest 构建结构化离线候选，不新增依赖，也不做网络访问。返回结果包含 `kind`、`database`、`domain`、`field`、`score`、`matchReasons` 和 `snippet`，覆盖 database/domain/field/xref 四类说明。后续如果生成 `field-glossary.md`，可以把 markdown 段落作为额外候选接入同一个排序和过滤接口。

### 动态 catalog 与工具 schema

工具 JSON schema 不写死所有 database/domain enum。原因是 custom connector 可在运行后安装，枚举会过期。发现能力放在 `db_search`，执行时由 `db_query` 重新校验 catalog。

## 7. Skill 自动生成

生成单份 `db-navigator/SKILL.md`，只做导航，不做执行：

```markdown
### 数据库类别索引

| 类别        | 覆盖源                         | 说明 |
| ----------- | ------------------------------ | ---- |
| 序列/基因组 | entrez/ncbi, rest-json/ensembl | ...  |
| 蛋白质/结构 | sparql/uniprot, rest-json/pdbe | ...  |

### 常见问法对照（curated only）

- "某基因的表达量" -> 先 db_search 找 gene/expression domain，再 db_domain 看字段
- "某突变对应蛋白的功能域" -> 先查变异 domain，再按 xref 查 UniProt/PDB
```

规则：

- 只列 source/domain 级别，不列完整字段表。
- 字段级信息进入生成的 `field-glossary.md`；运行时写入 `~/.phi/db-connectors/docs/field-glossary.md`，由 `db_docs_search` 的同一候选/排序接口检索。
- `generic` source 可以出现在类别索引，但不进入“常见问法对照”。
- bundled connector 的 skill/字段词典可在构建时生成；custom connector 安装后 core 以 best-effort 方式刷新本地生成文档，也可通过显式同步入口重建。
- skill 生成失败不能阻断 `db_search` / `db_query`；Phase 0 暂不接 UI diagnostics，后续产品化时再把失败原因接入资源诊断面。

## 8. Xref 与生物 ID 语义

跨库引用不能只写 `gene.symbol -> uniprot.gene_name`。生物 ID 映射需要显式记录 namespace、species、source version 和是否一对多。

`xref.ts` 的职责：

- 根据 manifest 的 `xref` 声明构建候选跨库路径。
- 标注 namespace，例如 `hgnc.symbol`、`entrez.gene_id`、`ensembl.gene_id`、`uniprot.accession`。
- 保留 species/taxon 约束，默认不要跨物种联想。
- 对一对多映射返回多个候选和 evidence，不替用户静默选一个。

Agent 可以用 xref 建议下一步查询，但不能把 xref 当成确定事实，除非目标数据库返回了明确映射证据。

## 9. 网络、安全与治理

DB connector 是外部网络调用入口，安全策略必须在内置模块集中实现。

### 9.1 基础策略

- 默认只允许 `https:`。
- custom connector 默认禁止访问 localhost、link-local、private IP、metadata IP 和 Unix socket。
- 如需本地开发 connector，必须有单独的 dev-mode 允许开关，不能和普通 custom 安装混用。
- 重定向默认关闭；如果允许重定向，每一跳都要重新做 host/IP 校验。
- `allowedHosts` 必须和 `baseUrl` 匹配，不能用过宽通配。
- 请求超时、响应字节上限、最大分页次数必须有全局默认值。
- 所有日志、审计、错误消息都必须脱敏 auth header、query secret 和 env var 值。

`policy.ts` 不负责建立 VPN 隧道，也不让 connector 选择 VPN。正确边界是：

- 系统 VPN 已启用时，默认 `system` transport 自然走系统网络栈。
- 如果 Phi 以后提供受控代理、企业网关或“只走内网出口”的能力，应实现为 app 级 `DbEgressTransport` provider，并由 Phi 配置选择。
- 默认代理模式是应用级通用设置 `defaultProxyMode: auto | enabled | disabled`，存放在 Phi settings 中；`auto` 由运行时按可用 transport 和网络策略选择，`enabled` / `disabled` 是用户显式偏好。
- Phase 0 / internal beta 不在 DB connector 设置里提供手填代理地址输入框；代理地址发现、凭据和可用性检测属于 app 级 transport provider 或企业运行时配置。设置 UI 只展示单选模式、当前可用性和不可用时的可解释错误。
- adapter 只调用 `policy.ts` 的请求执行器；`policy.ts` 在发出请求前统一做 URL、host、auth、timeout、重试和脱敏。
- custom connector 的 manifest 不能要求特定 VPN/代理，否则它可以诱导用户把请求送到不应信任的出口。

### 9.2 Custom 允许列表

`db_search` / `db_domain` 可以展示 custom connector，并标注 `enabledForQuery: false`。`db_query` 执行前必须检查 allow-list；未允许时返回可解释错误，让 UI 引导用户启用该 connector。

允许列表应存放在 `~/.phi/db-connectors/` 下，由 connector id + digest 绑定。connector 文件变更后，旧允许不应自动适用。

### 9.3 限流、缓存、批量化

- 每个 connector 一个独立令牌桶。
- 认证与未认证可以有不同速率。
- 短期响应缓存键至少包括 connector digest、domain、filters/rawQuery、fields、limit 和 cursor。
- Adapter 可批量合并同一轮内的单条请求，尤其是 Entrez `efetch`。
- 缓存不能绕过 allow-list；custom 被禁用后不能继续读取其缓存结果。

Phase 0 已在 `policy.ts` 落地轻量版本：同一进程内按 connector + auth/anon 速率做请求间隔控制；幂等 GET 响应使用短 TTL 内存缓存，缓存键基于真实请求 URL、method、body 和 headers digest 的哈希，避免把 secret 写入日志但也避免不同 token 串缓存；成功、失败和 cache hit 都追加到 `~/.phi/db-connectors/audit.jsonl`。这不是持久缓存，也不跨进程共享；后续如果要支持长 TTL、本地索引或跨 session 复用，需要先加 digest 绑定、allow-list 再校验和缓存清理策略。

### 9.4 失败重试

访问失败需要重试，但只能做**有限、可解释、尊重上游限流**的重试，不能无限等待或把真实错误吞掉。

默认策略：

- `policy.ts` 统一实现重试；adapter 不各自手写重试循环。
- `policy.ts` 统一持有 HTTP 执行入口；adapter 不直接调用全局 `fetch`。
- 默认最多 3 次尝试，总耗时受全局 timeout / `AbortSignal` 控制。
- 使用指数退避 + jitter，例如 500ms、1s、2s，上限 5s。
- 遇到 `Retry-After` 或上游 rate-limit header 时优先尊重该值，但不能超过全局最大等待。
- 只对瞬时失败重试：网络连接中断、请求超时、HTTP 408、429、500、502、503、504。
- 不重试确定性失败：400、401、403、404、409、413、422、字段校验失败、manifest 校验失败、custom connector 未启用、host/IP policy 阻断。
- 对非幂等请求默认不重试。DB connector 的查询应尽量使用 GET 或只读 POST；如果某协议必须 POST，adapter 需要标记该请求是否幂等。
- 用户取消、session 停止、app 退出时必须立即中断等待和后续重试。

结果与错误需要记录重试信息：

- 成功结果 provenance 记录 `attempts`、是否发生 retry、最后一次状态码。
- 失败结果返回结构化 `retryable`、`attempts`、`lastStatus`、`nextSuggestedWaitMs`（如果有）。
- 审计日志记录重试次数和原因，但不能记录 secret、完整 header 或未脱敏 URL。

### 9.5 `rawQuery` 约束

`rawQuery` 是逃生舱，不是无限权限：

- 只允许支持 raw syntax 的协议族，例如 `entrez`、`sparql` 和部分 `generic-http`。
- 仍然强制 `limit`、timeout、响应大小、host 校验和审计。
- custom connector 使用 `rawQuery` 时需要更明确的 UI 文案，因为它更接近“让模型发起原生查询”。
- Adapter 应在 provenance 中标记 `rawQueryUsed: true`。

## 10. 文献检索例外

PubMed 可以作为 `entrez/ncbi` 的 `pubmed` domain 通过 `db_query` 使用。但文献检索值得提供独立语义工具，前提是它满足以下条件：

1. 查询是相关性排序的全文/摘要检索，不是普通字段过滤。
2. 真实需求是跨源检索，例如 PubMed + Europe PMC + bioRxiv/medRxiv。
3. 下游动作是文献特有的，例如取全文、导出 BibTeX/RIS、引用信息、去重合并。

工具形态建议为：

```typescript
lit.search(query, filters, sources, limit)
lit.fetch(source, id)
```

`lit.*` 必须建在 connector 之上：PubMed 走 `entrez` adapter，Europe PMC/bioRxiv/medRxiv 走 `rest-json` 或 `generic-http` connector。它只增加文献检索语义和跨源编排，不新增底层 HTTP 客户端。

`gene_search` 这类高频但本质仍是结构化查表的需求不破例，继续走 `db_search` + `db_domain` + `db_query`。

## 11. 分阶段计划

### Phase 0：架构锁定与 NCBI 打样

- 完成本文件作为架构合同；代码实现保持 core-first，只在设置页暴露数据库级查询开关。Agent worker 始终注册 DB Connector core tools，避免 agent 在生物数据库问题上退回 `web_search`/`eval` 并错误宣称没有专用工具；不要提供 app 级 DB Connector 功能总开关。
- 增加 `src/main/agent/db/` skeleton：manifest、catalog、store、policy、adapter types。
- 实现 `entrez-adapter.ts`，只接 `entrez/ncbi` 一个 connector；初版用 `esearch` 找 UID，用 `esummary` 返回可读摘要字段，并对 PubMed 追加 `efetch` XML 摘要正文；更大的全文、序列或批量记录下载仍留给后续扩展。
- 注册四个工具：`db_search`、`db_domain`、`db_query`、`db_docs_search`。
- 实现 `result-writer.ts`：小结果内联，大结果写入 session artifact/tool-output，并返回摘要。
- 生成最小 `db-navigator` 和 `field-glossary.md`。
- 测试覆盖 manifest 校验、catalog 发现、custom allow-list、Entrez filter/rawQuery 转换、大小结果返回协议。

### Phase 1：补齐核心协议与治理

- 增加 `rest-json`，用 cBioPortal 或 Ensembl 打样。（当前已实现声明式 GET JSON adapter，并加入 bundled `rest-json/ensembl` 打样。）
- 增加 `sparql`，用 UniProt 打样。（当前已实现声明式 SELECT adapter，并加入 bundled `sparql/uniprot` 打样。）
- 上线网络策略、失败重试、限流、缓存、审计和 secret redaction。
- UI/IPC 提供 custom connector 安装、查看、允许/禁用动作。
- skill/docs-sync 支持 custom 增量索引。

### Phase 2：策展层与跨库能力

- 增加 `ontology` 和 `bulk-index`。
- 建立 curated source 的字段词典、xref、常见问法。
- 加入 provenance/citation 展示。
- 增加 `lit.search` / `lit.fetch`，但底层复用 connector。

### Phase 3：外部互操作与可观测性

- 可选提供单个 `phi-db` MCP facade。
- 记录 connector 调用统计，用于判断 generic source 是否晋升 curated。
- 监控 skill/token 占用，超阈值时继续分层。

## 12. 测试计划

- **Manifest 单测**：合法/非法 YAML、协议族、curationTier、禁止 trustTier 自报、auth/envVar、allowedHosts。
- **Catalog 单测**：bundled/custom 混合发现，`.source.json` 缺失或损坏，digest 变化导致 allow-list 失效。
- **Policy 单测**：localhost/private IP 阻断、redirect 复检、失败重试/不重试分类、`Retry-After`、取消中断、secret 脱敏、limit/timeout/response size。
- **Adapter 单测**：`filters -> 原生查询` 转换、`rawQuery` 透传限制、分页、truncated。
- **Result-writer 单测**：小结果内联、大结果 JSONL/metadata 落盘、CSV 扁平表导出、summary 大小限制、artifact 引用字段。
- **Tool 集成测试**：四个 `db_*` 工具对 mock adapter 的端到端调用，不打真实外部 API。
- **Docs 契约测试**：`docs-generator.ts` / catalog 同步入口生成的 skill 和字段词典快照稳定。

测试默认不依赖公网。少量真实 API smoke test 可以作为手动或 opt-in job，不能进入普通 CI 必跑链路。

## 13. 与现有系统的边界

- 不改动 `wrappers/` 本身；DB connector 是平行资源类型，只复用其 manifest/catalog/trust-source 设计语言。
- 探索性分析、跨表统计和可视化继续走 notebook 能力；DB connector 只负责发现和只读检索。
- Plugin 页面可以展示“已安装数据源”的入口，但安装结果仍写入 `~/.phi/db-connectors/installed/`，不进入通用 plugin runtime。
- Skills 页面只展示生成的 `db-navigator` 来源和 diagnostics，不让 skill 执行数据库请求。
- MCP 是未来出口，不是当前实现依赖。
