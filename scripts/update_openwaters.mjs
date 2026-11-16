#!/usr/bin/env node
/**
 * Build commercial-use Open Waters / Slackwater tide predictions.
 * NOAA records remain in tides.json; nearby duplicate Open Waters stations
 * are omitted so the map uses NOAA's existing prediction series there.
 */
import fs from "node:fs/promises";
import { loadStations } from "@slackwater/database";
import { useStation } from "@slackwater/engine";

const ROOT = new URL("../", import.meta.url);
const SITE_DATA = new URL("../site/data/", import.meta.url);
const NOAA_FILE = new URL("../site/data/tides.json", import.meta.url);
const OUTPUT = new URL("../site/data/openwaters-tides.json", import.meta.url);
const HOURS = 48;
const DUPLICATE_RADIUS_KM = 0.75;
const EARTH_KM = 6371.0088;

function distanceKm(aLat, aLon, bLat, bLon) {
  const rad = value => value * Math.PI / 180;
  const dLat = rad(bLat - aLat);
  const dLon = rad(bLon - aLon);
  const x = Math.sin(dLat / 2) ** 2 +
    Math.cos(rad(aLat)) * Math.cos(rad(bLat)) * Math.sin(dLon / 2) ** 2;
  return 2 * EARTH_KM * Math.asin(Math.sqrt(x));
}

function gridKey(lat, lon) {
  return `${Math.floor(lat * 100)}:${Math.floor(lon * 100)}`;
}

function buildNoaaGrid(stations) {
  const grid = new Map();
  for (const station of stations) {
    const key = gridKey(Number(station.lat), Number(station.lon));
    if (!grid.has(key)) grid.set(key, []);
    grid.get(key).push(station);
  }
  return grid;
}

function duplicatesNoaa(station, grid) {
  const latCell = Math.floor(station.latitude * 100);
  const lonCell = Math.floor(station.longitude * 100);
  for (let dy = -1; dy <= 1; dy++) {
    for (let dx = -1; dx <= 1; dx++) {
      for (const noaa of grid.get(`${latCell + dy}:${lonCell + dx}`) || []) {
        if (distanceKm(
          station.latitude, station.longitude,
          Number(noaa.lat), Number(noaa.lon)
        ) <= DUPLICATE_RADIUS_KM) return true;
      }
    }
  }
  return false;
}

function getDatum(station) {
  if (station.chart_datum && typeof station.datums?.[station.chart_datum] === "number") {
    return station.chart_datum;
  }
  if (typeof station.datums?.MSL === "number") return "MSL";
  return undefined;
}

async function main() {
  const now = new Date();
  now.setSeconds(0, 0);
  const end = new Date(now.getTime() + HOURS * 60 * 60 * 1000);

  const noaaDocument = JSON.parse(await fs.readFile(NOAA_FILE, "utf8"));
  const noaaStations = noaaDocument.stations || [];
  const noaaGrid = buildNoaaGrid(noaaStations);

  console.log("Loading Open Waters station database...");
  const db = await loadStations();
  const accepted = db.accepted.filter(station =>
    station.kind === "tide" &&
    station.license?.commercial_use === true &&
    Number.isFinite(station.latitude) &&
    Number.isFinite(station.longitude)
  );

  const output = [];
  let excludedNoaa = 0;
  let skipped = 0;
  let errors = 0;

  for (let index = 0; index < accepted.length; index++) {
    const station = accepted[index];

    // NOAA is already refreshed through its own official API workflow.
    if (station.source?.name?.toUpperCase() === "NOAA" ||
        station.id?.startsWith("noaa/") ||
        duplicatesNoaa(station, noaaGrid)) {
      excludedNoaa++;
      continue;
    }

    const datum = getDatum(station);
    if (!datum || !Array.isArray(station.harmonic_constituents) ||
        station.harmonic_constituents.length === 0) {
      skipped++;
      continue;
    }

    try {
      const predictor = useStation(station);
      const prediction = predictor.getExtremesPrediction({
        start: now,
        end,
        datum,
        units: "meters",
        nodeCorrections: station.node_corrections
      });

      const events = prediction.extremes
        .filter(event => event.time >= now && event.time <= end)
        .map(event => ({
          time_utc: event.time.toISOString(),
          kind: event.high ? "High" : "Low",
          height_m: Number(event.level.toFixed(4))
        }));

      output.push({
        id: station.id,
        name: station.name,
        locality: station.locality || "",
        region: station.region || "",
        country: station.country || "",
        continent: station.continent || "",
        lat: station.latitude,
        lon: station.longitude,
        source: station.source?.name || "Open Waters",
        source_id: String(station.source?.id ?? ""),
        source_url: station.source?.url || "",
        datum,
        predictions: events,
        attribution: station.attribution || "Slackwater database (https://github.com/openwatersio/slackwater-database)",
        license: station.license.type,
        license_url: station.license.url,
        model_type: station.type
      });
    } catch (error) {
      errors++;
      if (errors <= 20) {
        console.warn(`Skipping ${station.id}: ${error.message}`);
      }
    }

    if ((index + 1) % 500 === 0 || index + 1 === accepted.length) {
      console.log(
        `Checked ${index + 1}/${accepted.length} accepted records; ${output.length} added; ${excludedNoaa} NOAA duplicates excluded.`
      );
    }
  }

  const document = {
    generated_at_utc: now.toISOString(),
    window_start_utc: now.toISOString(),
    window_end_utc: end.toISOString(),
    station_count: output.length,
    prediction_count: output.reduce((sum, station) => sum + station.predictions.length, 0),
    excluded_noaa_duplicates: excludedNoaa,
    skipped_without_model_or_datum: skipped,
    prediction_errors: errors,
    source: "Open Waters Slackwater Tide Database and @slackwater/engine",
    commercial_use_only: true,
    stations: output
  };

  await fs.mkdir(SITE_DATA, { recursive: true });
  const temp = new URL("../site/data/openwaters-tides.tmp", import.meta.url);
  await fs.writeFile(temp, JSON.stringify(document), "utf8");
  await fs.rename(temp, OUTPUT);

  console.log(
    `Wrote ${output.length} commercial-use Open Waters stations and ${document.prediction_count} high/low events. Excluded ${excludedNoaa} NOAA duplicates; skipped ${skipped} records without usable models/datums; prediction errors: ${errors}.`
  );
}

main().catch(error => {
  console.error(error);
  process.exitCode = 1;
});
