# Methodology — Earthquake Occurrence Probabilities

This document specifies, at a level intended to survive academic scrutiny, exactly how every
number shown by the Disaster Probability Tracker is computed: the data, the estimators, the
model-selection rules, the validation, and the limitations. Nothing in the app is produced by
any method not described here.

**One sentence version:** the app reports *long-run statistical occurrence frequencies* of
earthquakes, computed from complete portions of merged instrumental catalogs with exact
uncertainty, under a homogeneous Poisson model (default) and a Gamma renewal model
(time-dependent view) — it does not, and cannot, predict individual earthquakes.

---

## 1. Data

### 1.1 Sources

| Era | Source | Magnitudes | License |
|---|---|---|---|
| 2000-01-01 → 2024-01-08 | USGS ANSS Comprehensive Catalog (ComCat), M4.5+, all depths, `type=earthquake` only | ComCat preferred magnitudes (mww/mwc/mwb/mb…) | Public domain (US Gov) |
| 1900 → 1999 | ISC-GEM Global Instrumental Earthquake Catalogue (uniformly re-processed Mw), via the Swiss Re Historical Earthquake Statistics Dataset | Mw | CC BY-SA 3.0 |
| 2024-01-09 → 2025-06-05 ("bridge") | ComCat M5.5+, depth ≤ 70 km, via the Swiss Re dataset | ComCat preferred | Public domain |
| runtime → today | Live USGS FDSN event query (M5+), fetched by the browser and cached locally; **replaces** the bridge segment entirely when online | ComCat preferred | Public domain |
| 10 AD → 1899 | NGDC/WDS Significant Earthquake Database, via the Swiss Re dataset | mixed/unknown | Public domain |

Merge rules are hard cutovers by date (no fuzzy dedup needed): ISC-GEM before 2000, ComCat CSV
from 2000, Swiss Re/ComCat bridge after the CSV ends, live top-up after that. Rows without a
usable magnitude are excluded from all statistics. The pre-1900 NGDC record is **display context
only** — it is a *damage-selected* catalog (deaths, damage, tsunamis), not a complete sample of
seismicity, and it never enters any rate computation.

### 1.2 Completeness windows

A catalog is "complete at magnitude m" from the date after which essentially every event ≥ m on
Earth was detected and cataloged. Using data before that date biases rates low. Following the
ISC-GEM documentation (Storchak et al. 2013) and standard practice:

| Threshold | Complete from |
|---|---|
| M ≥ 7.5 | 1900 |
| M ≥ 6.5 | 1918 |
| M ≥ 5.5 | 1964 |
| M ≥ 4.5 | 2000 (ComCat era) |

Every rate for threshold m is computed **only inside the longest window complete at m**; this is
why different magnitudes legitimately use different observation spans. Additionally, the
[4.5, 5.0) band is capped at the bundled ComCat end date (2024-01-08) because the live top-up
fetches M5+ only; and when the app is fully offline, all statistics are evaluated *as of the
bundled data edge* rather than today, so quiet time that is merely un-cataloged is never counted
as real quiet time.

These windows are conservative globally. For a specific well-instrumented region (California,
Japan) local completeness is better than this; for mid-ocean ridges before 1964 it can be worse.

## 2. Estimators

### 2.1 Empirical exceedance rates (the primary object)

For threshold m with n events observed over T complete years, the annual rate is λ̂ = n/T, with
the **exact (Garwood 1936) Poisson confidence interval**:

```
λ_lo = χ²(α/2, 2n) / 2T          (0 when n = 0)
λ_hi = χ²(1 − α/2, 2n + 2) / 2T
```

computed from a full implementation of the regularized incomplete gamma function (verified in the
test suite against standard χ² tables). This interval is honest at any n, including n = 0 and
n = 4 — which matters, because the interesting thresholds are exactly the rare ones.

### 2.2 Gutenberg–Richter b-value

The magnitude–frequency relation log₁₀ N(≥M) = a − bM (Gutenberg & Richter 1944) is fitted by the
Aki–Utsu maximum-likelihood estimator with the Tinti & Mulargia (1987) correction for
0.1-magnitude binning:

```
b̂ = log₁₀(e) / ( M̄ − (Mc − ΔM/2) ),   ΔM = 0.1
```

with the Shi & Bolt (1982) standard error. The fit uses **only the homogeneous modern era**
(2000 → catalog end, magnitudes from a single cataloging regime) above the completeness magnitude
Mc. Globally Mc = 4.5 (catalog floor); regionally Mc is estimated by maximum curvature (Wiemer &
Wyss 2000) + 0.2. The global fit on the shipped data gives **b = 1.14 ± 0.003** — slightly above
the canonical ~1.0 because ComCat preferred magnitudes mix mb (which saturates) with Mw; this is
a documented property of mixed-type catalogs, and the b-value is used only for interpolation and
regional scaling, never to override empirical counts (§ 2.4).

### 2.3 Tapered Gutenberg–Richter (large-magnitude tail)

A pure G-R line overpredicts M ≥ 9 rates because the Earth's plate system imposes a finite corner
moment. For extrapolation beyond robust empirical counts the app fits the **tapered
Pareto/Gutenberg–Richter distribution** (Kagan 2002) on seismic moments (Hanks & Kanamori 1979,
log₁₀M₀ = 1.5Mw + 9.05) of all M5.5+ events in the complete record: β fixed at (2/3)·b̂ (profile
likelihood), corner moment maximized by golden-section search. On the shipped data the corner
magnitude comes out **Mc ≈ 9.2**, consistent with published global estimates (Kagan's global
corner Mw ≈ 8.5–9.6 depending on zonation and era).

### 2.4 Rate-selection policy

For the headline number at threshold m:

1. **n ≥ 3 events in the complete window → the empirical rate**, with its exact CI. Counted
   reality beats any curve.
2. **n < 3, global scope → tapered G-R extrapolation**, flagged in the UI, with a widened
   uncertainty band (never narrower than the empirical exact CI).
3. **n < 3, local scope → fixed-b scaling**: the regional empirical rate at the largest locally
   robust threshold, scaled down by 10^(−b·Δm) with the global b (regional b is used instead when
   the region itself has ≥ 50 events above its Mc). Flagged in the UI.

The magnitude–frequency chart always shows the empirical points *and* the fitted curves together
with confidence whiskers, so the extrapolation is visually auditable.

## 3. Probability models

### 3.1 Poisson (default)

P(≥1 event in the next T years) = 1 − e^(−λT). The homogeneous Poisson model is the standard
null model for large-earthquake occurrence at global and regional scale (Kagan & Jackson 1991;
Michael 2011). The 95% band shown is the rate CI propagated through this formula. Scrubbing the
time slider widens T — the probability rise you see is *cumulative window probability*, which is
the statistically meaningful quantity (under Poisson, the hazard per unit time never rises no
matter how long it has been quiet).

### 3.2 Renewal ("overdue" view) — and why it usually refuses to say "overdue"

The colloquial "overdue" intuition is a renewal-process claim: inter-event times follow some
distribution, and the conditional probability of an event given elapsed quiet time τ is

```
P(event in (τ, τ+T] | quiet until τ) = [F(τ+T) − F(τ)] / [1 − F(τ)]
```

The app fits a **Gamma distribution to the observed inter-event times** by full MLE (Newton
iteration on the digamma equation, Minka initialization), inside the same completeness window,
and evaluates that conditional probability at the actual current open interval. It requires ≥ 8
observed intervals; below that it reports "n/a" rather than fitting noise.

The shape parameter is the verdict. CV = 1/√k:

- **CV ≈ 1** → exponential → memoryless → "overdue" is meaningless.
- **CV > 1** → *clustered* (aftershock sequences, triggering): a long quiet spell makes the
  near-term probability slightly **lower**, the opposite of overdue.
- **CV < 1** → quasi-periodic: quiet time genuinely raises the hazard.

On real data, global inter-event CVs at every threshold are **> 1** (1.2–1.9 on the shipped
catalog): world seismicity clusters. Genuine quasi-periodic "overdue" behavior is an
individual-fault phenomenon (e.g., the Brownian Passage Time models used for specific fault
segments in UCERF3, Matthews et al. 2002; Field et al. 2015) and requires paleoseismic recurrence
data that no instrumental catalog contains. The app says exactly this in the UI instead of
manufacturing a rising "overdue meter" that the data do not support. This is the difference
between a tool that can be scrutinized and one that flatters intuition.

Aftershock note: rates are **total seismicity, not declustered**. For the question the app
answers — "will at least one event ≥ m occur?" — total rates are the right choice; they slightly
inflate short-window probabilities immediately after large events (when clustered hazard really
is elevated). A declustered/ETAS view is a documented possible extension, not a correction.

### 3.3 Regional method

A local area is a great-circle disc (haversine distance ≤ radius). Rates use the same
completeness windows, on events inside the disc. b is fitted regionally when the disc has ≥ 50
events above its estimated Mc, otherwise global b with regional anchoring (§ 2.4.3). When the
requested magnitude exceeds anything observed in the disc, the number shown is an extrapolation
and the UI flags that whether the local tectonics can produce such an event is a *geological*
question the catalog cannot answer.

## 4. Validation

The test suite (`test/engine.test.mjs`, 24 tests, run in CI-able Node) pins:

- special functions against χ² tables, Γ identities, digamma values;
- estimator recovery on synthetic data (G-R b on binned exponential samples; Gamma MLE on
  simulated Gamma variates; memorylessness of the exponential renewal case);
- **the shipped catalog against published benchmarks**:

| Quantity | This app | Published |
|---|---|---|
| Global b (modern era) | 1.14 ± 0.003 | ~0.9–1.2 (mixed-magnitude catalogs) |
| λ(M ≥ 7) | 13.3 /yr | USGS long-term average ~15 /yr |
| λ(M ≥ 8) | 0.88 /yr | ~1 /yr |
| M ≥ 9 events since 1900 | 4 (1960, 1964, 2004, 2011; 1952 Kamchatka is Mw 8.8 in this ISC-GEM edition) | 4–5 depending on catalog |
| P(M ≥ 9 anywhere, 1 yr) | 3.1% [0.9%, 7.8%] | ~3–5% (Poisson on the same record) |
| TGR corner magnitude | 9.2 | 8.5–9.6 (Kagan 2002 and successors) |
| P(M ≥ 5 within 200 km of Draper UT, 50 yr) | ~89% | UWG-2016 Wasatch Front M5+ 50-yr: 93% |

The Draper M5 agreement is genuine cross-validation: the Utah Working Group number folds in
paleoseismology, ours is instrumental-only, and at M5 the instrumental record is dense enough
that they converge. At M6.75+ they diverge (UWG 43%/50 yr vs. a few percent here) — exactly the
short-record limitation § 5.2 documents, surfaced as a UI caveat within 300 km of the Wasatch.

## 5. Limitations (read before quoting any number)

1. **These are frequencies, not predictions.** Deterministic earthquake prediction (time, place,
   magnitude of a specific future event) does not exist at any scientific standard.
2. **Short instrumental record vs. slow faults.** 60–125 years of catalog cannot constrain
   faults with 300–2,000-year recurrence (Wasatch, Cascadia, many intraplate zones). Instrumental
   rates *underestimate* large-magnitude hazard there; paleoseismic studies are the corrective,
   and regional hazard authorities (USGS NSHM, UWG, GEM) should be preferred for
   building-code-grade decisions.
3. **Magnitude heterogeneity.** ISC-GEM Mw before 2000, ComCat preferred magnitudes after.
   The b-value is fitted on the homogeneous era only, but cross-era rate comparisons at a fixed
   threshold inherit ~0.1-unit magnitude-scale noise.
4. **Depth truncation in the bridge segment** (M5.5+, ≤ 70 km, 2024→mid-2025): deep-focus events
   in that 17-month window are missing unless the live top-up is active (it usually is).
5. **Disc geometry** is a blunt instrument: probabilities scale with the area drawn, and a disc
   answers "near this point," not "on this fault" or "at this site" (no ground-motion modeling —
   this is occurrence probability, not shaking hazard, i.e., not a PSHA).
6. **No declustering / ETAS**: short-window probabilities right after a large regional event are
   conservative (elevated), by design.

## 6. References

- Aki, K. (1965). Maximum likelihood estimate of b in the formula log N = a − bM. *Bull. Earthq. Res. Inst.* 43.
- Field, E. H., et al. (2015). UCERF3: A synthesis. *BSSA* 105(2A).
- Garwood, F. (1936). Fiducial limits for the Poisson distribution. *Biometrika* 28.
- Gutenberg, B., & Richter, C. F. (1944). Frequency of earthquakes in California. *BSSA* 34.
- Hanks, T. C., & Kanamori, H. (1979). A moment magnitude scale. *JGR* 84.
- Kagan, Y. Y. (2002). Seismic moment distribution revisited: I. *GJI* 148.
- Kagan, Y. Y., & Jackson, D. D. (1991). Long-term earthquake clustering. *GJI* 104.
- Matthews, M. V., Ellsworth, W. L., & Reasenberg, P. A. (2002). A Brownian model for recurrent earthquakes. *BSSA* 92.
- Michael, A. J. (2011). Random variability explains apparent global clustering of large earthquakes. *GRL* 38.
- Shi, Y., & Bolt, B. A. (1982). The standard error of the magnitude-frequency b value. *BSSA* 72.
- Storchak, D. A., et al. (2013). Public release of the ISC-GEM Global Instrumental Earthquake Catalogue (1900–2009). *Seism. Res. Lett.* 84.
- Tinti, S., & Mulargia, F. (1987). Confidence intervals of b values for grouped magnitudes. *BSSA* 77.
- Wiemer, S., & Wyss, M. (2000). Minimum magnitude of completeness in earthquake catalogs. *BSSA* 90.
- Working Group on Utah Earthquake Probabilities (2016). *Earthquake probabilities for the Wasatch Front region.* Utah Geological Survey Misc. Pub. 16-3.

## 7. Kernel-smoothed regional rates

The hard circle used through v1.6 treats an epicenter 1 km outside the
radius as zero information and one 1 km inside as a full event: local rates
jump discontinuously as the pin moves, and small circles are dominated by
count noise. Since v1.7 the regional mode counts each epicenter
**fractionally, by the mass of an isotropic 2-D Gaussian kernel (σ = 50 km)
falling inside the circle** — exactly the integral over the query disc of
the kernel-density-estimated rate field, evaluated event-by-event in closed
form (the noncentral-χ²₂ CDF). This is smoothed seismicity in the tradition
of Frankel (1995), the construction behind the USGS national seismic hazard
maps' background rates, refined by Helmstetter, Kagan & Jackson (2007).
Effective counts are non-integer; the Garwood interval extends unchanged
(χ² quantiles accept non-integer degrees of freedom), and the regional
G-R b-value uses the weighted Aki–Utsu estimator. The event list, "last
one," renewal gaps, and max-observed still use actual in-circle events —
smoothing informs *rates*, not *history*.

**Validated, not assumed** (`backtest/spatial.mjs`, re-run in CI): on an
equal-area world grid (~18,300 cells), models fitted on training years
forecast per-cell M ≥ 5 counts in later years, scored by Poisson
log-likelihood with a shared 0.5% uniform water level. Bandwidth was
selected on 2000–2011 → 2012–2016 (adaptive k-NN k=2 best at +0.197
nats/event over raw cell counts; fixed σ = 50 km best fixed at +0.188),
then confirmed on held-out 2017–2024 (12,095 events): adaptive +0.105,
fixed σ = 50 km +0.097 nats/event. **The shipped configuration is fixed
σ = 50 km** — it keeps 92% of the adaptive gain with no per-event
bandwidth data to ship; adaptive smoothing is noted as a deferred marginal
improvement. Additional references: Frankel (1995), *Seism. Res. Lett.*
66(4); Helmstetter, Kagan & Jackson (2007), *Seism. Res. Lett.* 78(1);
Silverman (1986), *Density Estimation*; Zechar & Jordan (2008), *GJI* 172.

---

# Part II — Multi-hazard impact model (master dashboard)

The dashboard answers a different question than Part I: not "how often does an
earthquake of magnitude m occur here," but **"how often does *any* natural disaster
exceed a given human or economic impact, anywhere on Earth (or in the US)?"** The
statistical object is a marked multi-hazard point process filtered on impact marks.

## 8. Impact data

**EM-DAT**, the international disaster database (CRED / UCLouvain, Brussels —
www.emdat.be; Delforge et al. 2025), public table including historical events,
snapshot **2024-03-26** (obtained via the public copy committed in
`com-480-data-visualization/project-2024-DisasterClass`; EM-DAT terms: free for
non-commercial use with attribution — to refresh or re-license, register at
public.emdat.be and re-run `etl/build-impacts.mjs`).

Transformations (see `etl/build-impacts.mjs`):

- **Natural physical hazards only.** The Biological subgroup (epidemics,
  infestations) is excluded; so are technological disasters. Hazard classes:
  Earthquake (incl. tsunamis), Storm, Flood, Drought, Extreme temperature,
  Landslide, Wildfire, Volcanic activity, Other.
- **Country rows → physical events.** EM-DAT records one row per affected
  country; rows sharing a `DisNo.` prefix are aggregated (impacts summed) so
  "an event killing ≥ X" means the physical event (the 2004 Indian Ocean
  tsunami is one event with ~226k deaths across 12+ country rows, not 12
  smaller events). 26,443 rows → 13,571 physical events, 1900 → 2024-02.
- **US scope** keeps each event's US-portion impacts (ISO USA + PRI, VIR, GUM,
  ASM, MNP — Hurricane Maria's Puerto Rico toll belongs to US mode).
- **Damages** use EM-DAT's CPI-adjusted series (≈ 2024 US$).

## 9. Completeness windows (impact thresholds)

EM-DAT's coverage of small events improves enormously over time (79 recorded
events in the 1900s vs ~4,500 in the 2000s); large events are reliably
recorded much further back. Windows were chosen from a per-decade rate
stabilization analysis (the decade table is reproduced in the ETL comments):

| Threshold | Complete from | Empirical basis |
|---|---|---|
| ≥ 10 deaths | 2000 | rate plateaus ~1990s–2000s (~115–140/yr) |
| ≥ 100 deaths | 1990 | plateau ~20–28/yr from the 1980s |
| ≥ 1,000 deaths | 1930 | remarkably stable ~2–4/yr across the century |
| ≥ 10,000 deaths | 1900 | large events historically well recorded |
| ≥ $100M adj. damage | 2000 | damage reporting matures late |
| ≥ $1B adj. damage | 1990 | |

A threshold uses the window of the largest table entry ≤ it (conservative:
shorter windows widen CIs but avoid undercount bias).

## 10. The probability model

Per hazard h, the rate λ_h(X) is the count of qualifying events in the window
divided by its length, with exact Garwood CIs (§ 2.1). Hazards superpose:

```
P(≥1 event ≥ X within T) = 1 − exp( −Σ_h λ_h(X) · s_h(T) · T )
```

s_h(T) is a **seasonality factor**: a smoothed monthly climatology per hazard
(2000+, floor threshold for stable counts, ±1-month kernel, normalized to
mean 1), averaged over the actual forecast window. It matters only for
sub-annual windows (hurricane season is real: the Storm September factor
roughly doubles May) and converges to 1 for multi-year windows. Per-hazard
"share of risk" is λ_h·s_h / Σ λ·s.

No tail extrapolation is performed beyond observed impacts: thresholds with
zero qualifying events report "too rare to rate empirically" rather than a
fitted number. (A tapered severity-tail fit is a possible extension; the
heavy right tail of disaster deaths makes naive power-law extrapolation
irresponsible at the "quotable number" bar this project sets.)

## 11. Validation (Part II)

`test/impact.test.mjs` (14 tests) pins:

| Quantity | This app | Check |
|---|---|---|
| λ(deaths ≥ 100, global) | ~23/yr | decade-table plateau 20–28/yr |
| λ(deaths ≥ 10,000, global) | ~0.6/yr | century record 0.3–1.2/yr |
| 2004 Indian Ocean tsunami | 1 event, ~226k deaths, 12+ countries | aggregation correctness |
| Hurricane Katrina (US scope) | ~1,800 US deaths | EM-DAT US value |
| Storm seasonality | Sep ≫ May | NH hurricane season |
| Decomposition | Σ per-hazard λ = total λ exactly | superposition consistency |
| λ(damage ≥ $10B adj.) | ~2–3/yr | reinsurance-industry reporting range |

## 12. Limitations (Part II)

1. **Fixed snapshot.** The impact catalog ends 2024-02; there is no live feed
   (EM-DAT requires authenticated download). Long-run rates remain valid; the
   "most recent event" list does not extend past the snapshot.
2. **Non-stationarity, both directions.** Disaster *mortality* has declined
   for decades (early warning, response capacity) — death-based rates at
   extreme thresholds are dominated by early-century famines/floods and lean
   high as forecasts. *Damages* rise with exposure — damage-based rates lean
   low. The completeness windows bound but cannot remove this.
3. **Reporting selection.** EM-DAT entry requires ≥10 deaths, ≥100 affected,
   or a declaration/appeal; damage figures exist for only ~40% of events and
   skew toward insured, wealthy regions.
4. **Event aggregation** by DisNo prefix is exact for EM-DAT's own event
   identity; multi-week compound episodes (e.g., a monsoon season) may appear
   as several events.
5. **US cross-source redundancy** was evaluated against the tidyDisasters
   compilation (FEMA + EM-DAT merged) and rejected: that dataset duplicates
   national death tolls across state-level rows (Katrina sums to ~38,000),
   so it would corrupt rather than corroborate. NOAA Storm Events is the
   right future US enrichment source.

## 13. Additional references

- Delforge, D., et al. (2025). EM-DAT: the Emergency Events Database. *Int. J. Disaster Risk Reduction*.
- UNDRR & CRED (2020). *Human cost of disasters 2000–2019.*

---

# Part III — Deep history: what centuries can and cannot tell us

Part II's impact rates stop at 1900 because EM-DAT does. The deep-history layer
extends the record to ~2150 BC (earthquakes) and the early Holocene (eruptions),
with a strict separation between two uses:

## 14. Sources

- **NCEI/WDS Global Significant Earthquake Database** (NOAA/NCEI, public
  domain): destructive earthquakes 2150 BC → present with documentary death
  tolls, magnitudes, tsunami flags. Snapshot 2021-03 via the official TSV in
  `rsizem2/noaa-earthquakes`.
- **Smithsonian Global Volcanism Program, Volcanoes of the World**: confirmed
  Holocene eruptions with VEI, via the TidyTuesday 2020-05-12 extract.
  Citation: Global Volcanism Program, Smithsonian Institution (comp. Venzke).

## 15. Occurrence rates for extremes — where the deep record is trustworthy

Some events are too large to escape documentation, so their record is complete
over centuries even without instruments:

| Class | Window | Basis | Result |
|---|---|---|---|
| VEI ≥ 6 eruption | 1500 → | Brown et al. (2014): the VEI≥6 record is essentially complete post-1500 | 9 events → **~1.7/century** (λ ≈ 0.017/yr) |
| VEI ≥ 7 eruption | 900 → | ice cores + global tephra make these unmissable for ~a millennium | 3 events (Paektu 946, Samalas 1257, Tambora 1815) → **~1 per ~370 yrs**, with the very wide CI n=3 deserves |
| M ≥ 8.5 earthquake | 1900 → | instrumental only — see § 16 | ~16 events → λ ≈ 0.13/yr |

Probabilities are homogeneous Poisson over these rates. These are **occurrence**
probabilities: a VEI-7 anywhere on Earth, not a death toll — impact depends
entirely on where it happens (Tambora's toll came with a starving year worldwide;
a repeat today would be a global agricultural event).

## 16. Where the deep record must NOT feed rates — and why that is a finding, not an assumption

Documented M ≥ 8.5 earthquakes per century climb 3 → 6 → 7 → 9 → 11 from the
1500s to the 1900s. Two hypotheses fit that curve: better record-keeping, or
genuinely increasing seismicity. We do not assume the answer — we test it
against the data (both analyses run in `test/deep.test.mjs` on every build):

**Stationarity inside the constant-detection era.** Since ~1918, detection of
M ≥ 7 events is complete and unchanging, so any real secular increase must
show there. Raw decade counts wiggle upward slightly, but earthquake counts
are clustered (aftershocks; the measured inter-event CV > 1 of § 3.2), which
inflates variance and mimics trends. After Gardner–Knopoff-style
declustering (drop events within 1.5 yr and 300 km after a larger shock),
the 1920s–2010s decade counts are 108, 113, 120, 86, 113, 127, 93, 120, 118,
128: homogeneity χ² = 15.1 (df = 9, below the 16.9 five-percent cutoff) and
trend z = 1.3 — statistically flat. This reproduces Shearer & Stark (2012),
who posed exactly this question after the 2004–2011 cluster of great quakes.

**The size of the documentary undercount.** Over 1500–1899 the documentary
record captures ~22 M ≥ 7.5 events per century; instruments record 124–184
per century — roughly one event in six was written down, with remote and
oceanic earthquakes the largest missing class. For rising seismicity to
explain the ramp instead, rates would have had to jump ~6× precisely when
seismometers were deployed and then hold flat for the 120 years since — which
the stationarity test above rules out.

The honest limit of the claim: "no trend across a century of constant
measurement" is not proof of stationarity over millennia; it is the strongest
statement the data permit, and the model needs nothing stronger — every rate
is computed inside a constant-detection window, so no assumption about the
documentary era enters the numbers at all. Death tolls face the additional,
untestable-by-us confound that a toll from 1556 reflects 1556's buildings and
population (~0.4 ≥100k-death quakes/century documented pre-1900 vs ~5/century
since — documentation and population growth compounded). Consequently:

- occurrence windows for earthquakes stay instrumental;
- the dashboard's death/damage probability windows stay at Part II's 1900+
  policy;
- documentary catastrophes appear only in the era-labeled display record
  (`centuryRamp()` in `deep.js` reproduces the evidence; the test suite
  asserts the ramp exists).

Pre-1900 death tolls shown (Antioch 115: ~260,000; Shaanxi 1556: ~830,000) are
chronicle-derived estimates with order-of-magnitude uncertainty, labeled by
source.

## 17. Additional references (Part III)

- Brown, S. K., et al. (2014). Characterisation of the Quaternary eruption record: the LaMEVE database. *J. Applied Volcanology* 3:5.
- Newhall, C. G., & Self, S. (1982). The Volcanic Explosivity Index (VEI). *JGR* 87.
- Shearer, P. M., & Stark, P. B. (2012). Global risk of big earthquakes has not recently increased. *PNAS* 109(3).
- Rougier, J., et al. (2018). The global magnitude–frequency relationship for large explosive volcanic eruptions. *EPSL* 482.
- National Geophysical Data Center / World Data Service: NCEI/WDS Global Significant Earthquake Database. NOAA. doi:10.7289/V5TD9V7K

---

# Part IV — Model evaluation: the accuracy report card

Accuracy here is a measured quantity, not a claim. `backtest/backtest.mjs`
walks forward through history month by month (2010-01 → 2024-01, 169 months):
for each month and target it fits every candidate model using ONLY earlier
events (no lookahead), forecasts P(≥1 qualifying event that month), and scores
against what happened — Brier score, log score, and Brier Skill Score (BSS)
relative to the flat constant-rate baseline M0. Calibration is checked by
bucketing forecasts against observed frequencies. The same run executes in CI
(`test/backtest.test.mjs`) so the report card cannot silently rot.

## 18. Results (snapshot data, 169 held-out months)

| Target | events | M1 seasonal | M2 + trend | M3 + cluster |
|---|---|---|---|---|
| deaths ≥ 100, global | 128 | **+5.1%** | **+7.7%** | +4.8% |
| deaths ≥ 1,000, global | 30 | +0.6% | +0.6% | +0.6% |
| deaths ≥ 10,000, global | 7 | −2.0% | −2.0% | −2.0% |
| deaths ≥ 100, US | 10 | +0.7% | +0.7% | +0.7% |
| damage ≥ $10B, global | 39 | +3.6% | +3.6% | +2.3% |

(Cells are BSS vs the flat baseline; positive = more skillful.)

## 19. What was adopted, and what was rejected

- **Seasonality (M1) is validated** and stays.
- **The trend adjustment (M2) is adopted**: a Poisson log-linear trend fitted
  to the aggregate annual counts of qualifying events inside the completeness
  window, evaluated at the forecast date. Guards (all part of the validated
  configuration, implemented once in `poissonTrendMultiplier` and shared by
  the engine and the backtest): the trend applies only when its slope is
  significant (|z| ≥ 2), the multiplier is clamped to [⅓, 3], and the
  projection never extends more than 3 years past the data. Where the gate
  closes, M2 ≡ M1 — which is why most rows tie. Where it opens (deaths ≥ 100:
  event frequency at that severity has declined significantly across
  1990→2024), it corrects exactly the over-forecasting the calibration table
  shows for the flat model (mean forecast 0.89 vs observed 0.80).
- **Monthly clustering (M3) is rejected**: conditioning on the previous
  month's activity scored below plain seasonality (+4.8% < +5.1% at
  deaths ≥ 100). Whatever month-to-month dependence exists is already
  captured by the seasonal cycle at this granularity. Sub-monthly aftershock
  clustering for the earthquake page remains plausible future work — the
  harness is ready to judge it.
- The small negative skill at deaths ≥ 10,000 (7 events in 14 years) reflects
  seasonal-factor noise at a threshold too sparse for a monthly climatology;
  the effect is within noise and the seasonal factor at such thresholds is
  driven by the shared floor (§ 10), not the sparse events themselves.

## 20. Scoring references

- Brier, G. W. (1950). Verification of forecasts expressed in terms of probability. *Mon. Wea. Rev.* 78.
- Gneiting, T., & Raftery, A. E. (2007). Strictly proper scoring rules, prediction, and estimation. *JASA* 102.

## 19b. The renewal ("overdue") hypothesis — scored, shipped as comparison, adoption pre-registered

Prompted by the observation that no ≥100,000-death event has occurred since
2010 (16+ quiet years against a 4.6-year historical mean gap), model **M4**
fits a Gamma renewal distribution to the training inter-event gaps and
conditions on elapsed time. Walk-forward results:

| Target | best prior model | M4 renewal |
|---|---|---|
| deaths ≥ 100 | +7.7% (M2) | +1.3% |
| deaths ≥ 1,000 | +0.6% | **+1.7%** |
| deaths ≥ 10,000 | −2.0% | **+0.8%** (only model above baseline) |
| damage ≥ $10B | +3.6% | +0.0% |

Renewal conditioning helps precisely at sparse, high-severity thresholds —
where gap structure carries information — and hurts at dense ones, where
seasonality and trend dominate. At the ≥100k threshold specifically, the
fitted gaps are mildly quasi-periodic (CV ≈ 0.8 from 24 gaps), so the
conditional probability given the current quiet spell runs ~1.5× the
memoryless number.

**Status: comparison view, not headline.** The dashboard's "Time since last"
panel shows the renewal number beside the validated model wherever ≥ 15 gaps
exist. Because promoting M4 for "sparse thresholds" chosen from these same
scores would be selection on the test set, adoption is **pre-registered**
instead: if M4's advantage at deaths ≥ 1,000 and ≥ 10,000 persists when the
EM-DAT catalog is refreshed (2024→present is genuinely out-of-sample), M4
becomes the headline at thresholds whose baseline monthly probability is
below 50%. The advantage is also sensitive to the evaluation range (present
on 2010–2024, absent on 2012–2024) — additional evidence that it is a weak
signal requiring out-of-sample confirmation before it may drive the headline.

---

# Part V — Extreme-value severity tail

Above a certain severity the empirical staircase runs out of steps: eight
events ≥ 1M deaths in the record, one damage event near $200B, none above
~$275B. A Garwood interval on 8 counts spans a factor of ~3; on 0 counts it
says only "less than 3.7 per window." Counting is the wrong estimator there.
Extreme-value theory supplies the right one.

## 21. The model

**Shape.** By the Pickands–Balkema–de Haan theorem, excesses over a high
threshold converge to the generalized Pareto distribution (GPD),
S(z) = (1 + ξz/β)^(−1/ξ). The shape ξ and scale β are fitted by profile
maximum likelihood (grid over ξ, golden-section over β) on the exceedances
of a fixed **anchor**: deaths ≥ 1,000 (307 exceedances, window 1930→) and
damage ≥ $1B adjusted (738 exceedances, window 1990→). A fit is refused
below 40 exceedances — which is why **US deaths carry no tail model** and
sparse US thresholds still honestly display "too rare to rate."

Fitted shapes: deaths ξ ≈ 1.5, damage ξ ≈ 0.8 — both heavy-tailed, deaths
so heavy the theoretical mean is infinite, consistent with the published
literature on disaster loss distributions (e.g. Coles 2001; Clauset et al.
2009 on heavy tails in fatality data).

**Level and switch point.** The fitted GPD is *not* extrapolated from the
anchor across three orders of magnitude. Within each completeness window the
model switches from counting to the tail at a fixed point **x\*** — the
severity of the window's **10th-largest event** — and re-anchors the GPD
there using threshold stability (excesses over x\* of a GPD(ξ, β) are
GPD(ξ, β + ξ(x\* − u))), with the level tied to the window's own empirical
rate at x\*:

    λ(≥x) = (n*/T) · S(x − x*; ξ, β + ξ(x* − u))    for x ≥ x*

Because λ(x\*) equals the empirical rate exactly, the hand-off from the
staircase to the smooth curve is **continuous by construction**, and both
pieces are non-increasing, so the exceedance curve is monotone — including
beyond the largest event on record, where the number is a model statement,
not an observation (the caveat panel says so). Below x\* the model remains
purely empirical; the tail changes nothing at any backtest-validated
threshold. Seasonal and trend multipliers apply identically on both sides
of x\*. Headline uncertainty in the tail zone is widened to at least
[λ/3, 3λ], dominating the (no-longer-meaningful) count interval.

## 22. Coherence across completeness windows

P(≥x) can never rise as x rises — any valid rate estimate at a higher
threshold is a lower bound for every lower threshold. Two seams in a
piecewise model can violate this ordering:

1. **Trend gating.** The Poisson log-linear trend (Part IV) is fitted once
   per completeness window on the window's *base* threshold — the dense
   regime the backtest validated — and applied uniformly to every threshold
   sharing that window. (A per-threshold fit would switch on and off across
   a sample-size gate as the slider moves, producing visible probability
   inversions; a single per-window multiplier on a monotone family of rates
   cannot.)
2. **Window boundaries.** At a window base (e.g. deaths 1,000, where the
   1930→ record opens) the longer window can show a *higher* rate for the
   rarer event than the recent, trend-adjusted window shows just below it.
   That gap is real non-stationarity — the same decline the trend model
   measures. The resolution is an **exceedance-coherence floor**: every
   threshold's rate is floored by the model's own assessment at the next
   window base above it (recursively; a no-op at the bases themselves, so
   no validated headline changes). When the floor binds, the headline panel
   says so.

Both constraints are enforced by a test that sweeps ~400 log-spaced
thresholds across every metric × scope combination and asserts monotone
probabilities across every seam.

## 23. Validation (Part V)

- **Estimator recovery:** synthetic GPD samples with known (ξ, β) at three
  tail weights; the fitted survival function must match truth within ×2 at
  the 90th–99.9th percentiles (ξ and β individually are strongly
  correlated in the likelihood, so the survival function is the invariant
  that matters — and the one the model consumes).
- **Hold-out:** the deaths tail fitted only on 1930–1999 predicts the
  expected number of ≥500,000-death events in 2000–2024; the observed count
  (zero — the largest were ~220–230k) must be statistically consistent with
  the prediction under Poisson, in both directions (no over-prediction
  beyond the 99.5% level, no degenerate under-prediction).
- **Continuity and monotonicity:** asserted directly (§ 22).
- **Refusal:** US deaths must return no tail model.

## 24. References (Part V)

- Pickands, J. (1975). Statistical inference using extreme order statistics. *Ann. Statist.* 3, 119–131.
- Balkema, A. & de Haan, L. (1974). Residual life time at great age. *Ann. Probab.* 2, 792–804.
- Coles, S. (2001). *An Introduction to Statistical Modeling of Extreme Values.* Springer.
- Clauset, A., Shalizi, C. & Newman, M. (2009). Power-law distributions in empirical data. *SIAM Review* 51(4), 661–703.
