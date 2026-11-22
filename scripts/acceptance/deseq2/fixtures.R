# Deterministic local data: six donors, two conditions, 1,400 tested genes.
output <- commandArgs(trailingOnly = TRUE)[1]
set.seed(2771)
n <- 1400L
donors <- 6L
genes <- sprintf("SYN%04d", seq_len(n))
samples <- c(paste0("C", seq_len(donors)), paste0("T", seq_len(donors)))
means <- sample(100:1500, n, replace = TRUE)
baseline <- matrix(rnbinom(n * donors, mu = rep(means, donors), size = 18), nrow = n)
noise <- matrix(sample(0:3, n * donors, replace = TRUE), nrow = n)
null <- cbind(baseline, baseline[, c(2:donors, 1)] + noise)
signal <- null
treated <- donors + seq_len(donors)
signal[1:50, treated] <- signal[1:50, treated] * 8L

write_tsv <- function(table, name) {
  write.table(table, file.path(output, name), sep = "\t", row.names = FALSE, quote = FALSE)
}
for (kind in c("positive", "zero")) {
  counts <- if (kind == "positive") signal else null
  colnames(counts) <- samples
  write_tsv(data.frame(gene_id = genes, counts), paste0(kind, ".tsv"))
}
metadata <- data.frame(sample = samples, condition = rep(c("control", "treated"), each = donors),
                       donor = rep(paste0("D", seq_len(donors)), 2))
write_tsv(metadata, "samples.tsv")
write_tsv(metadata[, 1:2], "no-donor.tsv")
gene_set <- function(term, ids) paste(c(term, "synthetic", ids), collapse = "\t")
writeLines(c(gene_set("SIGNAL", genes[1:50]), gene_set("OTHER", genes[51:100]),
             gene_set("BACKGROUND", genes[101:n])),
           file.path(output, "sets.gmt"))
