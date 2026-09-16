# Data notes — forecasting research corpus

Per-dataset integrity and fitness-for-purpose findings. Each entry records what was
actually measured, not what the distributor's documentation claims. Reproduce with the
script named in the entry.

Companion docs: [`forecasting-program.md`](forecasting-program.md) ·
[`forecasting-data-acquisition.md`](forecasting-data-acquisition.md)

---

## QTM template-matching catalog (Ross et al. 2019) — RECEIVED 2026-09-15

`qtm_final_12dev.hypo`, the 12× MAD high-confidence variant. Supplied by Jake from the
SCEDC distribution (`service.scedc.caltech.edu/ftp/QTMcatalog/`), since that host is
policy-blocked from the research container. DOI 10.7909/C3WD3xH1.

Reproduce: `python3 etl/characterize-qtm.py path/to/qtm_final_12dev.hypo`

### Integrity: clean

| Check | Result |
|---|---|
| Events | 898,597 |
| Span | 2008-01-01 → 2017-12-31 |
| Magnitude | −1.95 to 7.20 |
| Nulls | 0 |
| Duplicate rows (on time + position + magnitude) | 0 |
| Unique event IDs | 898,597 / 898,597 |
| Relocated | 67.7% |
| Distinct templates | 191,240 |
| Extent | 31.86–37.22 °N, −121.95 to −114.03 °E |
| Depth | median 8.39 km, p95 15.95 km, 2,469 above datum (normal) |

**Ground truth.** El Mayor-Cucapah is present at M7.20, **1.4 km** from the USGS
reference location (32.286 °N, 115.295 °W). April 2010 carries 62,469 events against a
6,369-event median month — a 10× aftershock burst, as the physics requires.

**One coincidence, checked and cleared.** 2012 and 2013 report *identical* event counts
(76,932 each). This is chance: zero row-for-row matches, disjoint event-ID ranges,
different timestamps, and no duplicates anywhere in the catalog.

### Completeness: the headline is wrong region-wide, and this matters

The catalog is widely described as complete to **M0.3**. Taking that at face value across
the whole region yields a Gutenberg-Richter **b = 0.53** — far below any plausible
tectonic value (~0.9–1.0). Three independent estimators agree that no single region-wide
Mc describes this catalog:

- **b never plateaus below ~M2.3.** It climbs monotonically from 0.50 at M−0.4 to 0.87 at
  M2.5. A complete catalog shows b flat above Mc.
- **Goodness-of-fit (Wiemer & Wyss 1995) never reaches 95%** at any cutoff — best 93.2%.
  The FMD is not a single power law at any threshold.
- **MAXC+0.2 returns Mc = −0.05**, which is plainly too optimistic given the above.

**The cause is spatial mixing, not bad data.** On a 0.2° grid (59 cells with ≥2,000
events), Mc ranges from **−0.35 to 2.45 — a spread of 2.8 magnitude units** — with a
median of 0.25. Pooling cells whose completeness differs by nearly three orders of
magnitude flattens the low-magnitude end of the combined FMD and depresses apparent b.
Computing b per cell at a uniform conservative cutoff of M1.5 recovers the expected
tectonic value: **median b = 0.876, IQR 0.813–0.963**.

So the M0.3 headline is true *where the network is dense* and badly wrong elsewhere.

### Consequence for the program

This independently confirms that Stage 1's spatially-resolved **Mc(t, x) surface is not
optional**. Any region-wide Mc is wrong by up to 2.8 magnitude units somewhere in the
region, and every b-value, rate estimate and ETAS productivity parameter computed on top
of one inherits that error. A single-Mc analysis of this catalog would produce confidently
wrong numbers — which is the failure mode the whole program is built to avoid.

### Temporal behaviour

Completeness is stable across 2008–2017 (Mc −0.05 to 0.25 by MAXC+0.2), with one
expected exception: **2010 shows elevated Mc (0.25) and depressed b (0.657)** — El
Mayor-Cucapah's short-term aftershock incompleteness, the precise effect Stage 2's B3b
correction targets. This makes 2010 a natural test case for that component.

**Open flag, not yet explained.** b at a fixed M1.5 cutoff drifts upward over the decade:
0.715 (2008) → 0.849 (2017), outside the Shi & Bolt uncertainty. Candidates are network
densification, template-set growth, or a real change. Resolve before using cross-year
b-values as a feature; it is a plausible confound for any b-value-based signal.

### Durability

The container this was analysed in is ephemeral and the 99.7 MB file does not survive it,
nor does it belong in git. The catalog needs a durable home before Stage 0 begins — a
GitHub release asset (2 GB limit, reachable from the research container) is the
recommended route.
