#!/usr/bin/env bash
# etl/fetch-research-data.sh — reconstitute the forecasting-research corpus.
#
# Every source here was downloaded and PARSED during the 2026-09-13 research
# sweep, so the URLs are verified rather than inferred. All of it is reachable
# from a restricted network that can see only GitHub + PyPI — which is exactly
# why this subset exists as a script and the rest lives in
# specs/forecasting-data-acquisition.md as human-fetch recipes.
#
# This data is RESEARCH INPUT. It is never committed to this repo and never
# feeds the shipped probability model (METHODOLOGY § 12b separation).
#
# Usage: bash etl/fetch-research-data.sh [target-dir]    (default: ./research-data)
set -euo pipefail

DIR="${1:-research-data}"
mkdir -p "$DIR"/{catalogs,benchmarks,repos}
cd "$DIR"

say() { printf '\n\033[1m==> %s\033[0m\n' "$*"; }
get() { # get <url> <dest>  — skip if already present and non-empty
  [ -s "$2" ] && { echo "    have $2"; return; }
  echo "    fetch $2"
  curl -sSL --retry 4 --retry-delay 3 -o "$2" "$1"
}

say "Global catalogs"
# ISC-GEM v12.1 — the only magnitude-HOMOGENEOUS global instrumental catalogue.
# 74,159 events, 1904-2021, single Mw scale with per-event uncertainty + an
# 's' column flagging direct (69%) vs regressed-proxy (31%) magnitudes.
# sha256 b4e63841e8a6527f1fa6a0ea823b83cfc5b053ab1c7d8746446e34645592cc8d
get https://raw.githubusercontent.com/SmokesBowls/unfaulted/master/data/isc-gem/isc-gem-cat.csv \
    catalogs/isc-gem-v12.1.csv
get https://raw.githubusercontent.com/SmokesBowls/unfaulted/master/proof/real_data/isc_gem_input.sha256 \
    catalogs/isc-gem-v12.1.sha256
# Global CMT 1976-2013: 40,514 moment tensors. 21,598 carry mb, MS and Mw for
# the SAME event — a free cross-scale calibration set for magnitude conversion.
get https://raw.githubusercontent.com/igp-gravity/geoist/master/examples/data/jan76_dec13.ndk \
    catalogs/gcmt-jan76-dec13.ndk

say "Benchmark forecasts + registered experiments"
# Helmstetter/Kagan/Jackson 2007 — the RELM winner and the long-term
# smoothed-seismicity bar to beat. 7,682 cells x 41 magnitude bins (4.95-8.95).
# Two classes: mainshock (declustered) and aftershock (full-catalog); the
# aftershock rates run systematically higher. Take both — which one you score
# against depends on whether your target catalog is declustered.
PYCSEP=https://raw.githubusercontent.com/SCECcode/pycsep/main/csep/artifacts/ExampleForecasts/GriddedForecasts
get "$PYCSEP/helmstetter_et_al.hkj-fromXML.dat"           benchmarks/hkj-mainshock.dat
get "$PYCSEP/helmstetter_et_al.hkj.aftershock-fromXML.dat" benchmarks/hkj-aftershock.dat

say "Repos (shallow clones)"
clone() { # clone <url> <dir> [branch]
  [ -d "repos/$2/.git" ] && { echo "    have repos/$2"; return; }
  echo "    clone repos/$2"
  git clone --depth 1 ${3:+--branch "$3"} "$1" "repos/$2" 2>&1 | tail -1
}
# EarthquakeNPP — THE keystone. Six California catalogs with FROZEN train/test
# splits and shipped ETAS fits, so our numbers are comparable to published ones.
# ComCat_catalog.csv is the one the first-party ETAS measurement ran on.
clone https://github.com/ss15859/EarthquakeNPP EarthquakeNPP
# Reference ETAS (Mizrahi/Schmid, ETH SED) — ships Swiss catalog + varying-Mc
# example. Installs from git, NOT PyPI; its unconditional seismostats import
# needs seismostats pip-installed separately.
clone https://github.com/lmizrahi/etas etas
# CSEP-Italy 2010: a COMPLETE registered 10-year experiment with the actual
# submitted forecasts. ~1.1 GB — the single best prospective reference we have.
clone https://github.com/cseptesting/italy2010_experiment italy2010
# USGS operational aftershock forecasting (Reasenberg-Jones + ETAS) — the code
# behind the forecasts on USGS event pages, i.e. the real operational comparator.
clone https://github.com/opensha/opensha-oaf opensha-oaf
# Ogata's ORIGINAL ETAS Fortran via the CRAN mirror, and an independent R
# implementation. Three independent ETAS implementations are required before
# any Stage 3 claim — the likelihood is badly non-identifiable.
clone https://github.com/cran/SAPP SAPP
clone https://github.com/jalilian/ETAS ETAS-R
# Zaliapin nearest-neighbor declustering, from Trugman.
clone https://github.com/dttrugman/Nearest_Neighbor_Declustering nn-declustering
# Southern California SCSN catalog, 1932-present, 921,844 events. Branch is master.
clone https://github.com/SCEDC/SCEDC-catalogs SCEDC-catalogs master
# GEM Global Active Faults — 13,696 traces. NB: net_slip_rate is a STRING tuple
# and 3,291 entries are empty, so a naive moment-rate sum under-counts ~24%.
clone https://github.com/GEMScienceTools/gem-global-active-faults gem-faults

say "Python toolchain"
cat > requirements-research.txt <<'EOF'
# CSEP evaluation harness — defines the accepted way to score a forecast.
pycsep==0.8.0
floatcsep==0.5.2
# b-value / Mc estimation incl. b-positive; declustering (GK, Reasenberg, Zaliapin).
seismostats
bruces
# Tidal strain — the negative control. Two independent implementations that
# agreed to 0.5% at Parkfield during the sweep.
pysolid
pyTMD
EOF
echo "    pip install -r $DIR/requirements-research.txt"

say "Done — $(du -sh . | cut -f1) in $PWD"
cat <<'EOF'

NEXT: the high-value datasets behind blocked hosts (QTM 1.81M-event template
catalog, JMA, NGL GNSS, GSRM strain, Slab2, the Zenodo CSEP California
next-day benchmark) need a human on an unrestricted network.
Recipes: specs/forecasting-data-acquisition.md
EOF
