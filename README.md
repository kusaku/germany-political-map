# Germany Political Map

A single-page, static WebGL atlas of party polling, latest state-election results, and upcoming election dates across Germany. Political data is bundled into the repository and refreshed daily.

## Interface

- Every state is rendered as a lit 3D extrusion whose height reflects the active metric.
- A thin dark rim separates touching top surfaces without opening gaps between states.
- Boundary geometry is simplified once and rendered at one fixed level of detail at every allowed zoom.
- MapLibre provides the camera, 3D extrusion, lighting, and hit-testing; CSS handles the static backdrop.
- State names, ratings, and flags appear on hover; the entire polygon is clickable.
- Public-domain SVG state flags from [Wikimedia Commons](https://commons.wikimedia.org/wiki/Category:SVG_flags_of_Germany_by_state) are stored locally and reused in hover cards, the detail panel, and the overview table. See [`assets/flags/ATTRIBUTION.md`](assets/flags/ATTRIBUTION.md).
- Daily polling, latest election, and next-election views share the same interactive scene.
- Party strength, changed polling leaders, and the next eight election dates are calculated from the same loaded state data.

## Data

- Party ratings: [DAWUM API](https://dawum.de/API/) (ODC-ODbL), saved as `data/polls.json` by the daily updater.
- State election results: [Federal Returning Officer](https://www.bundeswahlleiterin.de/en/service/landtagswahlen.html). The provisional 2026 Sachsen-Anhalt result comes from its [official state results portal](https://wahlergebnisse.sachsen-anhalt.de/wahlen/lt26/downloads.html).
- State boundaries: © [BKG](https://www.bkg.bund.de) 2026, [dl-de/by-2-0](https://www.govdata.de/dl-de/by-2-0), simplified for the web.

The browser loads political information only from local `data/*.json` files; it makes no runtime requests to polling or election APIs. Polling averages use each institute’s newest survey within 90 days of the latest published poll for a state. Election percentages are recalculated from official absolute party vote totals. This is a transparent snapshot, not a forecast or a seat projection.

## Run locally

No build step or package install is required:

```sh
python3 -m http.server 8080
```

Open `http://localhost:8080`.

## Refresh bundled data

Node.js 22+ is sufficient; the script has no third-party dependencies:

```sh
node scripts/update-data.mjs
```

The GitHub Actions workflow refreshes the bundled polling snapshot and election results at midnight UTC. It writes canonical JSON and commits only when the parsed data has changed.
