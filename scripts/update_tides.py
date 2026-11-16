#!/usr/bin/env python3
"""Refresh the SurferToday global tide map from NOAA CO-OPS.

Uses only Python's standard library. NOAA predictions are forecasts, not live
water-level observations. Requests are deliberately sequential and spaced.
"""
import argparse
import datetime as dt
import json
import sys
import time
import urllib.error
import urllib.parse
import urllib.request
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
OUTPUT = ROOT / "site" / "data" / "tides.json"
MDAPI = "https://api.tidesandcurrents.noaa.gov/mdapi/prod/webapi"
DATA_API = "https://api.tidesandcurrents.noaa.gov/api/prod/datagetter"
USER_AGENT = "SurferToday-Live-Tide-Map/1.0 (NOAA CO-OPS data client)"
UTC = dt.timezone.utc


def get_json(url, params=None, timeout=45):
    if params:
        url += ("&" if "?" in url else "?") + urllib.parse.urlencode(params)
    req = urllib.request.Request(
        url,
        headers={"User-Agent": USER_AGENT, "Accept": "application/json"}
    )
    with urllib.request.urlopen(req, timeout=timeout) as response:
        return json.loads(response.read().decode("utf-8"))


def get_stations():
    payload = get_json(
        f"{MDAPI}/stations.json",
        {"type": "tidepredictions"},
        timeout=90
    )
    cleaned, seen = [], set()
    for item in payload.get("stations", []):
        sid = str(item.get("id", "")).strip()
        try:
            lat, lon = float(item["lat"]), float(item["lng"])
        except (KeyError, TypeError, ValueError):
            continue
        if not sid or sid in seen or not (-90 <= lat <= 90 and -180 <= lon <= 180):
            continue
        seen.add(sid)
        cleaned.append({
            "id": sid,
            "name": item.get("name") or "Unnamed station",
            "state": item.get("state") or "",
            "lat": lat,
            "lon": lon,
            "type": item.get("type") or "",
            "reference_id": item.get("reference_id") or ""
        })
    if not cleaned:
        raise RuntimeError("NOAA returned no tide-prediction stations.")
    return cleaned


def request_predictions(sid, start, end, datum, delay):
    params = {
        "begin_date": start.strftime("%Y%m%d"),
        "end_date": end.strftime("%Y%m%d"),
        "station": sid,
        "product": "predictions",
        "datum": datum,
        "time_zone": "gmt",
        "units": "metric",
        "interval": "hilo",
        "format": "json"
    }
    try:
        payload = get_json(DATA_API, params, timeout=45)
    except (urllib.error.URLError, TimeoutError, json.JSONDecodeError) as exc:
        return None, str(exc)
    finally:
        time.sleep(delay)

    if "error" in payload:
        err = payload["error"]
        return None, err.get("message", "NOAA API error") if isinstance(err, dict) else str(err)

    events = []
    for item in payload.get("predictions", []):
        try:
            when = dt.datetime.strptime(item["t"], "%Y-%m-%d %H:%M").replace(tzinfo=UTC)
            kind = item.get("type", "").upper()
            if start <= when <= end and kind in ("H", "L"):
                events.append({
                    "time_utc": when.strftime("%Y-%m-%dT%H:%M:%SZ"),
                    "kind": "High" if kind == "H" else "Low",
                    "height_m": float(item["v"])
                })
        except (KeyError, TypeError, ValueError):
            continue
    return events, None


def get_available_datums(sid, delay):
    url = f"{MDAPI}/stations/{urllib.parse.quote(sid)}/datums.json"
    try:
        payload = get_json(url, timeout=40)
    except Exception:
        time.sleep(delay)
        return []
    finally:
        # The request is intentionally spaced from the next NOAA request.
        pass
    time.sleep(delay)

    if isinstance(payload, list):
        records = payload
    elif isinstance(payload, dict):
        records = payload.get("datums", payload.get("datumList", []))
        if isinstance(records, dict):
            records = records.get("datumList", records.get("datums", []))
    else:
        records = []
    names = []
    for record in records or []:
        if isinstance(record, dict):
            name = record.get("name") or record.get("datum")
            if name and name not in names:
                names.append(name)
    return names


def fetch_station(station, start, end, delay):
    sid = station["id"]
    # MLLW is the standard first choice. If unavailable, use a datum explicitly
    # listed by NOAA for that station. Eugene Island is a known MSL-only case.
    events, error = request_predictions(sid, start, end, "MLLW", delay)
    datum_used = "MLLW"
    if error and ("datum" in error.lower() or "no predictions" in error.lower()):
        alternatives = get_available_datums(sid, delay)
        preferred = ["MLW", "MTL", "MSL", "MHW", "MHHW", "NAVD", "STND"]
        ordered = [d for d in preferred if d in alternatives]
        ordered.extend(d for d in alternatives if d not in ordered and d != "MLLW")
        if sid == "8764311" and "MSL" not in ordered:
            ordered.insert(0, "MSL")
        for alternative in ordered:
            events, alternative_error = request_predictions(sid, start, end, alternative, delay)
            if not alternative_error:
                datum_used, error = alternative, None
                break
            error = alternative_error
    return {
        **station,
        "datum": datum_used if not error else None,
        "predictions": events if events is not None else [],
        "error": error
    }


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("--delay", type=float, default=1.5,
                        help="Seconds between NOAA requests; default 1.5.")
    parser.add_argument("--hours", type=int, default=48,
                        help="Prediction horizon in hours; default 48.")
    args = parser.parse_args()
    if args.delay < 0.5:
        parser.error("Use a delay of at least 0.5 seconds to avoid excessive NOAA requests.")
    if args.hours < 24 or args.hours > 168:
        parser.error("--hours must be between 24 and 168.")

    start = dt.datetime.now(UTC).replace(second=0, microsecond=0)
    end = start + dt.timedelta(hours=args.hours)
    print("Downloading NOAA tide-prediction station metadata...")
    stations = get_stations()
    print(f"Found {len(stations):,} stations. Prediction window: {start.isoformat()} to {end.isoformat()}")

    output_stations = []
    failures = []
    for index, station in enumerate(stations, 1):
        result = fetch_station(station, start, end, args.delay)
        output_stations.append(result)
        if result["error"]:
            failures.append((station["id"], result["error"]))
        if index % 25 == 0 or index == len(stations):
            event_count = sum(len(s["predictions"]) for s in output_stations)
            print(f"{index:,}/{len(stations):,} processed | {event_count:,} tide events | {len(failures)} errors")

    document = {
        "generated_at_utc": start.strftime("%Y-%m-%dT%H:%M:%SZ"),
        "window_start_utc": start.strftime("%Y-%m-%dT%H:%M:%SZ"),
        "window_end_utc": end.strftime("%Y-%m-%dT%H:%M:%SZ"),
        "station_count": len(output_stations),
        "prediction_count": sum(len(s["predictions"]) for s in output_stations),
        "error_count": len(failures),
        "source": "NOAA CO-OPS Data API",
        "stations": output_stations
    }
    OUTPUT.parent.mkdir(parents=True, exist_ok=True)
    temp = OUTPUT.with_suffix(".tmp")
    temp.write_text(json.dumps(document, separators=(",", ":"), ensure_ascii=False), encoding="utf-8")
    temp.replace(OUTPUT)

    if failures:
        report = ROOT / "noaa-errors.txt"
        report.write_text("\n".join(f"{sid}: {message}" for sid, message in failures), encoding="utf-8")
        print(f"{len(failures)} stations returned errors. See noaa-errors.txt.")
    elif (ROOT / "noaa-errors.txt").exists():
        (ROOT / "noaa-errors.txt").unlink()

    print(f"Updated {OUTPUT} with {len(output_stations):,} stations and {document['prediction_count']:,} tide events.")


if __name__ == "__main__":
    main()