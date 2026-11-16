# SurferToday Global Tide Map

A static Leaflet map of NOAA CO-OPS tide-prediction stations. GitHub Actions refreshes the forecast data daily; GitHub Pages hosts the map. No SurferToday server access is required.

## Setup

1. In this repository, open **Settings → Pages**.
2. Under **Build and deployment**, choose **GitHub Actions** as the source.
3. Open **Actions → Refresh NOAA tide predictions → Run workflow**.
4. The first refresh queries NOAA sequentially and may take a while. The workflow commits the updated `site/data/tides.json`.
5. The deployment workflow publishes the map at `https://londiniumsurfer.github.io/surfer-tides/`.

The refresh is scheduled daily at 03:17 UTC and can also be started manually.

## Embed in SurferToday (Joomla 6)

After GitHub Pages has deployed successfully, add this iframe to a Joomla Custom module or article:

```html
<iframe
  src="https://londiniumsurfer.github.io/surfer-tides/"
  title="SurferToday Global Tide Stations"
  width="100%"
  height="760"
  style="border:0;width:100%;"
  loading="lazy">
</iframe>
```

If Joomla removes the iframe, adjust the editor's text-filter settings to allow iframe elements.

## Data notes

- Data source: NOAA CO-OPS Metadata and Data APIs.
- The map shows high/low tide predictions, not live observed water levels.
- Times are stored in UTC and displayed in the visitor's local time by default; a UTC toggle is available.
- Heights are in metres. Each station popup identifies the datum used.
- The updater tries MLLW first, then other datums explicitly listed by NOAA when MLLW is unavailable. It does not borrow predictions from another station.
- Stations without available predictions remain on the map and show an explanatory message.
- Requests are sequential with a 1.5-second delay to avoid excessive load on NOAA's public API.

## Files

- `.github/workflows/refresh-tides.yml`: daily/manual NOAA refresh.
- `.github/workflows/deploy-pages.yml`: deploys the static site to GitHub Pages.
- `scripts/update_tides.py`: downloads station metadata and predictions.
- `site/index.html`: Leaflet map interface.
- `site/data/tides.json`: generated station and prediction data.

See [NOAA CO-OPS](https://tidesandcurrents.noaa.gov/) for source information.
