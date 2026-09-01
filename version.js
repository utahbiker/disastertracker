// version.js — the single source of the deployed version, shown next to the
// page title. BUMP THIS on every change that ships to production (patch for
// fixes, minor for features): it is the visual confirmation that a deploy
// actually reached tracker.goinwardout.com.
// History: 1.0 earthquake app · 1.1 master dashboard · 1.2 deep history ·
// 1.3.1 label fixes · 1.4 backtested trend-adjusted rates · 1.5 renewal (overdue) view · 1.6 EVT severity tail · 1.7 kernel-smoothed seismicity · 1.8 EM-DAT refresh to 2026 (+ pre-registered renewal verdict) · 1.9 live 'Happening now' layer · 1.10 Happening-now page + interactive globe · 1.11 event-detail popups · 1.11.1 visible sonar pings · 1.12 multi-hazard globe (21-day window, EONET + ReliefWeb coords) · 1.13 clickable live list with tracking links · 1.14 2-min refresh + freshness stamp + severity-scaled pings.
export const VERSION = 'v1.14.0';
