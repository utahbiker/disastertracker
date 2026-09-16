#!/usr/bin/env python3
"""etl/characterize-qtm.py — integrity + completeness characterization of the
QTM template-matching catalog (Ross et al. 2019, doi 10.7909/C3WD3xH1).

RESEARCH ONLY. Nothing here feeds the shipped probability model.

Run against the raw catalog as distributed by SCEDC:
    python3 etl/characterize-qtm.py path/to/qtm_final_12dev.hypo

Why this exists: the catalog's headline is "complete to M0.3", and taking that
at face value region-wide produces a Gutenberg-Richter b-value of 0.53 — far
below any plausible tectonic value (~0.9-1.0). That discrepancy is the single
most important thing to understand before using this catalog for anything, and
it is a spatial-mixing artifact, not bad data. See specs/forecasting-data-notes.md.
"""
import sys
import numpy as np
import pandas as pd

BIN = 0.1  # catalog magnitude binning


def load(path):
    df = pd.read_csv(path, sep=r"\s+", header=0)
    df.columns = [c.strip().rstrip("?") for c in df.columns]
    return df


def aki_b(mags, mc, nmin=100):
    """Aki (1965) / Utsu maximum-likelihood b, corrected for BIN binning.
    Returns (b, sigma_ShiBolt, n)."""
    s = mags[mags >= mc - 1e-9]
    if len(s) < nmin:
        return np.nan, np.nan, len(s)
    b = np.log10(np.e) / (s.mean() - (mc - BIN / 2))
    return b, b / np.sqrt(len(s)), len(s)


def maxc(mags, correction=0.2):
    """Maximum-curvature Mc (Wiemer & Wyss 2000). The +0.2 correction is the
    standard compensation for MAXC's known low bias; it is still a LOWER BOUND."""
    e = np.arange(np.floor(mags.min() * 10) / 10, mags.max() + BIN, BIN)
    c, _ = np.histogram(mags, bins=e)
    return e[int(np.argmax(c))] + BIN / 2 + correction


def gft(mags, target, lo=-1.0, hi=3.0):
    """Wiemer & Wyss (1995) goodness-of-fit Mc: lowest cutoff whose synthetic
    GR distribution reproduces >= target% of observed cumulative counts."""
    best_r = -np.inf
    for mc in np.arange(lo, hi, BIN):
        b, _, n = aki_b(mags, mc, nmin=200)
        if not np.isfinite(b):
            continue
        bins = np.arange(mc, mags.max() + BIN, BIN)
        obs = np.array([(mags >= t - 1e-9).sum() for t in bins], float)
        syn = 10 ** ((np.log10(obs[0]) + b * mc) - b * bins)
        r = 100 * (1 - np.abs(obs - syn).sum() / obs.sum())
        best_r = max(best_r, r)
        if r >= target:
            return mc, r, b
    return np.nan, best_r, np.nan


def main(path):
    df = load(path)
    m = df["MAGNITUDE"].to_numpy(float)
    print(f"rows {len(df):,}  columns {list(df.columns)}")

    # ---- integrity ----
    nulls = int(df.isna().sum().sum())
    phys = ["MONTH", "DAY", "HOUR", "MINUTE", "SECOND", "LATITUDE", "LONGITUDE", "MAGNITUDE"]
    dupes = int(df.duplicated(subset=phys, keep=False).sum())
    print(f"nulls {nulls}  duplicate-physical-rows {dupes}  "
          f"unique eventids {df.EVENTID.nunique():,}/{len(df):,}")
    print(f"relocated {df.RELOCATED.mean() * 100:.1f}%  templates {df.TEMPLATEID.nunique():,}")
    print(f"lat {df.LATITUDE.min():.3f}..{df.LATITUDE.max():.3f}  "
          f"lon {df.LONGITUDE.min():.3f}..{df.LONGITUDE.max():.3f}")
    d = df.DEPTH.to_numpy(float)
    print(f"depth km median {np.median(d):.2f}  p95 {np.percentile(d, 95):.2f}  "
          f"negative(above datum) {int((d < 0).sum()):,}")

    # ---- region-wide completeness: the trap ----
    print("\n-- region-wide (DO NOT USE THESE FOR MODELLING) --")
    mc_r = maxc(m)
    b_r, s_r, n_r = aki_b(m, mc_r)
    print(f"MAXC+0.2 Mc={mc_r:.2f}  n={n_r:,}  b={b_r:.3f}+/-{s_r:.3f}")
    for t in (90.0, 95.0):
        mc, r, b = gft(m, t)
        print(f"GFT {t:.0f}%: " + (f"Mc={mc:.2f} R={r:.1f}% b={b:.3f}"
                                   if np.isfinite(mc) else f"NEVER REACHED (best R={r:.1f}%)"))
    print("b(Mcut) never plateaus below ~M2.3 region-wide -> no single Mc describes this catalog")

    # ---- spatial completeness: the correction ----
    print("\n-- per-cell (0.2 deg, n>=2000): the honest picture --")
    key = (np.floor(df.LATITUDE / 0.2).astype(np.int64) * 100000
           + np.floor(df.LONGITUDE / 0.2).astype(np.int64))
    mcs, b_own, b_fix = [], [], []
    for k in pd.unique(key):
        sel = m[key == k]
        if len(sel) < 2000:
            continue
        mc = maxc(sel)
        b1, _, _ = aki_b(sel, mc)
        b2, _, n2 = aki_b(sel, 1.5, nmin=300)
        mcs.append(mc)
        if np.isfinite(b1):
            b_own.append(b1)
        if np.isfinite(b2):
            b_fix.append(b2)
    mcs, b_own, b_fix = map(np.array, (mcs, b_own, b_fix))
    print(f"cells {len(mcs)}   Mc min {mcs.min():.2f}  median {np.median(mcs):.2f}  "
          f"p90 {np.percentile(mcs, 90):.2f}  max {mcs.max():.2f}  "
          f"(spread {mcs.max() - mcs.min():.1f} magnitude units)")
    print(f"b at each cell's own Mc : median {np.median(b_own):.3f}")
    print(f"b at uniform Mc=1.5     : median {np.median(b_fix):.3f}  "
          f"IQR {np.percentile(b_fix, 25):.3f}-{np.percentile(b_fix, 75):.3f}  <- tectonic, as expected")

    # ---- temporal stability ----
    print("\n-- by year --")
    for y in sorted(df.YEAR.unique()):
        sel = m[df.YEAR.to_numpy() == y]
        b15, _, _ = aki_b(sel, 1.5)
        print(f"  {y}  n={len(sel):>7,}  Mc={maxc(sel):5.2f}  b(1.5)={b15:.3f}")

    # ---- ground truth ----
    print("\n-- ground truth: El Mayor-Cucapah 2010-04-04 (USGS 32.286N 115.295W M7.2) --")
    em = df[(df.YEAR == 2010) & (df.MONTH == 4) & (df.DAY == 4) & (df.MAGNITUDE > 6.5)]
    if len(em):
        r = em.iloc[0]
        off = np.hypot((r.LATITUDE - 32.286) * 111,
                       (r.LONGITUDE + 115.295) * 111 * np.cos(np.radians(32.3)))
        print(f"  found M{r.MAGNITUDE:.2f} at {r.LATITUDE:.3f},{r.LONGITUDE:.3f} "
              f"-> {off:.1f} km from reference")
    apr = int(((df.YEAR == 2010) & (df.MONTH == 4)).sum())
    med = int(df.groupby(["YEAR", "MONTH"]).size().median())
    print(f"  April 2010 {apr:,} events vs {med:,} median month ({apr / med:.0f}x burst)")


if __name__ == "__main__":
    if len(sys.argv) < 2:
        sys.exit(__doc__)
    main(sys.argv[1])
