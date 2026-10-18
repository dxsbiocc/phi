# Baker Lab 蛋白质设计技能的执行依据与验收

核对日期：2026-10-18。本轮补齐 RFdiffusion 与 ProteinMPNN 的来源、运行接口、方法证据和验证要求，并在现有环境完成 ProteinMPNN CPU 小样本运行。本文是制作技能的依据，技能封装和完整设计流程尚未实现。

## 当前完成程度

| 项目       | 已取得的证据                                                   | 尚需完成的验收                                              |
| ---------- | -------------------------------------------------------------- | ----------------------------------------------------------- |
| 方法与筛选 | 已核对两篇原论文的相关补充方法、图注及作者代码；按任务记录阈值 | 将所选任务绑定到可运行的脚本与配置，并实际复核              |
| 源码版本   | 两个官方仓库均固定完整 commit，并计算所读源码的 SHA256         | 建立这些版本与论文原始实验版本的对应关系                    |
| 模型资产   | ProteinMPNN 的一个权重和官方输入已下载、计算 SHA256 并运行     | RFdiffusion 权重字节校验与实际加载                          |
| 许可       | 已读两仓库许可；RFdiffusion 明确将 README 下载权重纳入许可范围 | 分发时随附对应声明，分别核对新增资产和依赖的许可            |
| 运行环境   | 实测 Python 3.12.9、PyTorch 2.5.1、NumPy 1.26.4 的 CPU 路径    | 求解完整依赖锁、建立 Phi 管理环境，在干净环境重测           |
| 运行验证   | 一条普通设计、同种子重复、固定位置设计三次均通过检查           | RFdiffusion、结构复核和跨工具衔接；异常输入、取消与资源限制 |
| 科学有效性 | 整理计算基准、实验对照及各指标的解释边界                       | 同预算基准及实验验证；CPU 运行检查不构成这些证据            |

版本、文件哈希和逐次运行结果见 [来源与运行记录](bakerlab-source-audit.json)。这份来源清单不属于依赖锁，也不代表技能已经可安装。

## 论文方法与筛选依据

下表中的数值只适用于各自论文的任务和预测方式。特别是，序列恢复率、预测置信度、结构相似性、实验结合响应分别衡量不同问题。

| 研究与任务                    | 已读设置与判据                                                                                                               | 对照与适用范围                                                                                                        |
| ----------------------------- | ---------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------- |
| RFdiffusion 骨架与基序支架    | 通常每骨架采样 8 条 ProteinMPNN 序列；单序列 AF2；计算成功使用平均 pAE < 5、骨架 RMSD < 2 Å，基序支架另需基序骨架 RMSD < 1 Å | 与 Hallucination、RFjoint Inpainting 比较；对应正文计算基准及 Fig.4，不能代替功能实验                                 |
| RFdiffusion 对称组装体        | 每骨架采样 16 条序列；平均 pLDDT > 80，整体寡聚体骨架 RMSD < 2 Å                                                             | Extended Data Fig.5 的计算判据；部分设计另有 SEC 和电镜证据                                                           |
| RFdiffusion 五靶点结合蛋白    | binder 单体 pLDDT > 80、interaction pAE < 10、binder 单体对设计 RMSD < 1 Å                                                   | Extended Data Fig.8；该筛选实验将 10 μM 时达到阳性对照最大 BLI 响应 50% 作为命中条件，另有后续滴定；该单点响应不是 Kd |
| ProteinMPNN 补充 AF2 基准     | 全部 5 个 AF2 ptm 模型、3 recycles、单序列输入，按平均 pLDDT 选择模型；396 个单体和 277 个同源寡聚体，每骨架 8 条序列        | 补充方法第 6 页及 Fig.S7 第 12 页；S7 使用两档真实 lDDT-Cα 或跨链 PAE 判据，不能外推为所有任务的阈值                  |
| Bennett 2023 前瞻结合蛋白筛选 | AF2 initial guess；AF2 选择组用 pAE_interaction < 10 且 af2_complex_rmsd < 5 Å                                               | 与 Rosetta 指标选择组比较；不同于上一项 RFdiffusion 的单体 RMSD 判据；酵母展示 SC50 也不等于溶液 Kd                   |

原始依据：[RFdiffusion 正文与扩展图](https://pmc.ncbi.nlm.nih.gov/articles/PMC10468394/)、[ProteinMPNN 正文](https://pmc.ncbi.nlm.nih.gov/articles/PMC9997061/)、[ProteinMPNN 官方补充包](https://www.ebi.ac.uk/europepmc/webservices/rest/PMC9997061/supplementaryFiles)、[Bennett 正文和 Methods](https://pmc.ncbi.nlm.nih.gov/articles/PMC10163288/)。

### RFdiffusion 补充方法中的任务配置

已读取 [RFdiffusion 官方补充包](https://www.ebi.ac.uk/europepmc/webservices/rest/PMC10468394/supplementaryFiles) 内 `41586_2023_6415_MOESM1_ESM.pdf` 的相关方法。以下页码均指 PDF 页序；§5.2 位于第 80–81 页，§5.3 位于第 81–82 页，§5.15 位于第 96–98 页。

| 任务                           | ProteinMPNN 采样                               | AF2 复核方式                                                                                              |
| ------------------------------ | ---------------------------------------------- | --------------------------------------------------------------------------------------------------------- |
| 无条件、折叠条件和功能基序支架 | 温度 0.1；文中序列设计通常排除半胱氨酸         | 单序列、model_4_ptm、无模板                                                                               |
| 刚性靶标结合蛋白               | 温度 **0.0001**，不同于本轮 CPU 运行检查的 0.1 | 单序列、model_1_ptm、靶标模板和 initial guess                                                             |
| 环状与二面体对称组装           | 通常温度 0.1                                   | model_4_ptm，链间 residue offset 200，initial guess；其他点群有仅验证子单元的情况，不能统一称为整装配验证 |

§5.15 还记录了两个执行时需要保留的选择：ProteinMPNN-FastRelax 对这些 RFdiffusion 骨架的成功率没有系统性帮助，因此不将其默认设为必需步骤；订购前还人工剔除了仅两条螺旋且没有良好核心堆积的边界案例，单靠数值过滤不能声称完全再现订购队列。同页不同靶标的额外 pAE 截断用于旧文库的回顾比较，不应覆盖成一个通用筛选配置。

ProteinMPNN 补充材料还表明采样设置随分析而变：第 5 页的 T=0.1 对应氨基酸组成偏差分析；Fig.S3 的温度与采样数量用于评分和恢复率研究。它们不能自动成为所有技能的默认值。Fig.S7 中的真实 lDDT-Cα 需要已知参考结构，不能直接用于没有实验结构的全新设计。

### 指标实现需要固定的条件

- pLDDT 记录平均的残基范围，例如 binder、target 或整体；pAE 记录残基对范围，单位为 Å。
- 作者当前 `dl_binder_design` 实现对 binder→target 和 target→binder 的两块 PAE 分别平均，再取平均，属于全部跨链残基对；单体模式可能返回 NaN。它不等于接触残基子集的平均值。[实现](https://github.com/nrbennet/dl_binder_design/blob/main/af2_initial_guess/predict.py)
- RMSD 必须同时保存原子选择、对齐集合和计算集合。作者当前实现中的 `binder_aligned_rmsd` 与 `target_aligned_rmsd` 对齐集合不同，不能仅凭名称当作论文中的 `af2_complex_rmsd`。[实现](https://github.com/nrbennet/dl_binder_design/blob/main/af2_initial_guess/af2_util.py)
- AF2 initial guess 将输入坐标用于首轮 `prev_pos` 初始化，研究还使用 target template；这是带结构条件的复核。记录模型、recycles、模板和 initial-guess 开关，不能称作独立的从序列盲预测。[论文 Methods](https://pmc.ncbi.nlm.nih.gov/articles/PMC10163288/)

上述第三方筛选仓库当前只作实现解释，尚未纳入本轮固定版本和实际运行范围。将其用于执行前，需要固定 commit、权重和具体评分函数；指标缺失、NaN 或对齐集合不明时，结果不能自动通过。

## 源码与模型资产

本轮审计使用当前官方源码快照。它们不是已确认的 2022 或 2023 年论文实验版本。

| 工具        | 固定的源码 commit                          | 本轮选择的资产                                                          |
| ----------- | ------------------------------------------ | ----------------------------------------------------------------------- |
| RFdiffusion | `86507b6538f51fce57b5a72477165f03999ed7ae` | 已校验 README、许可、基础配置、环境文件和推理入口；权重尚未下载         |
| ProteinMPNN | `8907e6671bfbfc92303b5f79c4b5e6ce47cdef57` | 已校验两个推理源码、README、许可、示例脚本、`v_48_020.pt` 与 `5L33.pdb` |

ProteinMPNN 权重 `vanilla_model_weights/v_48_020.pt` 为 6,681,301 字节，实算 SHA256：`c9cb4a671d79604111231f8dbfc7c590e06f1197453b7a6854ac6661a642f5bd`。官方输入 `inputs/PDB_monomers/pdbs/5L33.pdb` 为单链 A，解析长度 106，实算 SHA256：`21eb06c843410732e0b60528b1a99934435ac66822b2a1a3f1d402f363b9e218`。[固定版本资产](https://github.com/dauparas/ProteinMPNN/tree/8907e6671bfbfc92303b5f79c4b5e6ce47cdef57)

RFdiffusion 下一阶段按任务选择 `Base_ckpt.pt`、`Complex_base_ckpt.pt` 或 `ActiveSite_ckpt.pt` 等官方权重，不能混用功能不同的模型。下载地址以固定版本 [README](https://github.com/RosettaCommons/RFdiffusion/blob/86507b6538f51fce57b5a72477165f03999ed7ae/README.md) 为依据；地址中的十六进制目录名不作为已验证 SHA256。取得文件后实算哈希、记录大小并测试实际加载，才闭合模型资产验收。

### 许可依据

RFdiffusion 的 [BSD 许可](https://github.com/RosettaCommons/RFdiffusion/blob/86507b6538f51fce57b5a72477165f03999ed7ae/LICENSE) 明确覆盖源码及 README 所引用下载权重；分发时保留版权、条件和免责声明，并遵守不得擅自使用贡献者名称背书的条款。其随附 NVIDIA SE3Transformer 还带有单独的许可声明。

ProteinMPNN 仓库为 [MIT 许可](https://github.com/dauparas/ProteinMPNN/blob/8907e6671bfbfc92303b5f79c4b5e6ce47cdef57/LICENSE)。已检查的文件未另列独立的权重或训练数据许可声明，不能把仓库许可直接扩展为所有外部数据的许可。推理不需要下载其完整训练集；新增或分发输入数据时逐项记录来源与许可。论文和附件保持原站来源链接，本轮不打包全文。

## 运行环境与 Phi 接口

### 已测环境和待构建环境

ProteinMPNN 已在本机 Darwin arm64、Python 3.12.9、PyTorch 2.5.1、NumPy 1.26.4 的既有环境中走通 CPU 路径，运行时使用一个 OpenMP 线程。没有安装新依赖。该结果只覆盖本次输入、模型与解释器组合，尚无完整依赖闭包、平台锁和干净环境验证。

RFdiffusion 官方 [Conda 配置](https://github.com/RosettaCommons/RFdiffusion/blob/86507b6538f51fce57b5a72477165f03999ed7ae/env/SE3nv.yml) 给出 Python 3.9、PyTorch 1.9、CUDA 11.1 与对应 DGL；[SE3 依赖](https://github.com/RosettaCommons/RFdiffusion/blob/86507b6538f51fce57b5a72477165f03999ed7ae/env/SE3Transformer/requirements.txt) 仍含未固定版本的 Git 来源。官方 Docker 使用另一组版本，也没有由本轮验证的镜像 digest。因此环境文件不能冒充完整锁，两个基线不能拼成一份已测配置。

RFdiffusion 推理入口包含 CPU 回退，并不能据此宣称非 NVIDIA 平台无法运行；本机所查环境缺少 Hydra、DGL 和 SE3Transformer，尚未执行这一路径。下一阶段先选择一个运行后端，锁定依赖或容器 digest，再测 1 个 100 残基的无条件生成案例。该规模属于工程运行检查，不是论文质量基准。

即使无条件生成，当前模型入口也会引用仓库默认示例 `examples/input_pdbs/1qys.pdb`；安装时保留所需资源。模型还会从 checkpoint 恢复配置，记录最终有效配置，不能只保存命令行覆盖值。[模型入口](https://github.com/RosettaCommons/RFdiffusion/blob/86507b6538f51fce57b5a72477165f03999ed7ae/rfdiffusion/inference/model_runners.py)

接入 Phi 时遵循现有 [技能合同](../contracts/skill.md)、[环境合同](../contracts/environment.md) 和 [执行合同](../contracts/execution.md)：带脚本的技能声明管理环境，交付对应平台锁；原生推理程序的日志由封装层收集，脚本工具成功时 stdout 仅返回一个结果 JSON。当前上游 CLI 本身会打印日志，不能直接当作已满足该接口的脚本工具。

### 输入输出与失败条件

以下是拟实施的封装约定，尚未实现为工具。

| 输入或输出 | 执行前检查及验收                                                                                                          |
| ---------- | ------------------------------------------------------------------------------------------------------------------------- |
| 结构与链   | 明确设计链和固定链；标准 ProteinMPNN 输入检查 N、Cα、C、O 坐标；仅 Cα 模式使用匹配权重                                    |
| 固定位点   | 建立原始 `(chain, resSeq, insertion code)` 到解析后链内序号的映射；拒绝 0、负数、越界、未知残基和缺坐标位置               |
| 采样数量   | `num_seq_per_target`、`batch_size` 为正整数，并要求整除或由封装层显式调度；温度列表非空且均为正有限数                     |
| 随机性     | 需要复现时 ProteinMPNN 指定非零 seed，保存实际使用值；RFdiffusion 使用 deterministic 开关及 design_startnum，保存设计编号 |
| 输出目录   | 写入当前项目允许的输出位置，记录来源和父候选；超时或取消后保留可诊断的运行状态                                            |
| 序列产物   | 排除 FASTA 中的原始序列记录后数候选；检查链、长度、字母表、有限评分与固定残基不变                                         |
| 结构产物   | RFdiffusion 保存 PDB、有效配置和 `.trb` 映射；生成区为待序列设计的骨架，不能当作已完成序列                                |
| 结构复核   | 每个指标绑定实现版本和定义；缺失、NaN 或约束失败时标为未通过，返回原因                                                    |

需要特别防止两个已从源码核对的问题：

1. ProteinMPNN 实际候选数为 `温度数 × floor(num_seq_per_target / batch_size) × batch_size`，并不总等于请求数；例如请求数小于批大小可能没有生成候选。FASTA 中的原始序列也不能算作候选。
2. 固定位点采用解析后链内从 1 开始的编号，不是原始 PDB 编号。解析过程可能保留缺号或处理插入码，跨工具衔接必须保存映射；RFdiffusion 还可能重编号生成链。

依据：[ProteinMPNN 推理入口](https://github.com/dauparas/ProteinMPNN/blob/8907e6671bfbfc92303b5f79c4b5e6ce47cdef57/protein_mpnn_run.py)、[固定位置示例](https://github.com/dauparas/ProteinMPNN/blob/8907e6671bfbfc92303b5f79c4b5e6ce47cdef57/examples/submit_example_4.sh)、[解析与位置实现](https://github.com/dauparas/ProteinMPNN/blob/8907e6671bfbfc92303b5f79c4b5e6ce47cdef57/protein_mpnn_utils.py)、[RFdiffusion 推理入口](https://github.com/RosettaCommons/RFdiffusion/blob/86507b6538f51fce57b5a72477165f03999ed7ae/scripts/run_inference.py)。

ProteinMPNN 的 `score` 是设计位置的平均负对数概率，`global_score` 覆盖全部相关位置；二者分别记录，均不代表亲和力。固定靶标链不会自动完整写入设计链 FASTA，完整复合物需结合原始输入与链映射重建。

RFdiffusion 的 `inference.deterministic=True` 会先设初始种子，再按设计编号设种子；没有本次已核验的通用 `--seed` 参数。输出目录中已有设计会影响自动编号，因此复现时显式设置 `inference.design_startnum`。相同种子也不保证跨硬件逐字节一致。

## 已完成的 ProteinMPNN CPU 检查

使用固定来源的官方 `5L33.pdb`、完整骨架权重 `v_48_020`，链 A、温度 0.1、seed 37、backbone_noise 0、候选数 1、batch_size 1。参数参考官方示例，规模为本次工程验收设置，不宣称是论文某项实验的完整配置。

| 运行         | 实际结果                               | 验收                                                    |
| ------------ | -------------------------------------- | ------------------------------------------------------- |
| 普通设计     | 产生 1 条新序列，另含 1 条原始序列记录 | 退出成功；长度 106；标准氨基酸字母表；评分有限          |
| 同配置重复   | 再产生 1 条新序列                      | 两次 FASTA 的 SHA256 相同，仅说明该环境与设置下重复一致 |
| 固定位点设计 | 固定解析链 A 的第 1、10、20 位         | 三个位置分别保持 H、R、D，其余产物检查通过              |

每次约 1.2–1.3 秒，包含进程启动；这是小输入的运行记录，不能作为吞吐率或硬件需求基准。最初受沙箱 OpenMP 共享内存限制的尝试失败，允许共享内存的执行环境中三次均成功，未修改上游源码。

从固定版本源码根目录使用已验证的解释器和权重，可按下面的参数重建普通案例：

```sh
python protein_mpnn_run.py \
  --pdb_path inputs/PDB_monomers/pdbs/5L33.pdb \
  --pdb_path_chains A \
  --path_to_model_weights vanilla_model_weights \
  --model_name v_48_020 \
  --out_folder smoke/plain \
  --num_seq_per_target 1 --batch_size 1 \
  --sampling_temp 0.1 --seed 37 --backbone_noise 0.0 \
  --save_score 1
```

固定位置案例再传 `--fixed_positions_jsonl fixed.jsonl`，文件内容为 `{"5L33":{"A":[1,10,20]}}`。重复案例使用不同输出目录，其余参数相同。本轮源码按文件下载，FASTA 头内 `git_hash=unknown`；因此在外层运行记录单独保存实际源码 commit 和文件哈希。

## 待验收的 RFdiffusion 运行案例

在固定版本源码根目录、兼容环境和基础权重就绪后，可用下列缩小规模的案例检查入口。该命令来自已核对的上游参数，**本轮尚未执行**；保留模型默认扩散步数，避免把加速设置与环境验证混为一项变化。

```sh
python scripts/run_inference.py \
  'contigmap.contigs=[100-100]' \
  inference.output_prefix=smoke/design \
  inference.num_designs=1 \
  inference.deterministic=True \
  inference.design_startnum=0
```

验收至少包括正常退出、1 个 100 残基骨架、必要主链坐标完整且有限、有效配置和残基映射已保存。随后才添加基序或结合靶标条件；基础案例通过不证明条件生成、序列兼容性或功能成立。

## 下一阶段验收与对照

执行技能验收应依次推进，分别保留证据：

1. **独立环境安装。** 形成完整平台锁或镜像 digest，测试断网缓存重建、权重校验和上游 CLI 可用性；不能依赖用户已有 conda 环境来宣称技能可安装。
2. **异常与运行管理。** 验证不存在的链、缺失坐标、错误权重、非法固定位置、不可整除批次、无法写入目录及超时取消均返回明确失败，不产生成功候选。
3. **RFdiffusion 单步运行。** 用匹配基础模型完成 1 个无条件案例，核对产物数量、长度、有效坐标和有效配置；条件生成再测功能基序、固定靶标及映射保留。
4. **跨工具衔接。** RFdiffusion 骨架交给 ProteinMPNN；固定靶标链与功能残基，逐候选检查保存的映射，再运行固定版本的结构复核。
5. **同预算比较。** 固定任务集、输入、模型、采样总数、硬件和预算，对比固定上游流程与智能体策略；记录每一步尝试数、失败数、通过数、结构与序列多样性、总时间。实验比较还需记录合成、表达和实测样本分母，保留阴性结果；未检测的候选单独列出。

计算对照优先复现对应论文的定义，新增工程筛选作为另一组配置报告。实验阶段分别比较原始设计与重设计、正负对照、表达和可溶性、结合或催化功能。只有在实际测量后才报告功能命中；计算成功不自动升级为实验成功。
