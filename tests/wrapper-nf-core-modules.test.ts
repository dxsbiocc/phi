import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { basename, join } from 'node:path'
import test from 'node:test'

import {
  findWrapperCompositionEntry,
  listWrapperCompositionCatalog,
  readWrapperCompositionDag,
  readWrapperModuleDetails,
  resetWrapperCompositionCatalogCache
} from '../src/main/agent/wrappers/composition/discovery'
import { parseWrapperCompositionManifest } from '../src/main/agent/wrappers/composition/manifest'
import {
  buildWrapperCompositionInspectTool,
  buildWrapperCompositionRunTool,
  buildWrapperCompositionSearchTool,
  buildWrapperCompositionTools
} from '../src/main/agent/wrappers/composition/tools'
import { WrapperJobManager } from '../src/main/agent/wrappers/composition/job-manager'
import { validateWrapperParams } from '../src/main/agent/wrappers/composition/validate'

const EXPECTED_MODULE_WRAPPER_IDS = [
  'local/modules/differential-expression-deseq2',
  'local/modules/differential-expression-edger',
  'local/modules/differential-expression-limma',
  'local/modules/differential-expression-qc',
  'local/modules/differential-expression-timeseries',
  'local/modules/differential-expression-visualization-heatmap',
  'local/modules/differential-expression-visualization-pca',
  'local/modules/differential-expression-visualization-volcano',
  'local/modules/preprocess-transcripts-fasta-gencode',
  'local/modules/star-genomeparams-upgrade',
  'local/subworkflows/align-bowtie2',
  'local/subworkflows/align-star',
  'nf-core/modules/abra2',
  'nf-core/modules/anndata-barcodes',
  'nf-core/modules/anndata-getsize',
  'nf-core/modules/arriba-arriba',
  'nf-core/modules/arriba-download',
  'nf-core/modules/arriba-visualisation',
  'nf-core/modules/ascat',
  'nf-core/modules/atlas-call',
  'nf-core/modules/atlas-pmd',
  'nf-core/modules/atlas-recal',
  'nf-core/modules/atlas-splitmerge',
  'nf-core/modules/bamclipper',
  'nf-core/modules/bamtools-convert',
  'nf-core/modules/bamtools-split',
  'nf-core/modules/bamtools-stats',
  'nf-core/modules/bamutil-clipoverlap',
  'nf-core/modules/bamutil-trimbam',
  'nf-core/modules/bbmap-align',
  'nf-core/modules/bbmap-bbduk',
  'nf-core/modules/bbmap-bbmerge',
  'nf-core/modules/bbmap-bbnorm',
  'nf-core/modules/bbmap-bbsplit',
  'nf-core/modules/bbmap-clumpify',
  'nf-core/modules/bbmap-filterbyname',
  'nf-core/modules/bbmap-index',
  'nf-core/modules/bbmap-pileup',
  'nf-core/modules/bbmap-repair',
  'nf-core/modules/bcftools-annotate',
  'nf-core/modules/bcftools-call',
  'nf-core/modules/bcftools-concat',
  'nf-core/modules/bcftools-consensus',
  'nf-core/modules/bcftools-convert',
  'nf-core/modules/bcftools-csq',
  'nf-core/modules/bcftools-filter',
  'nf-core/modules/bcftools-index',
  'nf-core/modules/bcftools-isec',
  'nf-core/modules/bcftools-merge',
  'nf-core/modules/bcftools-mpileup',
  'nf-core/modules/bcftools-norm',
  'nf-core/modules/bcftools-plotvcfstats',
  'nf-core/modules/bcftools-pluginfilltags',
  'nf-core/modules/bcftools-pluginfixploidy',
  'nf-core/modules/bcftools-pluginimputeinfo',
  'nf-core/modules/bcftools-pluginscatter',
  'nf-core/modules/bcftools-pluginsetgt',
  'nf-core/modules/bcftools-pluginsplit',
  'nf-core/modules/bcftools-plugintag2tag',
  'nf-core/modules/bcftools-pluginvcf2table',
  'nf-core/modules/bcftools-query',
  'nf-core/modules/bcftools-reheader',
  'nf-core/modules/bcftools-roh',
  'nf-core/modules/bcftools-rohviz',
  'nf-core/modules/bcftools-sort',
  'nf-core/modules/bcftools-split',
  'nf-core/modules/bcftools-stats',
  'nf-core/modules/bcftools-view',
  'nf-core/modules/beagle5-beagle',
  'nf-core/modules/bedtools-bamtobed',
  'nf-core/modules/bedtools-closest',
  'nf-core/modules/bedtools-complement',
  'nf-core/modules/bedtools-coverage',
  'nf-core/modules/bedtools-flank',
  'nf-core/modules/bedtools-genomecov',
  'nf-core/modules/bedtools-getfasta',
  'nf-core/modules/bedtools-groupby',
  'nf-core/modules/bedtools-intersect',
  'nf-core/modules/bedtools-jaccard',
  'nf-core/modules/bedtools-makewindows',
  'nf-core/modules/bedtools-map',
  'nf-core/modules/bedtools-maskfasta',
  'nf-core/modules/bedtools-merge',
  'nf-core/modules/bedtools-multiinter',
  'nf-core/modules/bedtools-nuc',
  'nf-core/modules/bedtools-shift',
  'nf-core/modules/bedtools-shuffle',
  'nf-core/modules/bedtools-slop',
  'nf-core/modules/bedtools-sort',
  'nf-core/modules/bedtools-split',
  'nf-core/modules/bedtools-subtract',
  'nf-core/modules/bedtools-unionbedg',
  'nf-core/modules/biscuit-align',
  'nf-core/modules/biscuit-biscuitblaster',
  'nf-core/modules/biscuit-bsconv',
  'nf-core/modules/biscuit-epiread',
  'nf-core/modules/biscuit-index',
  'nf-core/modules/biscuit-mergecg',
  'nf-core/modules/biscuit-pileup',
  'nf-core/modules/biscuit-qc',
  'nf-core/modules/biscuit-vcf2bed',
  'nf-core/modules/bismark-align',
  'nf-core/modules/bismark-coverage2cytosine',
  'nf-core/modules/bismark-deduplicate',
  'nf-core/modules/bismark-genomepreparation',
  'nf-core/modules/bismark-methylationextractor',
  'nf-core/modules/bismark-report',
  'nf-core/modules/bismark-summary',
  'nf-core/modules/blast-blastdbcmd',
  'nf-core/modules/blast-blastn',
  'nf-core/modules/blast-blastp',
  'nf-core/modules/blast-makeblastdb',
  'nf-core/modules/blast-tblastn',
  'nf-core/modules/blast-updateblastdb',
  'nf-core/modules/blat',
  'nf-core/modules/bowtie-align',
  'nf-core/modules/bowtie-build',
  'nf-core/modules/bowtie2-align',
  'nf-core/modules/bowtie2-build',
  'nf-core/modules/bracken-bracken',
  'nf-core/modules/bracken-build',
  'nf-core/modules/bracken-combinebrackenoutputs',
  'nf-core/modules/bwa-aln',
  'nf-core/modules/bwa-index',
  'nf-core/modules/bwa-mem',
  'nf-core/modules/bwa-sampe',
  'nf-core/modules/bwa-samse',
  'nf-core/modules/bwamem2-index',
  'nf-core/modules/bwamem2-mem',
  'nf-core/modules/bwamem3-index',
  'nf-core/modules/bwamem3-mem',
  'nf-core/modules/bwameme-index',
  'nf-core/modules/bwameme-mem',
  'nf-core/modules/bwameth-align',
  'nf-core/modules/bwameth-index',
  'nf-core/modules/cat-fastq',
  'nf-core/modules/cellbender-merge',
  'nf-core/modules/cellbender-removebackground',
  'nf-core/modules/clair3',
  'nf-core/modules/cnvkit-access',
  'nf-core/modules/cnvkit-antitarget',
  'nf-core/modules/cnvkit-batch',
  'nf-core/modules/cnvkit-call',
  'nf-core/modules/cnvkit-coverage',
  'nf-core/modules/cnvkit-export',
  'nf-core/modules/cnvkit-fix',
  'nf-core/modules/cnvkit-genemetrics',
  'nf-core/modules/cnvkit-reference',
  'nf-core/modules/cnvkit-segment',
  'nf-core/modules/cnvkit-target',
  'nf-core/modules/cnvnator-cnvnator',
  'nf-core/modules/cnvnator-convert2vcf',
  'nf-core/modules/cnvpytor-callcnvs',
  'nf-core/modules/cnvpytor-histogram',
  'nf-core/modules/cnvpytor-importreaddepth',
  'nf-core/modules/cnvpytor-partition',
  'nf-core/modules/cnvpytor-view',
  'nf-core/modules/controlfreec-assesssignificance',
  'nf-core/modules/controlfreec-freec',
  'nf-core/modules/controlfreec-freec2bed',
  'nf-core/modules/controlfreec-freec2circos',
  'nf-core/modules/controlfreec-makegraph',
  'nf-core/modules/controlfreec-makegraph2',
  'nf-core/modules/ctatsplicing-prepgenomelib',
  'nf-core/modules/ctatsplicing-startocancerintrons',
  'nf-core/modules/custom-addmostsevereconsequence',
  'nf-core/modules/custom-addmostseverepli',
  'nf-core/modules/custom-bed12codonpositions',
  'nf-core/modules/custom-catadditionalfasta',
  'nf-core/modules/custom-clustermetrics',
  'nf-core/modules/custom-clustervisualization',
  'nf-core/modules/custom-collectfeaturecounts',
  'nf-core/modules/custom-filterdifferentialtable',
  'nf-core/modules/custom-geneticmapconvert',
  'nf-core/modules/custom-gtffilter',
  'nf-core/modules/custom-matrixfilter',
  'nf-core/modules/custom-multiqccustombiotype',
  'nf-core/modules/custom-orfcollapse',
  'nf-core/modules/custom-orfmerge',
  'nf-core/modules/custom-orfnormalise',
  'nf-core/modules/custom-pcaclustering',
  'nf-core/modules/custom-resolvetaxonomy',
  'nf-core/modules/custom-rsemmergecounts',
  'nf-core/modules/custom-tabulartogseachip',
  'nf-core/modules/custom-tabulartogseacls',
  'nf-core/modules/custom-tabulartogseagct',
  'nf-core/modules/custom-tx2gene',
  'nf-core/modules/cutesv',
  'nf-core/modules/deeptools-alignmentsieve',
  'nf-core/modules/deeptools-bamcompare',
  'nf-core/modules/deeptools-bamcoverage',
  'nf-core/modules/deeptools-bigwigcompare',
  'nf-core/modules/deeptools-computematrix',
  'nf-core/modules/deeptools-multibamsummary',
  'nf-core/modules/deeptools-multibigwigsummary',
  'nf-core/modules/deeptools-plotcorrelation',
  'nf-core/modules/deeptools-plotfingerprint',
  'nf-core/modules/deeptools-plotheatmap',
  'nf-core/modules/deeptools-plotpca',
  'nf-core/modules/deeptools-plotprofile',
  'nf-core/modules/delly-call',
  'nf-core/modules/delly-sr',
  'nf-core/modules/diamond-blastp',
  'nf-core/modules/diamond-blastx',
  'nf-core/modules/diamond-cluster',
  'nf-core/modules/diamond-deepclust',
  'nf-core/modules/diamond-linclust',
  'nf-core/modules/diamond-makedb',
  'nf-core/modules/dragmap-align',
  'nf-core/modules/dragmap-hashtable',
  'nf-core/modules/dupradar',
  'nf-core/modules/dysgu-run',
  'nf-core/modules/eautils-gtf2bed',
  'nf-core/modules/elprep-fastatoelfasta',
  'nf-core/modules/elprep-filter',
  'nf-core/modules/elprep-merge',
  'nf-core/modules/elprep-split',
  'nf-core/modules/expansionhunter',
  'nf-core/modules/fastp',
  'nf-core/modules/fastqc',
  'nf-core/modules/fgbio-callduplexconsensusreads',
  'nf-core/modules/fgbio-callmolecularconsensusreads',
  'nf-core/modules/fgbio-collectduplexseqmetrics',
  'nf-core/modules/fgbio-copyumifromreadname',
  'nf-core/modules/fgbio-fastqtobam',
  'nf-core/modules/fgbio-filterconsensusreads',
  'nf-core/modules/fgbio-groupreadsbyumi',
  'nf-core/modules/fgbio-sortbam',
  'nf-core/modules/fgbio-zipperbams',
  'nf-core/modules/fq-generate',
  'nf-core/modules/fq-lint',
  'nf-core/modules/fq-subsample',
  'nf-core/modules/freebayes',
  'nf-core/modules/freyja-variants',
  'nf-core/modules/fusioninspector',
  'nf-core/modules/gangstr',
  'nf-core/modules/gatk-indelrealigner',
  'nf-core/modules/gatk-realignertargetcreator',
  'nf-core/modules/gatk-unifiedgenotyper',
  'nf-core/modules/gatk4-addorreplacereadgroups',
  'nf-core/modules/gatk4-analyzecovariates',
  'nf-core/modules/gatk4-annotateintervals',
  'nf-core/modules/gatk4-applybqsr',
  'nf-core/modules/gatk4-applyvqsr',
  'nf-core/modules/gatk4-asereadcounter',
  'nf-core/modules/gatk4-baserecalibrator',
  'nf-core/modules/gatk4-bedtointervallist',
  'nf-core/modules/gatk4-calculatecontamination',
  'nf-core/modules/gatk4-calibratedragstrmodel',
  'nf-core/modules/gatk4-cleansam',
  'nf-core/modules/gatk4-cnnscorevariants',
  'nf-core/modules/gatk4-collectreadcounts',
  'nf-core/modules/gatk4-collectsvevidence',
  'nf-core/modules/gatk4-combinegvcfs',
  'nf-core/modules/gatk4-composestrtablefile',
  'nf-core/modules/gatk4-concordance',
  'nf-core/modules/gatk4-condensedepthevidence',
  'nf-core/modules/gatk4-createreadcountpanelofnormals',
  'nf-core/modules/gatk4-createsequencedictionary',
  'nf-core/modules/gatk4-createsomaticpanelofnormals',
  'nf-core/modules/gatk4-denoisereadcounts',
  'nf-core/modules/gatk4-determinegermlinecontigploidy',
  'nf-core/modules/gatk4-estimatelibrarycomplexity',
  'nf-core/modules/gatk4-fastqtosam',
  'nf-core/modules/gatk4-filterintervals',
  'nf-core/modules/gatk4-filtermutectcalls',
  'nf-core/modules/gatk4-filtervarianttranches',
  'nf-core/modules/gatk4-gatherbqsrreports',
  'nf-core/modules/gatk4-gatherpileupsummaries',
  'nf-core/modules/gatk4-genomicsdbimport',
  'nf-core/modules/gatk4-genotypegvcfs',
  'nf-core/modules/gatk4-germlinecnvcaller',
  'nf-core/modules/gatk4-getpileupsummaries',
  'nf-core/modules/gatk4-haplotypecaller',
  'nf-core/modules/gatk4-indexfeaturefile',
  'nf-core/modules/gatk4-intervallisttobed',
  'nf-core/modules/gatk4-intervallisttools',
  'nf-core/modules/gatk4-learnreadorientationmodel',
  'nf-core/modules/gatk4-leftalignandtrimvariants',
  'nf-core/modules/gatk4-markduplicates',
  'nf-core/modules/gatk4-mergebamalignment',
  'nf-core/modules/gatk4-mergemutectstats',
  'nf-core/modules/gatk4-mergevcfs',
  'nf-core/modules/gatk4-modelsegments',
  'nf-core/modules/gatk4-mutect2',
  'nf-core/modules/gatk4-postprocessgermlinecnvcalls',
  'nf-core/modules/gatk4-preprocessintervals',
  'nf-core/modules/gatk4-printreads',
  'nf-core/modules/gatk4-printsvevidence',
  'nf-core/modules/gatk4-reblockgvcf',
  'nf-core/modules/gatk4-revertsam',
  'nf-core/modules/gatk4-samtofastq',
  'nf-core/modules/gatk4-selectvariants',
  'nf-core/modules/gatk4-shiftfasta',
  'nf-core/modules/gatk4-sitedepthtobaf',
  'nf-core/modules/gatk4-splitcram',
  'nf-core/modules/gatk4-splitintervals',
  'nf-core/modules/gatk4-splitncigarreads',
  'nf-core/modules/gatk4-svannotate',
  'nf-core/modules/gatk4-svcluster',
  'nf-core/modules/gatk4-unmarkduplicates',
  'nf-core/modules/gatk4-variantfiltration',
  'nf-core/modules/gatk4-variantrecalibrator',
  'nf-core/modules/gatk4-variantstotable',
  'nf-core/modules/gatk4spark-applybqsr',
  'nf-core/modules/gatk4spark-baserecalibrator',
  'nf-core/modules/gatk4spark-markduplicates',
  'nf-core/modules/gawk',
  'nf-core/modules/gffread',
  'nf-core/modules/glimpse-chunk',
  'nf-core/modules/glimpse-concordance',
  'nf-core/modules/glimpse-ligate',
  'nf-core/modules/glimpse-phase',
  'nf-core/modules/glimpse-sample',
  'nf-core/modules/graphtyper-genotype',
  'nf-core/modules/graphtyper-vcfconcatenate',
  'nf-core/modules/gridss-annotate',
  'nf-core/modules/gridss-assemble',
  'nf-core/modules/gridss-call',
  'nf-core/modules/gridss-extractoverlappingfragments',
  'nf-core/modules/gridss-generateponbedpe',
  'nf-core/modules/gridss-gridss',
  'nf-core/modules/gridss-preprocess',
  'nf-core/modules/gridss-somaticfilter',
  'nf-core/modules/gunzip',
  'nf-core/modules/happy-ftxpy',
  'nf-core/modules/happy-happy',
  'nf-core/modules/happy-prepy',
  'nf-core/modules/happy-sompy',
  'nf-core/modules/hificnv',
  'nf-core/modules/hiphase',
  'nf-core/modules/hisat2-align',
  'nf-core/modules/hisat2-build',
  'nf-core/modules/hisat2-extractsplicesites',
  'nf-core/modules/hmmcopy-gccounter',
  'nf-core/modules/hmmcopy-generatemap',
  'nf-core/modules/hmmcopy-mapcounter',
  'nf-core/modules/hmmcopy-readcounter',
  'nf-core/modules/htslib-bgziptabix',
  'nf-core/modules/ivar-consensus',
  'nf-core/modules/ivar-trim',
  'nf-core/modules/ivar-variants',
  'nf-core/modules/kallisto-index',
  'nf-core/modules/kallisto-quant',
  'nf-core/modules/kraken2-add',
  'nf-core/modules/kraken2-build',
  'nf-core/modules/kraken2-kraken2',
  'nf-core/modules/lima',
  'nf-core/modules/lofreq-alnqual',
  'nf-core/modules/lofreq-call',
  'nf-core/modules/lofreq-callparallel',
  'nf-core/modules/lofreq-filter',
  'nf-core/modules/lofreq-indelqual',
  'nf-core/modules/lofreq-somatic',
  'nf-core/modules/lofreq-viterbi',
  'nf-core/modules/longphase-haplotag',
  'nf-core/modules/longphase-phase',
  'nf-core/modules/manta-convertinversion',
  'nf-core/modules/manta-germline',
  'nf-core/modules/manta-somatic',
  'nf-core/modules/manta-tumoronly',
  'nf-core/modules/medaka',
  'nf-core/modules/methyldackel-extract',
  'nf-core/modules/methyldackel-mbias',
  'nf-core/modules/minimac4-compressref',
  'nf-core/modules/minimac4-impute',
  'nf-core/modules/minimap2-align',
  'nf-core/modules/minimap2-index',
  'nf-core/modules/mitorsaw-haplotype',
  'nf-core/modules/mmseqs-cluster',
  'nf-core/modules/mmseqs-createdb',
  'nf-core/modules/mmseqs-createindex',
  'nf-core/modules/mmseqs-createtaxdb',
  'nf-core/modules/mmseqs-easycluster',
  'nf-core/modules/mmseqs-easysearch',
  'nf-core/modules/mmseqs-linclust',
  'nf-core/modules/mmseqs-makepaddedseqdb',
  'nf-core/modules/mmseqs-search',
  'nf-core/modules/mmseqs-tsv2exprofiledb',
  'nf-core/modules/multiqc',
  'nf-core/modules/muse-call',
  'nf-core/modules/muse-sump',
  'nf-core/modules/nanomonsv-get',
  'nf-core/modules/nanomonsv-parse',
  'nf-core/modules/octopusv-clean',
  'nf-core/modules/octopusv-correct',
  'nf-core/modules/octopusv-merge',
  'nf-core/modules/octopusv-plot',
  'nf-core/modules/octopusv-plotcircos',
  'nf-core/modules/octopusv-stat',
  'nf-core/modules/octopusv-svcf2bed',
  'nf-core/modules/octopusv-svcf2vcf',
  'nf-core/modules/paragraph-idxdepth',
  'nf-core/modules/paragraph-multigrmpy',
  'nf-core/modules/paragraph-vcf2paragraph',
  'nf-core/modules/paraphase',
  'nf-core/modules/pbmm2-align',
  'nf-core/modules/pbsv-call',
  'nf-core/modules/pbsv-discover',
  'nf-core/modules/picard-addorreplacereadgroups',
  'nf-core/modules/picard-bedtointervallist',
  'nf-core/modules/picard-cleansam',
  'nf-core/modules/picard-collectalignmentsummarymetrics',
  'nf-core/modules/picard-collecthsmetrics',
  'nf-core/modules/picard-collectinsertsizemetrics',
  'nf-core/modules/picard-collectmultiplemetrics',
  'nf-core/modules/picard-collectrnaseqmetrics',
  'nf-core/modules/picard-collectvariantcallingmetrics',
  'nf-core/modules/picard-collectwgsmetrics',
  'nf-core/modules/picard-createsequencedictionary',
  'nf-core/modules/picard-crosscheckfingerprints',
  'nf-core/modules/picard-extractfingerprint',
  'nf-core/modules/picard-fastqtosam',
  'nf-core/modules/picard-filtersamreads',
  'nf-core/modules/picard-fixmateinformation',
  'nf-core/modules/picard-liftovervcf',
  'nf-core/modules/picard-markduplicates',
  'nf-core/modules/picard-meanqualitybycycle',
  'nf-core/modules/picard-mergesamfiles',
  'nf-core/modules/picard-positionbaseddownsamplesam',
  'nf-core/modules/picard-renamesampleinvcf',
  'nf-core/modules/picard-scatterintervalsbyns',
  'nf-core/modules/picard-setnmmdanduqtags',
  'nf-core/modules/picard-sortsam',
  'nf-core/modules/picard-sortvcf',
  'nf-core/modules/picard-splitsambynumberofreads',
  'nf-core/modules/pigz-compress',
  'nf-core/modules/pigz-uncompress',
  'nf-core/modules/pindel-pindel',
  'nf-core/modules/platypus',
  'nf-core/modules/plink-bcf',
  'nf-core/modules/plink-bmerge',
  'nf-core/modules/plink-epistasis',
  'nf-core/modules/plink-exclude',
  'nf-core/modules/plink-extract',
  'nf-core/modules/plink-fastepistasis',
  'nf-core/modules/plink-genome',
  'nf-core/modules/plink-gwas',
  'nf-core/modules/plink-hwe',
  'nf-core/modules/plink-indep',
  'nf-core/modules/plink-indeppairwise',
  'nf-core/modules/plink-ld',
  'nf-core/modules/plink-missing',
  'nf-core/modules/plink-recode',
  'nf-core/modules/plink-vcf',
  'nf-core/modules/plink2-extract',
  'nf-core/modules/plink2-filter',
  'nf-core/modules/plink2-het',
  'nf-core/modules/plink2-indeppairwise',
  'nf-core/modules/plink2-pca',
  'nf-core/modules/plink2-pmerge',
  'nf-core/modules/plink2-remove',
  'nf-core/modules/plink2-score',
  'nf-core/modules/plink2-vcf',
  'nf-core/modules/plink2-vcf2bgen',
  'nf-core/modules/preseq-ccurve',
  'nf-core/modules/preseq-lcextrap',
  'nf-core/modules/qualimap-bamqc',
  'nf-core/modules/qualimap-bamqccram',
  'nf-core/modules/qualimap-rnaseq',
  'nf-core/modules/ribodetector',
  'nf-core/modules/rsem-calculateexpression',
  'nf-core/modules/rsem-preparereference',
  'nf-core/modules/rseqc-bamstat',
  'nf-core/modules/rseqc-inferexperiment',
  'nf-core/modules/rseqc-innerdistance',
  'nf-core/modules/rseqc-junctionannotation',
  'nf-core/modules/rseqc-junctionsaturation',
  'nf-core/modules/rseqc-readdistribution',
  'nf-core/modules/rseqc-readduplication',
  'nf-core/modules/rseqc-splitbam',
  'nf-core/modules/rseqc-tin',
  'nf-core/modules/rtgtools-bndeval',
  'nf-core/modules/rtgtools-cnveval',
  'nf-core/modules/rtgtools-format',
  'nf-core/modules/rtgtools-pedfilter',
  'nf-core/modules/rtgtools-rocplot',
  'nf-core/modules/rtgtools-svdecompose',
  'nf-core/modules/rtgtools-vcfeval',
  'nf-core/modules/rustqc',
  'nf-core/modules/salmon-index',
  'nf-core/modules/salmon-quant',
  'nf-core/modules/sambamba-depth',
  'nf-core/modules/sambamba-flagstat',
  'nf-core/modules/sambamba-markdup',
  'nf-core/modules/samblaster',
  'nf-core/modules/samtools-addreplacerg',
  'nf-core/modules/samtools-ampliconclip',
  'nf-core/modules/samtools-bam2fq',
  'nf-core/modules/samtools-bedcov',
  'nf-core/modules/samtools-calmd',
  'nf-core/modules/samtools-cat',
  'nf-core/modules/samtools-collate',
  'nf-core/modules/samtools-collatefastq',
  'nf-core/modules/samtools-consensus',
  'nf-core/modules/samtools-convert',
  'nf-core/modules/samtools-coverage',
  'nf-core/modules/samtools-cramsize',
  'nf-core/modules/samtools-depth',
  'nf-core/modules/samtools-dict',
  'nf-core/modules/samtools-faidx',
  'nf-core/modules/samtools-fasta',
  'nf-core/modules/samtools-fastq',
  'nf-core/modules/samtools-fixmate',
  'nf-core/modules/samtools-flagstat',
  'nf-core/modules/samtools-idxstats',
  'nf-core/modules/samtools-import',
  'nf-core/modules/samtools-index',
  'nf-core/modules/samtools-markdup',
  'nf-core/modules/samtools-merge',
  'nf-core/modules/samtools-mpileup',
  'nf-core/modules/samtools-quickcheck',
  'nf-core/modules/samtools-reheader',
  'nf-core/modules/samtools-samples',
  'nf-core/modules/samtools-sormadup',
  'nf-core/modules/samtools-sort',
  'nf-core/modules/samtools-splitheader',
  'nf-core/modules/samtools-stats',
  'nf-core/modules/samtools-view',
  'nf-core/modules/scanpy-filter',
  'nf-core/modules/scanpy-hashsolo',
  'nf-core/modules/scanpy-pca',
  'nf-core/modules/scanpy-scrublet',
  'nf-core/modules/scramble-clusteranalysis',
  'nf-core/modules/scramble-clusteridentifier',
  'nf-core/modules/seqkit-concat',
  'nf-core/modules/seqkit-fq2fa',
  'nf-core/modules/seqkit-fx2tab',
  'nf-core/modules/seqkit-grep',
  'nf-core/modules/seqkit-head',
  'nf-core/modules/seqkit-pair',
  'nf-core/modules/seqkit-replace',
  'nf-core/modules/seqkit-rmdup',
  'nf-core/modules/seqkit-sample',
  'nf-core/modules/seqkit-sana',
  'nf-core/modules/seqkit-seq',
  'nf-core/modules/seqkit-sliding',
  'nf-core/modules/seqkit-sort',
  'nf-core/modules/seqkit-split2',
  'nf-core/modules/seqkit-stats',
  'nf-core/modules/seqkit-tab2fx',
  'nf-core/modules/seqkit-translate',
  'nf-core/modules/shapeit5-phasecommon',
  'nf-core/modules/shapeit5-phaserare',
  'nf-core/modules/simpleaf-index',
  'nf-core/modules/simpleaf-quant',
  'nf-core/modules/smncopynumbercaller',
  'nf-core/modules/smoove-call',
  'nf-core/modules/sniffles',
  'nf-core/modules/snpeff-download',
  'nf-core/modules/snpeff-snpeff',
  'nf-core/modules/snpsift-annmem',
  'nf-core/modules/snpsift-annmemcreate',
  'nf-core/modules/snpsift-annotate',
  'nf-core/modules/snpsift-dbnsfp',
  'nf-core/modules/snpsift-split',
  'nf-core/modules/somalier-extract',
  'nf-core/modules/somalier-relate',
  'nf-core/modules/sortmerna',
  'nf-core/modules/star-align',
  'nf-core/modules/star-genomegenerate',
  'nf-core/modules/star-indexversion',
  'nf-core/modules/star-starsolo',
  'nf-core/modules/starfusion-build',
  'nf-core/modules/starfusion-detect',
  'nf-core/modules/strelka-germline',
  'nf-core/modules/strelka-somatic',
  'nf-core/modules/stringtie-merge',
  'nf-core/modules/stringtie-stringtie',
  'nf-core/modules/subread-featurecounts',
  'nf-core/modules/summarizedexperiment',
  'nf-core/modules/survivor-bedpetovcf',
  'nf-core/modules/survivor-filter',
  'nf-core/modules/survivor-merge',
  'nf-core/modules/survivor-stats',
  'nf-core/modules/svaba',
  'nf-core/modules/svim-alignment',
  'nf-core/modules/svtk-baftest',
  'nf-core/modules/svtk-countsvtypes',
  'nf-core/modules/svtk-rdtest2vcf',
  'nf-core/modules/svtk-standardize',
  'nf-core/modules/svtk-vcf2bed',
  'nf-core/modules/sylph-profile',
  'nf-core/modules/sylph-query',
  'nf-core/modules/sylph-sketch',
  'nf-core/modules/sylph-sketchgenomes',
  'nf-core/modules/sylph-sketchsamples',
  'nf-core/modules/sylphtax-merge',
  'nf-core/modules/sylphtax-taxprof',
  'nf-core/modules/tiddit-cov',
  'nf-core/modules/tiddit-sv',
  'nf-core/modules/trgt-genotype',
  'nf-core/modules/trimgalore',
  'nf-core/modules/truvari-bench',
  'nf-core/modules/truvari-consistency',
  'nf-core/modules/truvari-segment',
  'nf-core/modules/tximeta-tximport',
  'nf-core/modules/ucsc-bedclip',
  'nf-core/modules/ucsc-bedgraphtobigwig',
  'nf-core/modules/ucsc-bedtobigbed',
  'nf-core/modules/ucsc-bigwigaverageoverbed',
  'nf-core/modules/ucsc-gtftogenepred',
  'nf-core/modules/ucsc-liftover',
  'nf-core/modules/ucsc-wigtobigwig',
  'nf-core/modules/umicollapse',
  'nf-core/modules/umitools-dedup',
  'nf-core/modules/umitools-extract',
  'nf-core/modules/umitools-group',
  'nf-core/modules/umitools-prepareforrsem',
  'nf-core/modules/untar',
  'nf-core/modules/unzip',
  'nf-core/modules/varlociraptor-callvariants',
  'nf-core/modules/varlociraptor-estimatealignmentproperties',
  'nf-core/modules/varlociraptor-filterfdr',
  'nf-core/modules/varlociraptor-preprocess',
  'nf-core/modules/varscan-processsomatic',
  'nf-core/modules/varscan-somatic',
  'nf-core/modules/vcf2maf',
  'nf-core/modules/vcfanno',
  'nf-core/modules/vcflib-vcfbreakmulti',
  'nf-core/modules/vcflib-vcffilter',
  'nf-core/modules/vcflib-vcffixup',
  'nf-core/modules/vcflib-vcfuniq',
  'nf-core/modules/vcftools',
  'nf-core/modules/vt-decompose',
  'nf-core/modules/vt-decomposeblocksub',
  'nf-core/modules/vt-normalize',
  'nf-core/modules/whatshap-haplotag',
  'nf-core/modules/whatshap-phase',
  'nf-core/modules/whatshap-stats',
  'nf-core/modules/wisecondorx-convert',
  'nf-core/modules/zip',
  'nf-core/subworkflows/bam-dedup-stats-samtools-umicollapse',
  'nf-core/subworkflows/bam-dedup-stats-samtools-umitools',
  'nf-core/subworkflows/bam-dedup-umi',
  'nf-core/subworkflows/bam-markduplicates-picard',
  'nf-core/subworkflows/bam-qc-rnaseq',
  'nf-core/subworkflows/bam-rseqc',
  'nf-core/subworkflows/bam-sort-stats-samtools',
  'nf-core/subworkflows/bam-stats-samtools',
  'nf-core/subworkflows/bam-stringtie-merge',
  'nf-core/subworkflows/bedgraph-bedclip-bedgraphtobigwig',
  'nf-core/subworkflows/fastq-align-hisat2',
  'nf-core/subworkflows/fastq-fastqc-umitools-fastp',
  'nf-core/subworkflows/fastq-fastqc-umitools-trimgalore',
  'nf-core/subworkflows/fastq-qc-trim-filter-setstrandedness',
  'nf-core/subworkflows/fastq-remove-rrna',
  'nf-core/subworkflows/fastq-subsample-fq-salmon',
  'nf-core/subworkflows/quant-tximport-summarizedexperiment',
  'nf-core/subworkflows/quantify-pseudo-alignment',
  'nf-core/subworkflows/quantify-rsem',
  'nf-core/workflows/rnaseq',
]

test('composition discovery finds wrappers from the modules/subworkflows/workflows resource layout', () => {
  resetWrapperCompositionCatalogCache()

  const entries = listWrapperCompositionCatalog()
  const ids = entries.map((entry) => entry.manifest.id)
  assert.equal(new Set(ids).size, ids.length, 'wrapper IDs must be unique')
  assert.deepEqual(
    EXPECTED_MODULE_WRAPPER_IDS.filter((id) => !ids.includes(id)),
    [],
    'previously bundled wrappers must remain discoverable as new modules are added'
  )

  assert.ok(entries.every((entry) => basename(entry.wrapperDir) === 'wrapper'))
  assert.ok(
    entries.every((entry) =>
      /resources\/wrappers\/(modules|subworkflows|workflows)\//.test(entry.componentDir)
    )
  )
})

test('composition discovery can find a wrapper by canonical id', () => {
  resetWrapperCompositionCatalogCache()

  const entry = findWrapperCompositionEntry('nf-core/modules/star-align')
  assert.ok(entry)
  assert.equal(entry!.manifest.name, 'STAR align')
  assert.equal(entry!.manifest.params.reads.kind, 'input')
})

test('readWrapperCompositionDag reads the pre-generated Nextflow DAG next to a wrapper', () => {
  resetWrapperCompositionCatalogCache()

  const dag = readWrapperCompositionDag('nf-core/modules/fastqc')
  assert.ok(dag)
  assert.match(dag!, /^flowchart TB/)
  assert.match(dag!, /FASTQC/)
})

test('readWrapperCompositionDag returns undefined for an unknown wrapper id', () => {
  resetWrapperCompositionCatalogCache()

  assert.equal(readWrapperCompositionDag('nf-core/modules/does-not-exist'), undefined)
})

test('readWrapperModuleDetails reads real meta.yml/environment.yml next to a module', () => {
  resetWrapperCompositionCatalogCache()

  const details = readWrapperModuleDetails('nf-core/modules/fastqc')
  assert.ok(details)
  assert.equal(details!.meta?.description, 'Run FastQC on sequenced reads')
  assert.ok(details!.meta?.keywords?.includes('quality control'))
  assert.equal(details!.meta?.tools?.[0].name, 'fastqc')
  assert.match(details!.meta?.tools?.[0].description ?? '', /general quality metrics/)
  assert.deepEqual(details!.meta?.tools?.[0].licence, ['GPL-2.0-only'])
  assert.ok(details!.meta?.tools?.[0].homepage?.startsWith('https://'))
  assert.ok(details!.meta?.authors && details!.meta.authors.length > 0)

  assert.match(details!.environment ?? '', /channels:/)
  assert.match(details!.environment ?? '', /bioconda::fastqc=0\.12\.1/)
})

test('readWrapperModuleDetails returns undefined for a wrapper with neither file (the full pipeline)', () => {
  resetWrapperCompositionCatalogCache()

  assert.equal(readWrapperModuleDetails('nf-core/workflows/rnaseq'), undefined)
})

test('readWrapperModuleDetails returns undefined for an unknown wrapper id', () => {
  resetWrapperCompositionCatalogCache()

  assert.equal(readWrapperModuleDetails('nf-core/modules/does-not-exist'), undefined)
})

test('wrapper_search lists matching composition wrappers', async () => {
  resetWrapperCompositionCatalogCache()

  const result = await buildWrapperCompositionSearchTool().execute('call-1', {
    query: 'fastqc'
  })

  assert.equal(result.isError, undefined)
  const details = result.details as {
    results: Array<{ id: string; name: string; summary: string }>
  }
  // Matching is a substring search over id/name/summary, so wrappers that merely
  // mention FastQC (e.g. the QC/trim subworkflow) are legitimate hits too.
  assert.ok(details.results.some((item) => item.id === 'nf-core/modules/fastqc'))
  for (const item of details.results) {
    assert.match(`${item.id} ${item.name} ${item.summary}`.toLowerCase(), /fastqc/)
  }
  assert.ok(details.results.length < listWrapperCompositionCatalog().length)
})

test('wrapper_inspect returns the composition manifest plus default params', async () => {
  resetWrapperCompositionCatalogCache()

  const result = await buildWrapperCompositionInspectTool().execute('call-1', {
    id: 'nf-core/modules/fastqc'
  })

  assert.equal(result.isError, undefined)
  const details = result.details as {
    manifest: { id: string; params: Record<string, unknown> }
    defaultParams: Record<string, unknown>
  }
  assert.equal(details.manifest.id, 'nf-core/modules/fastqc')
  assert.deepEqual(details.defaultParams, {
    reads: 'tests/data/test_{1,2}.fastq.gz',
    outdir: 'results'
  })
})

test('composition tools expose the generic wrapper workflow only', () => {
  assert.deepEqual(
    buildWrapperCompositionTools(new WrapperJobManager()).map((tool) => tool.name),
    [
      'wrapper_search',
      'wrapper_inspect',
      'wrapper_run',
      'wrapper_status',
      'wrapper_wait',
      'wrapper_cancel'
    ]
  )
})

test('composition manifest parser rejects invalid param kinds', () => {
  assert.throws(
    () =>
      parseWrapperCompositionManifest(`
id: acme/tools/bad
name: Bad
summary: Invalid
params:
  reads:
    kind: file
    type: fastq_glob
outputs:
  reports:
    type: directory
    path: results
`),
    /kind must be input, output, or option/
  )
})

test('every bundled wrapper passes validation with its own default params', () => {
  resetWrapperCompositionCatalogCache()

  for (const entry of listWrapperCompositionCatalog()) {
    const defaults = JSON.parse(
      readFileSync(join(entry.wrapperDir, 'params.json'), 'utf-8')
    ) as Record<string, unknown>
    assert.deepEqual(
      validateWrapperParams(entry.manifest, defaults, {}, entry.componentDir),
      [],
      `${entry.manifest.id} default params should validate`
    )
  }
})

test('wrapper_run rejects invalid params before launching Nextflow', async () => {
  resetWrapperCompositionCatalogCache()
  const tool = buildWrapperCompositionRunTool(new WrapperJobManager())

  const unknown = await tool.execute('call-1', {
    id: 'nf-core/modules/fastqc',
    params: { read: 'x.fastq.gz' }
  })
  assert.equal(unknown.isError, true)
  assert.match(JSON.stringify(unknown.content), /Unknown parameter: read/)

  const plain = await tool.execute('call-2', {
    id: 'nf-core/modules/gffread',
    params: { gff: '/definitely/not/here.gff3' }
  })
  assert.equal(plain.isError, true)
  assert.match(JSON.stringify(plain.content), /input path does not exist/)
})
