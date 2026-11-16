# SurferToday Global Tide Map

A static Leaflet map combining NOAA CO-OPS tide-prediction stations with commercially usable international tide stations from the Open Waters Slackwater database. GitHub Actions refreshes both datasets daily; GitHub Pages hosts the map. No SurferToday server access is required.

## Setup

1. In this repository, open **Settings → Pages**.
2. Under **Build and deployment**, choose **GitHub Actions** as the source.
3. Open **Actions → Refresh NOAA and Open Waters tide predictions → Run workflow**.
4. The workflow downloads NOAA predictions, calculates Open Waters harmonic predictions, and commits the refreshed JSON data.
5. The deployment workflow publishes the map at `https://surfertoday.github.io/surfer-tides/`.

The refresh is scheduled daily at 03:17 UTC and can also be started manually.

## Embed in SurferToday (Joomla 6)

After GitHub Pages has deployed successfully, add this iframe to a Joomla Custom module or article:

```html
<iframe
  src="https://surfertoday.github.io/surfer-tides/"
  title="SurferToday Global Tide Stations"
  width="100%"
  height="760"
  style="border:0;width:100%;"
  loading="lazy">
</iframe>
```

If Joomla removes the iframe, adjust the editor's text-filter settings to allow iframe elements.

## Data sources and predictions

### NOAA CO-OPS

- NOAA station metadata and high/low predictions are downloaded from the NOAA CO-OPS Metadata and Data APIs.
- MLLW is requested first. If unavailable, the updater tries other datums explicitly listed by NOAA for that station.
- NOAA stations without predictions remain on the map and show an explanatory message.
- Requests are sequential with a 1.5-second delay.

### Open Waters / Slackwater

- Station identities, harmonic constituents, datums, licence information and attribution come from the [Open Waters Slackwater Tide Database](https://github.com/openwatersio/slackwater-database).
- High/low predictions are calculated during the GitHub Actions refresh with the [Slackwater harmonic engine](https://github.com/openwatersio/slackwater), rather than making thousands of API calls from visitors' browsers.
- Only records with `license.commercial_use === true` are included. CC BY-NC and any other non-commercial records are excluded.
- Only quality-accepted tide stations with a usable harmonic model and datum are included.
- NOAA-origin stations and Open Waters records within 750 metres of an existing NOAA station are excluded from the Open Waters output, so the map retains the NOAA prediction series in those locations.
- Each Open Waters station popup displays its own `attribution` text, as required by the database project. Its licence and source attribution are preserved in the generated data.
- Open Waters predictions use the station's chart datum when available; otherwise MSL is used when supplied by the station.
- Predictions are astronomical estimates and do not include weather, storm surge, wind waves or other local effects. They are not for navigation.

## Time, units and map

- Times are stored in UTC and displayed in the visitor's local time by default; a UTC toggle is available.
- Heights are in metres relative to the datum identified for each station.
- NOAA stations are shown in blue; Open Waters stations are shown in gold.
- Search supports station name, ID, locality, region, country and source.
- Map tiles © OpenStreetMap contributors.

## Files

- `.github/workflows/refresh-tides.yml`: daily/manual refresh of both datasets.
- `.github/workflows/deploy-pages.yml`: deploys the static site to GitHub Pages.
- `scripts/update_tides.py`: downloads NOAA metadata and predictions.
- `scripts/update_openwaters.mjs`: filters the Slackwater database for commercial-use tide stations and calculates predictions.
- `site/index.html`: Leaflet map interface.
- `site/data/tides.json`: generated NOAA station and prediction data.
- `site/data/openwaters-tides.json`: generated commercial-use Open Waters station and prediction data.

## Licences and attribution

The Slackwater database code and prediction engine are MIT-licensed. Station data has a per-record licence. This project filters on each station's `license.commercial_use` field and displays the station's supplied `attribution` text. The database's source-specific licence and attribution rules are documented in the [Slackwater database README](https://github.com/openwatersio/slackwater-database#license).

See [NOAA CO-OPS](https://tidesandcurrents.noaa.gov/) for NOAA source information.
