#!/usr/bin/env node
/**
 * Build commercial-use Open Waters / Slackwater tide predictions.
 * NOAA records remain in tides.json; nearby duplicate Open Waters stations
 * are omitted so the map uses NOAA's existing prediction series there.
 */
import fs from "node:fs/promises";
import { loadStations } from "@slackwater/database";
import { createTidePredictor } from "@slackwater/engine";

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
  const lonCells = Math.min(
    18000,
    Math.ceil(DUPLICATE_RADIUS_KM /
      (111.32 * Math.max(Math.cos(station.latitude * Math.PI / 180), 0.01)) * 100)
  );
  for (let dy = -1; dy <= 1; dy++) {
    for (let dx = -lonCells; dx <= lonCells; dx++) {
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

function getModelStation(station, byId) {
  if (station.harmonic_constituents?.length) return station;
  const referenceId = station.offsets?.reference;
  if (!referenceId) return undefined;
  return byId(referenceId);
}

function getPredictionDatum(modelStation, requestedDatum) {
  const datum = requestedDatum && typeof modelStation.datums?.[requestedDatum] === "number"
    ? requestedDatum
    : getDatum(modelStation);
  if (!datum) return undefined;
  const msl = modelStation.datums?.MSL;
  const datumLevel = modelStation.datums?.[datum];
  if (typeof msl !== "number" || typeof datumLevel !== "number") return undefined;
  return { datum, offset: msl - datumLevel };
}

async function main() {
  const now = new Date();
  now.setSeconds(0, 0);
  const end = new Date(now.getTime() + HOURS * 60 * 60 * 1000);

  const noaaDocument = JSON.parse(await fs.readFile(NOAA_FILE, "utf8"));
  const noaaGrid = buildNoaaGrid(noaaDocument.stations || []);

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
  let subordinateCount = 0;
  const errorExamples = [];

  for (let index = 0; index < accepted.length; index++) {
    const station = accepted[index];

    if (station.source?.name?.toUpperCase() === "NOAA" ||
        station.id?.startsWith("noaa/") ||
        duplicatesNoaa(station, noaaGrid)) {
      excludedNoaa++;
      continue;
    }

    try {
      const modelStation = getModelStation(station, db.byId);
      if (!modelStation ||
          modelStation.license?.commercial_use !== true ||
          modelStation.kind !== "tide" ||
          !Array.isArray(modelStation.harmonic_constituents) ||
          modelStation.harmonic_constituents.length === 0) {
        skipped++;
        continue;
      }

      const datumInfo = getPredictionDatum(modelStation, getDatum(station));
      if (!datumInfo) {
        skipped++;
        continue;
      }

      const predictor = createTidePredictor(modelStation.harmonic_constituents, {
        offset: datumInfo.offset,
        nodeCorrections: modelStation.node_corrections || "iho",
        definitions: modelStation.constituent_definitions
      });

      // Subordinate offsets are stored on the target station and applied to
      // the reference model's predicted highs/lows by the Slackwater engine.
      const offsets = station.id === modelStation.id ? undefined : {
        height: station.offsets?.height,
        time: station.offsets?.time
      };
      const extremes = predictor.getExtremesPrediction({
        start: now,
        end,
        offsets
      });

      const events = extremes
        .filter(event => event.time >= now && event.time <= end)
        .map(event => ({
          time_utc: event.time.toISOString(),
          kind: event.high ? "High" : "Low",
          height_m: Number(event.level.toFixed(4))
        }));

      const attribution = [...new Set([
        station.attribution,
        modelStation.id !== station.id ? modelStation.attribution : ""
      ].filter(Boolean))].join(" ");

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
        datum: datumInfo.datum,
        predictions: events,
        attribution: attribution || "Slackwater database (https://github.com/openwatersio/slackwater-database)",
        license: station.license.type,
        license_url: station.license.url,
        model_type: station.type
      });
      if (station.id !== modelStation.id) subordinateCount++;
    } catch (error) {
      errors++;
      if (errorExamples.length < 20) {
        errorExamples.push(`${station.id}: ${error.message}`);
        console.warn(`Skipping ${station.id}: ${error.message}`);
      }
    }

    if ((index + 1) % 500 === 0 || index + 1 === accepted.length) {
      console.log(
        `Checked ${index + 1}/${accepted.length} accepted records; ${output.length} added; ${excludedNoaa} NOAA duplicates excluded; ${errors} errors.`
      );
    }
  }

  const document = {
    generated_at_utc: now.toISOString(),
    window_start_utc: now.toISOString(),
    window_end_utc: end.toISOString(),
    station_count: output.length,
    prediction_count: output.reduce((sum, station) => sum + station.predictions.length, 0),
    subordinate_station_count: subordinateCount,
    excluded_noaa_duplicates: excludedNoaa,
    skipped_without_usable_model_or_datum: skipped,
    prediction_errors: errors,
    prediction_error_examples: errorExamples,
    source: "Open Waters Slackwater Tide Database and @slackwater/engine",
    commercial_use_only: true,
    stations: output
  };

  await fs.mkdir(SITE_DATA, { recursive: true });
  const temp = new URL("../site/data/openwaters-tides.tmp", import.meta.url);
  await fs.writeFile(temp, JSON.stringify(document), "utf8");
  await fs.rename(temp, OUTPUT);

  console.log(
    `Wrote ${output.length} commercial-use Open Waters stations (${subordinateCount} subordinate) and ${document.prediction_count} high/low events. Excluded ${excludedNoaa} NOAA duplicates; skipped ${skipped} records without usable models/datums; prediction errors: ${errors}.`
  );
}

main().catch(error => {
  console.error(error);
  process.exitCode = 1;
});
