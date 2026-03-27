#!/usr/bin/env python3
"""
patch_rh_historical_weather.py
================================
Patches an existing historical_weather.json by fetching ONLY relative
humidity data from the Open-Meteo Historical Weather API and adding
rh_hi and rh_lo arrays to each point record.

Does NOT re-fetch temperature data — existing hi/lo/hi_app/lo_app arrays
are left completely untouched.

RESUME CAPABILITY
-----------------
Progress is saved to a cache file (RH_CACHE_FILE) after every successful
point fetch. Re-running the script will skip points already in the cache.

USAGE
-----
Expected folder structure:
    trails/florida-trail/
        data/
            points.json                  <- lat/lon source
            historical_weather.json      <- existing file to patch (input + output)
        tools/
            patch_rh_historical_weather.py   <- this script
            rh_patch_cache.json              <- resume cache (auto-created)

Run from the tools/ directory:
    cd trails/florida-trail/tools
    python3 patch_rh_historical_weather.py

REQUIREMENTS
------------
Python 3.8+, no third-party packages required (uses urllib only).
"""

import json
import os
import time
import urllib.request
import urllib.error
from collections import defaultdict
from datetime import date, timedelta

# ── Configuration ─────────────────────────────────────────────────────────────

POINTS_FILE   = "../data/points.json"
HW_FILE       = "../data/historical_weather.json"   # patched in place
RH_CACHE_FILE = "rh_patch_cache.json"               # resume cache in tools/

ARCHIVE_BASE  = "https://archive-api.open-meteo.com/v1/archive"

# Must match the range used when original historical_weather.json was generated
# so the smoothed averages are comparable. Read from the file's meta if present.
HIST_YEARS    = 7
HIST_END      = date.today() - timedelta(days=2)
HIST_START    = date(HIST_END.year - HIST_YEARS, HIST_END.month, HIST_END.day)

DELAY_BETWEEN_CALLS_S = 2.5
MAX_RETRIES           = 3
RETRY_DELAY_S         = 10.0
SMOOTH_WINDOW_DAYS    = 3   # must match original generation script

# ── Date helpers ──────────────────────────────────────────────────────────────

def to_iso(d):
    return d.strftime("%Y-%m-%d")

def day_of_year_index(month, day):
    """0-based index into a 365-value array. Uses fixed non-leap year 2021."""
    ref  = date(2021, month, day)
    jan1 = date(2021, 1, 1)
    return (ref - jan1).days  # 0..364

# ── Open-Meteo fetch ──────────────────────────────────────────────────────────

def build_url(lat, lon, start_date, end_date):
    params = "&".join([
        f"latitude={lat}",
        f"longitude={lon}",
        f"start_date={start_date}",
        f"end_date={end_date}",
        "daily=relative_humidity_2m_max,relative_humidity_2m_min",
        "timezone=auto",
    ])
    return f"{ARCHIVE_BASE}?{params}"

def fetch_rh_data(point_id, lat, lon):
    """Fetch 7 years of daily RH data for one lat/lon. Returns parsed JSON."""
    url = build_url(lat, lon, to_iso(HIST_START), to_iso(HIST_END))

    last_err = None
    for attempt in range(1, MAX_RETRIES + 1):
        try:
            with urllib.request.urlopen(url, timeout=30) as resp:
                return json.loads(resp.read().decode("utf-8"))
        except (urllib.error.URLError, urllib.error.HTTPError, OSError) as e:
            last_err = e
            if attempt < MAX_RETRIES:
                print(f"    Attempt {attempt} failed ({e}). Retrying in {RETRY_DELAY_S}s...")
                time.sleep(RETRY_DELAY_S)

    raise RuntimeError(f"All {MAX_RETRIES} attempts failed for {point_id}: {last_err}")

# ── RH normals computation ────────────────────────────────────────────────────

def compute_rh_normals(daily):
    """
    Given Open-Meteo 'daily' dict, return two 365-element lists: rh_hi, rh_lo.
    Each value is the window-smoothed average for that day-of-year, rounded
    to nearest integer %. Uses the same smoothing logic as the main script.
    """
    times  = daily.get("time", [])
    rh_max = daily.get("relative_humidity_2m_max", [])
    rh_min = daily.get("relative_humidity_2m_min", [])

    buckets = {
        "rh_hi": defaultdict(list),
        "rh_lo": defaultdict(list),
    }

    for i, date_str in enumerate(times):
        try:
            parts = date_str.split("-")
            m, d  = int(parts[1]), int(parts[2])
        except (IndexError, ValueError):
            continue

        if m == 2 and d == 29:
            continue  # skip Feb 29 — no slot in 365-value array

        idx = day_of_year_index(m, d)

        if i < len(rh_max) and rh_max[i] is not None:
            buckets["rh_hi"][idx].append(rh_max[i])
        if i < len(rh_min) and rh_min[i] is not None:
            buckets["rh_lo"][idx].append(rh_min[i])

    def smooth_average(bucket_dict, idx):
        vals = []
        for offset in range(-SMOOTH_WINDOW_DAYS, SMOOTH_WINDOW_DAYS + 1):
            neighbor = (idx + offset) % 365
            vals.extend(bucket_dict.get(neighbor, []))
        if not vals:
            return None
        return round(sum(vals) / len(vals))

    rh_hi = [smooth_average(buckets["rh_hi"], i) for i in range(365)]
    rh_lo = [smooth_average(buckets["rh_lo"], i) for i in range(365)]

    return rh_hi, rh_lo

# ── Cache (resume support) ────────────────────────────────────────────────────

def load_cache():
    if not os.path.exists(RH_CACHE_FILE):
        return {}
    try:
        with open(RH_CACHE_FILE, "r", encoding="utf-8") as f:
            data = json.load(f)
        print(f"Resuming from cache: {len(data)} points already fetched.")
        return data
    except (json.JSONDecodeError, OSError) as e:
        print(f"Warning: could not read cache ({e}). Starting fresh.")
        return {}

def save_cache(cache):
    tmp = RH_CACHE_FILE + ".tmp"
    with open(tmp, "w", encoding="utf-8") as f:
        json.dump(cache, f)
    os.replace(tmp, RH_CACHE_FILE)

# ── Main ──────────────────────────────────────────────────────────────────────

def main():
    print("=" * 60)
    print("Florida Trail — RH Patch for historical_weather.json")
    print("=" * 60)
    print(f"Historical range : {to_iso(HIST_START)} → {to_iso(HIST_END)} ({HIST_YEARS} years)")
    print(f"Smoothing window : ±{SMOOTH_WINDOW_DAYS} days")
    print(f"Delay per call   : {DELAY_BETWEEN_CALLS_S}s")
    print()

    # Load existing historical_weather.json
    if not os.path.exists(HW_FILE):
        raise FileNotFoundError(f"Cannot find {HW_FILE}")
    with open(HW_FILE, "r", encoding="utf-8") as f:
        hw = json.load(f)

    hw_points = hw["points"]
    print(f"Loaded {len(hw_points)} points from historical_weather.json")

    # Check if already patched
    already_patched = sum(1 for p in hw_points if "rh_hi" in p and "rh_lo" in p)
    if already_patched == len(hw_points):
        print("All points already have rh_hi/rh_lo. Nothing to do.")
        return
    if already_patched > 0:
        print(f"Note: {already_patched} points already have RH data (will be skipped).")

    # Load points.json for lat/lon lookup
    if not os.path.exists(POINTS_FILE):
        raise FileNotFoundError(f"Cannot find {POINTS_FILE}")
    with open(POINTS_FILE, "r", encoding="utf-8") as f:
        all_points = json.load(f)
    pts_by_id = {str(p["id"]): p for p in all_points}
    print(f"Loaded {len(pts_by_id)} points from points.json for lat/lon lookup")
    print()

    # Load resume cache
    cache = load_cache()

    # Identify which points still need fetching
    todo = [
        p for p in hw_points
        if p["id"] not in cache and ("rh_hi" not in p or "rh_lo" not in p)
    ]
    print(f"Already fetched  : {len(hw_points) - len(todo)}")
    print(f"Remaining to fetch: {len(todo)}")
    print()

    if not todo:
        print("All points already in cache. Proceeding to patch file...")
    else:
        for i, hw_point in enumerate(todo, start=1):
            pid = hw_point["id"]
            src = pts_by_id.get(pid)

            if not src:
                print(f"[{i}/{len(todo)}] WARNING: {pid} not found in points.json — skipping.")
                continue

            lat = src["lat"]
            lon = src["lon"]
            print(f"[{i}/{len(todo)}] {pid}  (lat={lat:.4f}, lon={lon:.4f})")

            try:
                raw   = fetch_rh_data(pid, lat, lon)
                daily = raw.get("daily", {})

                if not daily.get("time"):
                    print(f"  WARNING: No daily data returned. Skipping.")
                    time.sleep(DELAY_BETWEEN_CALLS_S)
                    continue

                rh_hi, rh_lo = compute_rh_normals(daily)

                # Sanity check
                for arr_name, arr in [("rh_hi", rh_hi), ("rh_lo", rh_lo)]:
                    none_count = sum(1 for v in arr if v is None)
                    if none_count > 36:
                        print(f"  WARNING: {arr_name} has {none_count}/365 None values.")

                cache[pid] = {"rh_hi": rh_hi, "rh_lo": rh_lo}
                save_cache(cache)
                print(f"  ✓ Cached.")

            except RuntimeError as e:
                print(f"  ERROR: {e} — skipping, will retry on next run.")
                time.sleep(DELAY_BETWEEN_CALLS_S)
                continue

            if i < len(todo):
                time.sleep(DELAY_BETWEEN_CALLS_S)

    # Patch the historical_weather.json in place
    print()
    print("Patching historical_weather.json...")

    patched     = 0
    not_in_cache = 0

    for hw_point in hw_points:
        pid = hw_point["id"]

        # Already has RH from a previous patch run — leave it alone
        if "rh_hi" in hw_point and "rh_lo" in hw_point:
            patched += 1
            continue

        if pid not in cache:
            not_in_cache += 1
            continue

        hw_point["rh_hi"] = cache[pid]["rh_hi"]
        hw_point["rh_lo"] = cache[pid]["rh_lo"]
        patched += 1

    # Update meta to document the new arrays
    hw["meta"]["arrays"]["rh_hi"] = "avg daily max relative humidity (%)"
    hw["meta"]["arrays"]["rh_lo"] = "avg daily min relative humidity (%)"

    # Write output atomically
    tmp_out = HW_FILE + ".tmp"
    with open(tmp_out, "w", encoding="utf-8") as f:
        json.dump(hw, f, separators=(",", ":"))
    os.replace(tmp_out, HW_FILE)

    size_kb = os.path.getsize(HW_FILE) / 1024
    print(f"Done. {patched}/{len(hw_points)} points patched.")
    print(f"File size: {size_kb:.1f} KB")

    if not_in_cache:
        print(f"WARNING: {not_in_cache} point(s) missing from cache — re-run to fetch them.")
    else:
        print(f"All points patched successfully.")
        print(f"You can delete {RH_CACHE_FILE} if desired.")

if __name__ == "__main__":
    main()
