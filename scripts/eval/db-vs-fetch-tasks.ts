// Fixed lookup tasks for db-vs-fetch.ts. `expect` lists the facts a correct answer must
// contain (checked when scoring); values were verified against the live APIs on 2026-09-29.

export interface EvalTask {
  id: string
  source: string
  prompt: string
  expect: string[]
}

export const TASKS: EvalTask[] = [
  {
    id: 'T01',
    source: 'UniProt',
    prompt: '查询人类 TP53 在 UniProt 中已审阅（Swiss-Prot）条目的登录号和蛋白序列长度。',
    expect: ['P04637', '393']
  },
  {
    id: 'T02',
    source: 'Ensembl',
    prompt: '在 Ensembl 中查询人类 BRCA1 基因的 Ensembl 基因 ID 及其 GRCh38 染色体坐标。',
    expect: ['ENSG00000012048', '17', '43044292', '43170245']
  },
  {
    id: 'T03',
    source: 'PubChem',
    prompt: '在 PubChem 中查询 imatinib 的 CID 和分子式。',
    expect: ['5291', 'C29H31N7O']
  },
  {
    id: 'T04',
    source: 'ChEMBL',
    prompt: 'ChEMBL 中 CHEMBL941 是什么化合物？给出它的最高研发阶段（max phase）和首次批准年份。',
    expect: ['imatinib', '4', '2001']
  },
  {
    id: 'T05',
    source: 'PDB',
    prompt: '查询 PDB 结构 1TUP 的实验方法和分辨率。',
    expect: ['X-ray', '2.2']
  },
  {
    id: 'T06',
    source: 'AlphaFold',
    prompt: '查询 AlphaFold DB 中 UniProt P04637 的预测模型 ID、最新模型版本和全局平均 pLDDT。',
    expect: ['AF-P04637-F1', '75.06']
  },
  {
    id: 'T07',
    source: 'GO',
    prompt: 'GO:0006915 的术语名称和所属本体（namespace）是什么？',
    expect: ['apoptotic process', 'biological_process']
  },
  {
    id: 'T08',
    source: 'Reactome',
    prompt: 'Reactome 通路 R-HSA-109581 的名称是什么？',
    expect: ['Apoptosis']
  },
  {
    id: 'T09',
    source: 'ClinVar/MyVariant',
    prompt: '查询变异 rs80357906 在 ClinVar 中的所在基因和临床意义。',
    expect: ['BRCA1', 'Pathogenic']
  },
  {
    id: 'T10',
    source: 'MyGene/NCBI Gene',
    prompt: '把这 5 个人类基因符号映射为 NCBI Entrez Gene ID：TP53, EGFR, KRAS, MYC, PTEN。',
    expect: ['7157', '1956', '3845', '4609', '5728']
  },
  {
    id: 'T11',
    source: 'UniProt xref',
    prompt: 'UniProt P38398 对应的 Ensembl 基因 ID 和 HGNC ID 分别是什么？',
    expect: ['ENSG00000012048', 'HGNC:1100']
  },
  {
    id: 'T12',
    source: 'cBioPortal',
    prompt: 'cBioPortal 研究 brca_tcga_pan_can_atlas_2018 的名称和样本总数是多少？',
    expect: ['Breast Invasive Carcinoma', '1084']
  },
  {
    id: 'T13',
    source: 'GDC',
    prompt: '在 GDC 中查询项目 TCGA-LUAD 的项目名称和病例（case）数量。',
    expect: ['Lung Adenocarcinoma', '585']
  },
  {
    id: 'T14',
    source: 'GEO',
    prompt: '查询 GEO 数据集 GSE10072 的物种、样本数和关联的 PubMed ID。',
    expect: ['Homo sapiens', '107', '18297132']
  }
]
