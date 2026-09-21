---
name: omics-visualization
description: >-
  Render, adapt, and audit publication-ready scientific figures from omics
  result tables and matrices using bundled canonical plotting templates and a
  Nature-style emphasis on claim, hierarchy, restraint, and final-size
  readability. Use when the user has transcriptomics, proteomics,
  metabolomics, enrichment, survival, network, or related omics data and asks
  to choose, create, revise, or export scatter, heatmap, bar, distribution,
  line, network, flow, hierarchy, clustering dendrogram, pathway-ring,
  gene-structure, or ideogram figures. Also trigger on 组学绘图、科研配图、论文图表、
  聚类树、通路环图、应力布局, SVG散点, 图标柱状图, 多通路富集热图, 通路分组富集热图, 富集点图, GO点图, 表达热图, 免疫相关热图, 关联点阵, 平行集合图, 泰森多边形, 条形甜甜圈, 环状比例图, 免疫棒棒糖, 环形棒棒糖, 基因结构, 核型图, 感兴趣基因, 火山图放大, UpSet, 韦恩图, Venn, 饱和突变热图, ΔΔG热图, oncoprint, 突变瀑布图, 基因组变异热图, 分块聚类热图, NMF相关热图, 环状热图, 相关气泡热图, 对角线分割热图, 环形UMAP, UMAP环图, 三元图, 三元相图, 相关散点矩阵, ggpairs, pairs plot, 泳道图, 游泳图, 脊线图, 山脊图, joyplot, RidgePlot, 基因组覆盖度, coverage track, locus browser, HiChIP, 突变棒棒糖, 蛋白棒棒糖, g3viz, MutationMapper, 蒲公英图, dandelion, Circos, 基因组环图, 共线性, synteny, 弦图, chord diagram, 基因组热图, 嵌套缩放, nested circos. Do not use for upstream statistical analysis,
  generic business dashboards, AI-generated illustrations, or creating and
  maintaining reusable template libraries.
---

# Omics Visualization

Use the bundled template library to create, revise, and audit figures from
existing omics results. Visualization is for making a data pattern,
distribution, comparison, or uncertainty easier to inspect and communicate; do
not make a chart merely because a chart was requested. Select templates from
the catalogs, not from memory. The selected canonical template determines the
implementation language.

Default to a Nature-style scientific figure: one defensible claim, the
smallest sufficient visual vocabulary, restrained color, readable typography at
the final physical size, and no decorative encodings. Treat this as a design
philosophy unless the user gives journal-specific submission rules.

## Route

1. State the visualization purpose before choosing a chart: what should become
   easier to see, compare, verify, or question after plotting? If the purpose is
   unclear, infer the smallest honest purpose from the user's request and data;
   ask only when several purposes would require materially different figures.
2. Inspect the user's data and scientific context. Continue only after the
   observation unit, relevant columns, comparison structure, and intended
   message are understood. Take a compact distribution snapshot: row/column
   count, variable types, categorical cardinality/order, numeric range/skew,
   missing/non-finite values, zeros/sparsity, duplicated identifiers, and any
   pairing, time, hierarchy, genomic interval, network, or matrix structure.
3. Write or infer a one-sentence figure claim before selecting geometry. A
   single composite glyph (for example a circular tree inset in a polar track)
   is still one template. Follow **Multi-panel composition** only for labelled
   a/b/c figures that combine several plots with distinct evidence roles.
4. For simple preview work, exact template-id requests, or high-frequency
   shapes, first run the lightweight contract router instead of opening every
   catalog:

   ```bash
   python3 scripts/route_template.py --input <table.tsv> --query "<user purpose>" --mode preview --json
   ```

   The router uses [references/template_contracts.json](references/template_contracts.json)
   to profile generic entities, features, items, categories, supplied
   associations, and significance columns. It also scans recognized companion
   files in the input directory, such as `nodes.tsv`, `links.tsv`,
   `rowInfo.tsv`, `colInfo.tsv`, `enrichment.tsv`, `cytoband.tsv`,
   `domains.tsv`, and `karyotype.tsv`; use `--sidecar-dir` when those files
   live elsewhere. The router reports `sidecar_alignment` for reusable ID
   relationships such as matrix rows to row annotations, matrix columns to
   sample annotations, and node IDs to link endpoints. Alignment warnings lower
   sidecar-dependent template confidence; they do not authorize silent
   filtering, reordering, imputation, or upstream statistical analysis. It must
   not rely on gene-specific routing rules. A high-confidence result is a
   shortlist, not permission to skip the selected catalog entry and script.
5. If the router is low confidence, if several viable templates would change
   the scientific reading, or if the output is publication-critical, read
   [references/plots.yaml](references/plots.yaml) and then only the relevant
   family catalog under `references/catalog/`. Compare `use_when`,
   `avoid_when`, and `input_shape`. If one template clearly matches the
   purpose, distribution, claim, and data contract, proceed with it and record
   the reason. If several viable templates would trade off overview/detail,
   show up to four candidates with their preview, `id`, why it fits, why it
   might mislead, and expected input shape; let the user choose among those
   material alternatives.
6. Select one canonical template and read its `plot.R` in full. Also read every
   helper it sources before modifying or executing it. Current templates use
   [scripts/lib/common.R](scripts/lib/common.R).
7. Pick colors from [references/palettes.yaml](references/palettes.yaml).
   Copy hex from that file or from
   [references/palettes/colors.json](references/palettes/colors.json).
   Do not invent hex codes. Prefer `Qualitative.Safe` for discrete groups,
   `Quantitative.BluGrn` for heatmaps, and `Diverging.RdBu` for signed values,
   unless the user names a palette or asks to match OmicsAgent (`Brand.Algolia`)
   or an existing figure. Reserve saturated color for the focal comparison and
   keep secondary marks neutral when the template permits it.
8. Create a project-local working copy of the selected visible plotting source.
   Project-local means under the active Phi project working directory, not the
   input data file's parent directory. Treat data directories outside the
   project as read-only inputs even if the shell can technically write there.
   Keep generated figures, adapted source files, scratch files, reports, and
   QA artifacts under the project working directory so Phi can preview/open
   them. If no output directory is specified, create a concise directory such
   as `visualizations/<short-task-name>/` or `plots/<short-task-name>/` inside
   the project.
   For current R templates, copy the selected `plot.R` and prefer sourcing the
   installed read-only helper directly from
   `scripts/lib/common.R` with an absolute path. If the helper itself must be
   edited for a one-off task, copy only that helper into the project and set
   `OMICS_VISUALIZATION_SKILL_ROOT` to the installed skill root before running.
   Do not copy `references/`, `references/palettes/`, or catalog files into the
   project merely to make palette lookup work; choose palette ids from the
   installed references and leave those catalog resources in the skill.
   Do not edit the installed skill copy during an ordinary plotting task.
9. Adapt the visible source directly:
   - edit `CONFIG` for column mappings, labels, and ordinary presentation
     (`circular`, `outer = "bar"` vs `"point"`, hole, inset, SVG file).
     A layout flag or a different glyph file is not a new template id.
   - edit `DATA PREPARATION` when the input shape differs;
   - edit `PLOT` for structural visual changes.
   Do not introduce an external plotting configuration DSL.
   Do not add a sibling template that only changes `layout`, `circular`,
   an algorithm alias (kk / fr / lgl), or the SVG glyph file.
10. Set the final output size before polishing. For manuscript-like output,
   read [references/nature-figure-principles.md](references/nature-figure-principles.md)
   and apply only the parts relevant to the selected template.
11. Run the project-local source against the user's data using the usage command
   documented at the top of the script. If dependencies are missing, report
   them; do not install packages without authorization and do not silently
   switch implementations.
12. Run lightweight single-plot artifact QA, then inspect the rendered artifact
   at final size:

   ```bash
   python3 scripts/qa_single_plot.py <artifact.png-or.svg> --json
   ```

   Correct labels, scales, legends, clipping, overlaps, spacing, and
   misleading encodings, then rerun until the output and source agree.

Routing is complete only when the chosen template, its input assumptions,
implementation language, sourced helpers, and runnable project-local copy are
known. When the contract router is used, delivery notes should include the
recommended template id, confidence, decisive matched shape, and any listed
risk that had to be checked. Delivery is complete only after the final rendered
artifact has passed lightweight QA and visual inspection.

## Efficient use

- Use `scripts/route_template.py` as the fast path for preview-mode and
  common result-table shapes. Trust high-confidence contract recommendations
  enough to avoid reading unrelated family catalogs, but still confirm the
  selected catalog entry and `plot.R` before rendering.
- Trust `references/plots.yaml` and the family catalogs for low-confidence,
  publication, or novel shapes. Do not search the template scripts by text
  unless a catalog entry is missing, stale, or internally inconsistent.
- When adding or editing routing contracts, run
  `python3 scripts/validate_template_contracts.py --json` before delivery.
  The validator must pass with no errors; warnings require an explicit note.
  Use the text report with `--max-missing-per-family 3` to prioritize future
  contract coverage without manually scanning the whole catalog.
- When the user names an exact template id, or the data shape leaves one clear
  candidate, proceed without a candidate-selection pause.
- Do not render every candidate. Use shipped previews for material alternatives,
  then run only the chosen project-local source.
- Prefer `CONFIG` edits, label tightening, scale changes, and legend pruning
  before touching the `PLOT` section. Structural rewrites are for misleading
  geometry, not ordinary polish.
- Keep final QA proportional: single plots get `qa_single_plot.py` plus a
  final-size visual inspection; labelled multi-panel figures also get the
  Patchwork geometry audit.

## Nature-style figure defaults

- Argument first: every figure should answer one claim or one bounded
  comparison. Remove panels, labels, encodings, and legends that do not help a
  reader evaluate that claim.
- Restraint over decoration: no ornamental gradients, busy backgrounds,
  gratuitous icons, or palette changes that encode nothing. Use whitespace and
  alignment as the main organizing devices.
- Typography is judged at final size. Use concise sentence-case labels with
  units; avoid local panel titles when the caption can carry the narrative.
  As a practical default, keep tick labels at least 6 pt, axis and legend text
  at least 7 pt, and panel letters 8-10 pt bold.
- Hierarchy should be visible before details. Give the decisive evidence the
  most space or clearest contrast; make controls, references, and secondary
  strata quieter but still legible.
- Encodings must be biologically and statistically honest. Prefer effect size
  plus uncertainty when supplied; avoid summary bars for distributions when a
  raw-point, interval, boxplot, violin, raincloud, or ridge template better
  exposes the data shape.
- Template choice follows the data. Do not force a requested chart type when
  the distribution snapshot shows it would hide sample size, censoring,
  sparsity, outliers, paired structure, or uncertainty that the figure purpose
  depends on; recommend a better-fitting catalog template and explain the
  tradeoff.
- Color must survive reduction and color-vision checks. Use catalog palettes,
  avoid rainbow/jet and pure red-green dependence, and add redundant shape,
  linetype, label, or ordering when color carries a critical distinction.

## Easy mis-routes

Confirm against the family catalog. These pairs share vocabulary but not
geometry:

- Ranked enrichment list → `bar-enrichment-*`. Classic GO/KEGG
  dotplot (x = gene ratio, size = Count, fill = −log10(p)) →
  `bar-enrichment-dot`. Facet by ontology is CONFIG. Supplied class
  → term tree with Count and p on a circumferential track →
  `tree-enrichment-ring`.
  That figure is one template, not a multi-panel layout. Polar track plus
  circular dendrogram are combined with inset_element; do not treat them
  as two catalog ids. A DE expression heatmap whose right-hand panels are
  enrichment bars aligned to Up/Down gene splits → `heatmap-enrichment-zoom`.
  Extra databases are extra rows in the enrichment table, not extra ids.
  The same terms across contrasts, fill = signed −log10(p), missing
  cells marked not tested → `heatmap-enrichment-terms`. Do not run
  enricher or convert species in the script. That is not
  heatmap-enrichment-zoom and not heatmap-corr-dot.
  Rectangular association of two category axes with supplied rho and p,
  colour = rho, shape = p cutoff → `heatmap-corr-dot`. Do not compute
  Spearman in the script. That is not heatmap-signif (square matrix
  from samples) and not heatmap-two (two variable sets from samples).
  Colour = rho, size = −log10(p) or a supplied magnitude, stars from
  supplied p → `heatmap-corr-bubble`. Facet columns or vline
  intercepts stay in CONFIG. That is not heatmap-corr-dot (shape
  encodes the p cutoff). Do not compute Spearman in the script.
  Each cell split on the diagonal, two continuous fills (supplied
  coefficient and p) → `heatmap-corr-triangle`. Optional p-dots
  stay in CONFIG. That is not heatmap-corr-dot or
  heatmap-corr-bubble. Do not compute Spearman or impute missing
  pairs in the script.
  Site × amino-acid ΔΔG tiles with a dual-y mean overlay →
  `heatmap-mutation-energy`. That is one template, not heatmap-basic
  plus a line chart. Do not interpolate tiles or estimate energies
  in the script. Mean ΔΔG is the mean of the supplied cells at that
  site. A protein-residue lollipop with class pies is
  `ideogram-lollipop`, not this heatmap. Gene × sample layered
  alteration glyphs (CNV fill, mutation bar, frequency bars) →
  `heatmap-oncoprint`. That is not heatmap-mutation-energy, not
  ideogram-lollipop, and not bar-waterfall. Glyph and bar side
  stay in CONFIG. Do not parse MAF or fetch cBioPortal in the
  script.
  A supplied rectangular score or Pearson matrix clustered with
  dendrograms cut into k blocks and an optional row-group strip →
  `heatmap-cluster-block`. That is not heatmap-cluster-basic (those
  rows are z-scored samples). Do not compute correlation in the
  script. cutree k stays in CONFIG.
  A circular heatmap whose sectors are a supplied Group, with optional
  q-value diamonds and an Euler hole → `heatmap-circos-split`. That is
  one template, not heatmap-basic plus a Venn. inner and the q-value
  track are CONFIG. Do not cluster or rescale in the script.
- Named parent/path hierarchy → `tree-basic`. Numeric matrix clustered with
  dist + hclust → `tree-dendrogram`. `circular = TRUE` stays in CONFIG.
- Supplied node x/y → `graph-force`, `graph-basic`, or `graph-cartesian`.
  Edge table with a computed layout → `graph-stress`. `graph-force` uses
  `layout = "manual"`; it does not run a force algorithm.
  Equal-spacing single-ring nodes → `graph-circular`. Hub nodes on an
  inner ring plus category-grouped outer nodes with class-coloured
  weighted edges → `graph-circular-concentric`. That is not
  graph-circular and not graph-chord.
- Sunburst when ring **angle** encodes descendant size. Outer bar height or
  point size is not a sunburst. A circos stacked doughnut of within-group
  composition with radial bars on the inner track → `pie-doughnut-bar`.
  That is one template; sector width and item labels stay in CONFIG.
- Ordinary pch scatter → `scatter-group`. SVG glyphs at x-y → `scatter-svg`.
  A supplied UMAP in a circos whose sectors are cell types, with
  stacked metadata rings → `scatter-umap-circos`. Extra tracks and
  `scale = "log10"` vs `"linear"` stay in CONFIG. Do not run UMAP or
  wrap plot1cell. A doughnut without embedding is `pie-doughnut-bar`.
  Three non-negative components as a composition (one point in a
  simplex) → `scatter-ternary`. That is not scatter-group. Discrete vs
  continuous colour, and optional size, stay in CONFIG. Do not compute
  lineage scores, NMF, relative abundance, enrichment, or absorption
  probabilities in the script. Closing a + b + c to 1 is a display
  transform. Ternary KDE / percentile density bands are not this id.
  Several numeric columns as a pairs grid (lower scatter + lm,
  diagonal names, upper Pearson r tiles) → `scatter-pairs`. That is
  not scatter-matrix (category × category bubbles) and not
  scatter-correlation (one pair). More than about 12 variables →
  `heatmap-signif`. Method and gap stay in CONFIG. Do not run DE or
  enrichment in the script.
  Category SVG instead of bar y-axis text → `bar-svg-icon`. Changing the
  SVG file is CONFIG, not a new id. A signed delta lollipop (stem through
  zero, point size = -log10(p), fill = signature set) →
  `scatter-lollipop-delta`. That is not scatter-cleveland and not a
  dumbbell. Do not add an id per immune deconvolution method.
  Grouped circular lollipops with sector fans, radial error bars, and
  outer group labels → `scatter-lollipop-circular`. That is not
  scatter-lollipop-polar (plain polar stems) and not
  scatter-lollipop-radial (a fan). se is supplied; do not compute it
  in the script. Subgroup names sit in the points. Point radius is
  the mean; whiskers are se. Do not print numeric mean labels.
  Mutations on a protein amino-acid axis (stems, pie or circle heads,
  domain bar) → `ideogram-lollipop`. That is not scatter-lollipop-delta,
  scatter-rank, or scatter-cleveland. Pie vs circle is CONFIG. Do not
  parse MAF, fetch cBioPortal, or look up Pfam in the script. A gene ×
  sample oncoprint is `heatmap-oncoprint`, not ideogram-lollipop.
  Dense sites collapsed into clustered dandelions (stem = cluster
  size or mean score; fan / pie / circle / pin heads) →
  `ideogram-dandelion`. That is not ideogram-lollipop (one stem per
  site) and not ideogram-density. type and maxgaps are CONFIG. Do
  not fetch TxDb, UCSC, or VCF in the script.
- Transcript exon / CDS / UTR tracks → `ideogram-gene`. Chromosome
  G-banding with no loci → `ideogram-karyotype`. Window statistic fill
  along a chromosome → `ideogram-density`. A supplied gene-loci table
  (points + names, colour by category) → `ideogram-loci`. Catalog
  preview is circular. Vertical vs circular is `config$layout`, not a
  second id. `coord_flip` and hg19 vs hg38 stay in CONFIG / the
  cytoband sidecar. Stacked coverage on one genomic window (scATAC /
  HiChIP / ChIP signal, optional loop arcs and gene bars) →
  `ideogram-coverage`. Extra tracks, a highlight, and loops on/off
  are CONFIG / sidecars. That is not ideogram-density, not
  ideogram-gene, and not line-*. Do not call peaks, loops, MACS, or
  Hi-C in the script. Protein mutation lollipops are
  `ideogram-lollipop`, not ideogram-gene. Dense clustered dandelions
  are `ideogram-dandelion`, not ideogram-lollipop.
  One genome as circular sectors with concentric tracks
  (histogram / scatter / line) and optional SV links →
  `ideogram-circos`. Extra tracks and links on/off are CONFIG.
  Do not call CNV or density in the script. Two assemblies with
  homology ribbons → `ideogram-synteny`. That is not
  ideogram-circos and not graph-chord. Do not run BLAST in
  the script. A Circos chord whose sector width is total flow
  → `graph-chord`. Equal-spacing circular nodes are
  graph-circular. Genomic links on an ideogram are
  ideogram-circos. Genomic interval tiles with connector
  lines → `ideogram-circos-heatmap`. That is not
  heatmap-circos-split. side inside/outside is CONFIG. Do
  not call peaks or z-score in the script. An outer genome
  plus inner zoom windows joined by correspondence →
  `ideogram-nested`. Extra windows are extra rows. Do not
  call DMR in the script. That is not ideogram-circos.
- Signed network: colour encodes sign of supplied corr, width encodes
  `|corr|`. Do not compute correlation in the script. Label size is fixed
  and readable; do not bind it to `|corr|` or tile area.
  Several categorical columns plus a supplied count as parallel-axis
  ribbons → `sankey-parallel-sets`. That is not sankey-basic or
  sankey-level (those take a source-target edge list). Do not tabulate
  raw samples in the script.
  Supplied x-y points filled as nearest-site tiles → `scatter-voronoi`.
  That is not scatter-group (points only) and not scatter-contour
  (convex hull). Do not run PCA, UMAP, or clustering in the script.
  Tile area is not density.
  Overview volcano → `scatter-volcano`. Rectangular zoom plus a densely
  labelled inset of that window → `scatter-volcano-inset`. That is one
  template, not a multi-panel a/b layout and not a CONFIG flag on
  scatter-volcano. Do not run DE in the script.
  Combination membership with top intersection-size bars and left set-size
  bars → `bar-upset`. Two bar series (observed vs expected) and matrix
  colour by n-sets stay on this id. That is one template, not a
  multi-panel layout. Do not tabulate raw samples or compute expected
  counts in the script. Overlapping circles of 2–4 supplied sets →
  `bar-venn`. Percentage and element-name labels stay in CONFIG. Five
  or more sets stay on `bar-upset`. Do not add an id per ggvenn / venn
  package or for a 5–7 petal Venn.
  One lane per patient on a time axis, treatment intervals as
  rectangles, response points and stop marks → `bar-swimmer`. Extra
  treatments and left-hand annotation tiles stay in CONFIG. That is
  not bar-stack, not scatter-dumbbell, and not line-survival. Do not
  convert dates or call response in the script.
  Stacked 1D density ridges by group, optionally faceted by feature →
  `line-ridge`. That is not boxplot-violin (mirrored density) and not
  a raincloud. Marker facets and left group bars stay in CONFIG. Do
  not cluster cells or pool an All-cells row in the script; that
  group is supplied. The vertical tick is a display quantile of the
  supplied values. Genome-coordinate coverage tracks are
  `ideogram-coverage`, not line-ridge.
  Normal vs Tumor (or any two-level contrast) across many cancer
  types with alternating background bands and per-category stars →
  `boxplot-differential-bg`. That is not boxplot-group and not
  boxplot-differential-expression. show_ns stays in CONFIG. Do not
  filter matched patients or run DE in the script.

## Multi-panel composition

For a labelled multi-panel figure, figure assembly, or rearrangement of several
plots:

1. Read
   [references/multipanel-composition.md](references/multipanel-composition.md)
   and write the figure-level claim, panel sequence, evidence role of every
   panel, hero panel, and shared encodings before drawing.
2. Apply the necessity test. Merge, move, or omit a panel that adds no unique
   inferential step; do not arrange repeated metrics as a dashboard by default.
3. Route each necessary panel through `references/plots.yaml` and only the
   relevant family catalogs. Select one canonical template for each panel.
4. Read [references/layouts.yaml](references/layouts.yaml), inspect only viable
   layout previews, and choose a layout whose `use_when` matches the evidence
   hierarchy and whose `avoid_when` does not apply.
5. Read the selected `compose.R` and
   [scripts/layouts/lib/layout_common.R](scripts/layouts/lib/layout_common.R)
   in full. Create a project-local copy under the active Phi project working
   directory containing the composition source and its selected panel sources;
   prefer sourcing installed read-only helpers by absolute path. Copy
   `common.R` or `layout_common.R` only when a one-off helper edit is required,
   and do not copy `references/` or palette catalogs.
6. Replace the layout template's demo panel objects with the real project-local
   plot objects. Edit the visible Patchwork design directly; do not create a
   layout DSL or rasterize vector panels merely to arrange them.
7. Render at final physical size. Run `audit_patchwork_layout()` and preserve
   its `.layout-audit.json` beside the figure. A `FAIL` or `NOT_AUDITABLE`
   result blocks any claim that alignment passed.
8. Follow
   [references/rendered-layout-qa.md](references/rendered-layout-qa.md), inspect
   the complete figure and every panel, then rerender and reaudit after any
   change to text, legends, axes, annotations, panel size, or layout.

Multi-panel delivery is complete only when every panel has a distinct evidence
role, the rendered geometry audit passes, and the final-size visual inspection
finds no unresolved clipping, collision, hierarchy, or reading-order defect.

## Language boundary

Do not search for or create a duplicate bundled implementation in another
language. If the user explicitly requires a language not represented by the
selected canonical template, state that limitation and create a project-local
implementation only when it is necessary to satisfy the request; do not add it
to the bundled library as a second canonical template.

## Scientific integrity

- Do not invent sample sizes, statistical tests, p-values, adjusted p-values,
  effect sizes, uncertainty, group mappings, or biological interpretations.
- Do not silently filter, aggregate, impute, clip, coerce, or sample data.
  Report every material transformation and its before-and-after row count.
- Preserve identifiers and biological units. Flag duplicated identifiers,
  missing values, non-finite values, invalid ranges, and ambiguous columns
  before plotting.
- Distinguish raw from adjusted p-values and technical from biological
  replicates. Do not infer biological importance from visual or statistical
  separation alone.
- If the figure requires upstream analysis that has not been performed,
  identify that prerequisite instead of fabricating results.
- Display clustering (dist + hclust on a supplied matrix) is allowed when
  that is the figure (`tree-dendrogram`, clustered heatmaps). Do not present
  it as an independent statistical result, and do not invent the matrix.
- Use catalog palettes. Do not invent hex. Do not interpolate hex when a
  palette is too short; `palette_colors()` appends unused Qualitative then
  Brand colours. Do not use Artwork or Concept palettes unless the user
  asks for a decorative theme.
- Plot canvases are transparent. A dark editor makes empty alpha look black;
  that is not a black background and must not be “fixed.”

## Delivery

Return the final rendered figure and the exact project-local source used to
create it. Include the visualization purpose, selected template ID, selection
rationale, input-to-column mapping, material transformations, and unresolved
limitations in a concise handoff. Prefer SVG or PDF for editable scientific
graphics and add a PNG preview when useful. Do not claim rendering or visual
validation when either step was blocked.

## Scope

This skill applies existing templates to real data and revises or audits the
resulting figures. Creating, cataloging, testing, or maintaining reusable
templates belongs to a template-authoring workflow, not this skill.
