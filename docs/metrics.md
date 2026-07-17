# Measuring success: `@drasi/lib` adoption metrics

The success metric for `@drasi/lib` is **growth in npm downloads and
dependents** over time. npm records this data automatically for every published
package, so nothing needs to be instrumented in the package itself — this
document explains **where the data lives and how to read it** so adoption can be
tracked and reported consistently.

## What to track

- **Downloads** of the main package `@drasi/lib` — the headline metric.
- **Dependents** — the number of public npm packages that declare `@drasi/lib`
  as a dependency.
- Per-platform packages (`@drasi/lib-<platform>`, e.g.
  `@drasi/lib-linux-x64-gnu`) each carry their **own** download counts, since npm
  counts the `optionalDependencies` npm actually installs. Treat these as
  supporting/diagnostic signals (they roughly track platform mix); the main
  `@drasi/lib` package is the number to report.

## npm downloads API (public, no auth)

The npm registry exposes an unauthenticated downloads API. Scoped package names
work directly in the path.

Point-in-time counts (single total for the period):

```bash
# Last day / week / month
curl -s https://api.npmjs.org/downloads/point/last-day/@drasi/lib
curl -s https://api.npmjs.org/downloads/point/last-week/@drasi/lib
curl -s https://api.npmjs.org/downloads/point/last-month/@drasi/lib

# An explicit date range (inclusive), YYYY-MM-DD:YYYY-MM-DD
curl -s https://api.npmjs.org/downloads/point/2026-07-01:2026-07-31/@drasi/lib
```

Example response:

```json
{ "downloads": 36, "start": "2026-07-10", "end": "2026-07-16", "package": "@drasi/lib" }
```

Per-day breakdown over a range (useful for charting a trend):

```bash
curl -s https://api.npmjs.org/downloads/range/last-month/@drasi/lib
```

Notes:

- The API is public and unauthenticated — safe to call from CI without secrets.
- A brand-new or low-traffic package may return `{"error":"package @drasi/lib not found"}` or `downloads: 0` for a period before it has data. Callers should
  handle that gracefully rather than treating it as a failure.

## npmjs.com (Insights & dependents)

On the package page — <https://www.npmjs.com/package/@drasi/lib>:

- The **weekly downloads** figure and a small trend graph appear on the sidebar.
- The **Insights** view shows downloads over time.
- The **Dependents** tab lists public packages that depend on `@drasi/lib`.

## Third-party views

These sites read the same public npm data and add charts/history:

- **npm-stat.com** — long-range download charts and CSV export:
  <https://npm-stat.com/charts.html?package=@drasi/lib>
- **npms.io** — package score, popularity, and maintenance signals:
  <https://npms.io/search?q=@drasi/lib>

## Baseline and target

The package was first published in **July 2026** (`0.1.1` is the current
`latest`). Record periodic snapshots here so growth is visible over time.

| Date (YYYY-MM) | Downloads (last month) | Dependents | Notes                     |
| -------------- | ---------------------- | ---------- | ------------------------- |
| 2026-07        | 0 (baseline)           | 0          | First publish             |
| _target_       | _TBD_                  | _TBD_      | Fill in the epic's target |

Update this table when reporting on the epic. A convenient way to capture the
weekly figure automatically is the scheduled
[`metrics.yml`](../.github/workflows/metrics.yml) workflow, which writes the
last-week download count to the GitHub Actions run summary.
