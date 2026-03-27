#!/usr/bin/env python3
"""
generate_ft_historical_weather.py
==================================
Generates historical_weather.json for the Florida Trail.

For each sampled point, fetches 7 years of daily data from the
Open-Meteo Historical Weather API and averages by MM-DD to produce
365-value planning normals:

    hi      — avg daily max dry-bulb temperature (°F)
    lo      — avg daily min dry-bulb temperature (°F)
    hi_app  — avg daily max apparent temperature / Steadman feels-like (°F)
    lo_app  — avg daily min apparent temperature / Steadman feels-like (°F)

RESUME CAPABILITY
-----------------
Progress is saved to a cache file (CACHE_FILE) after every successful
point fetch. If the script is interrupted, re-running it will skip any
point whose data is already in the cache and only fetch the remainder.

RATE LIMITING
-------------
DELAY_BETWEEN_CALLS_S controls the pause between API requests.
Default is 2.5 seconds — generous but not excessive.
Open-Meteo's free tier allows ~10,000 calls/day; 331 points is well within that.

USAGE
-----
Expected folder structure:
    trails/florida-trail/
        data/
            points.json              <- input (read from here)
            historical_weather.json  <- output (written here)
        tools/
            generate_ft_historical_weather.py  <- this script
            ft_weather_cache.json              <- resume cache (auto-created)

Run from the tools/ directory:
    cd trails/florida-trail/tools
    python3 generate_ft_historical_weather.py

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

# ── Configuration ────────────────────────────────────────────────────────────

POINTS_FILE   = "../data/points.json"              # Input: FT points (in data/ sibling folder)
CACHE_FILE    = "ft_weather_cache.json"            # Resume cache stays in tools/ alongside script
OUTPUT_FILE   = "../data/historical_weather.json"  # Final output goes to data/ folder

# Open-Meteo archive API
ARCHIVE_BASE  = "https://archive-api.open-meteo.com/v1/archive"

# 7-year historical window (keep end date 2 days behind today to ensure data availability)
HIST_YEARS    = 7
HIST_END      = date.today() - timedelta(days=2)
HIST_START    = date(HIST_END.year - HIST_YEARS, HIST_END.month, HIST_END.day)

# Rate limiting — pause between each API call
DELAY_BETWEEN_CALLS_S = 2.5

# Retry settings per point
MAX_RETRIES   = 3
RETRY_DELAY_S = 10.0   # Wait longer before each retry

# Smoothing window (±N days when averaging MM-DD normals)
# Set to 0 for no smoothing; 3 gives a ±3 day window (7-day centered average)
SMOOTH_WINDOW_DAYS = 3

# Sampling: ~1 point per this many trail miles per section, minimum 3 per section
SAMPLE_EVERY_N_MILES = 5
SAMPLE_MIN_PER_SECTION = 3

# ── Date helpers ──────────────────────────────────────────────────────────────

def to_iso(d):
    return d.strftime("%Y-%m-%d")

def day_of_year_index(month, day):
    """
    Return 0-based index into a 365-value array for a given MM/DD,
    using a fixed non-leap reference year (2021).
    Index 0 = Jan 1, index 364 = Dec 31.
    """
    ref = date(2021, month, day)
    jan1 = date(2021, 1, 1)
    return (ref - jan1).days  # 0..364

def md_window_indices(month, day, window):
    """
    Return a list of day-of-year indices covering a ±window centered on MM/DD.
    Wraps around year boundaries (Dec 31 → Jan 1).
    """
    center = day_of_year_index(month, day)
    indices = []
    for offset in range(-window, window + 1):
        idx = (center + offset) % 365
        indices.append(idx)
    return indices

# ── Sampling ─────────────────────────────────────────────────────────────────

def select_sample_points(all_points):
    """
    Select ~1 point per SAMPLE_EVERY_N_MILES from each section,
    with a minimum of SAMPLE_MIN_PER_SECTION points per section.
    Points are chosen at evenly spaced positions within the section.
    Returns a list of point dicts.
    """
    by_section = defaultdict(list)
    for p in all_points:
        by_section[p["section_id"]].append(p)

    for s in by_section:
        by_section[s].sort(key=lambda p: p["axis_mile"])

    sampled = []
    for section_id, plist in sorted(by_section.items()):
        miles = [p["axis_mile"] for p in plist]
        span  = max(miles) - min(miles)

        n = max(SAMPLE_MIN_PER_SECTION, round(span / SAMPLE_EVERY_N_MILES) + 1)

        if len(plist) <= n:
            chosen = plist
        else:
            indices = [round(i * (len(plist) - 1) / (n - 1)) for i in range(n)]
            indices = sorted(set(indices))
            chosen  = [plist[i] for i in indices]

        sampled.extend(chosen)

    return sampled

# ── Open-Meteo fetch ──────────────────────────────────────────────────────────

def build_url(lat, lon, start_date, end_date):
    params = "&".join([
        f"latitude={lat}",
        f"longitude={lon}",
        f"start_date={start_date}",
        f"end_date={end_date}",
        "daily=temperature_2m_max,temperature_2m_min,apparent_temperature_max,apparent_temperature_min",
        "temperature_unit=fahrenheit",
        "timezone=auto",
    ])
    return f"{ARCHIVE_BASE}?{params}"

def fetch_point_data(point):
    """
    Fetch 7 years of daily data for one point.
    Returns the parsed JSON dict, or raises on failure.
    Retries up to MAX_RETRIES times on network/HTTP errors.
    """
    url = build_url(
        lat=point["lat"],
        lon=point["lon"],
        start_date=to_iso(HIST_START),
        end_date=to_iso(HIST_END),
    )

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

    raise RuntimeError(f"All {MAX_RETRIES} attempts failed for point {point['id']}: {last_err}")

# ── Normals computation ───────────────────────────────────────────────────────

def compute_normals(daily):
    """
    Given the Open-Meteo 'daily' dict (with 'time', 'temperature_2m_max', etc.),
    return four 365-element lists: hi, lo, hi_app, lo_app.

    Each value is the window-smoothed average for that day-of-year across all years,
    rounded to the nearest integer °F.
    None is stored as null (kept as Python None here, JSON serializer handles it).
    """
    times    = daily.get("time", [])
    t_max    = daily.get("temperature_2m_max", [])
    t_min    = daily.get("temperature_2m_min", [])
    app_max  = daily.get("apparent_temperature_max", [])
    app_min  = daily.get("apparent_temperature_min", [])

    # Bucket raw values by day-of-year index (0..364)
    buckets = {
        "hi":     defaultdict(list),
        "lo":     defaultdict(list),
        "hi_app": defaultdict(list),
        "lo_app": defaultdict(list),
    }

    for i, date_str in enumerate(times):
        try:
            parts = date_str.split("-")
            m, d  = int(parts[1]), int(parts[2])
        except (IndexError, ValueError):
            continue

        # Skip Feb 29 — no valid index in a 365-value non-leap reference year
        if m == 2 and d == 29:
            continue

        idx = day_of_year_index(m, d)

        if t_max[i]   is not None: buckets["hi"][idx].append(t_max[i])
        if t_min[i]   is not None: buckets["lo"][idx].append(t_min[i])
        if app_max[i] is not None: buckets["hi_app"][idx].append(app_max[i])
        if app_min[i] is not None: buckets["lo_app"][idx].append(app_min[i])

    def smooth_average(bucket_dict, idx):
        """Gather values from ±SMOOTH_WINDOW_DAYS around idx, return rounded mean or None."""
        vals = []
        for offset in range(-SMOOTH_WINDOW_DAYS, SMOOTH_WINDOW_DAYS + 1):
            neighbor = (idx + offset) % 365
            vals.extend(bucket_dict.get(neighbor, []))
        if not vals:
            return None
        return round(sum(vals) / len(vals))

    hi     = [smooth_average(buckets["hi"],     i) for i in range(365)]
    lo     = [smooth_average(buckets["lo"],     i) for i in range(365)]
    hi_app = [smooth_average(buckets["hi_app"], i) for i in range(365)]
    lo_app = [smooth_average(buckets["lo_app"], i) for i in range(365)]

    return hi, lo, hi_app, lo_app

# ── Cache (resume support) ────────────────────────────────────────────────────

def load_cache():
    """Load existing progress cache, or return empty dict if none exists."""
    if not os.path.exists(CACHE_FILE):
        return {}
    try:
        with open(CACHE_FILE, "r", encoding="utf-8") as f:
            data = json.load(f)
        print(f"Resuming from cache: {len(data)} points already completed.")
        return data
    except (json.JSONDecodeError, OSError) as e:
        print(f"Warning: could not read cache file ({e}). Starting fresh.")
        return {}

def save_cache(cache):
    """Write the current cache to disk atomically (write-then-rename)."""
    tmp = CACHE_FILE + ".tmp"
    with open(tmp, "w", encoding="utf-8") as f:
        json.dump(cache, f)
    os.replace(tmp, CACHE_FILE)

# ── Output assembly ───────────────────────────────────────────────────────────

def assemble_output(sampled_points, cache):
    """Build the final historical_weather.json structure from the cache."""
    points_out = []
    for p in sampled_points:
        pid = p["id"]
        if pid not in cache:
            continue  # Skip any point that somehow wasn't fetched
        entry = cache[pid]
        points_out.append({
            "id":     pid,
            "hi":     entry["hi"],
            "lo":     entry["lo"],
            "hi_app": entry["hi_app"],
            "lo_app": entry["lo_app"],
        })

    return {
        "meta": {
            "trail":            "florida-trail",
            "id_format":        "ft-{section_id}-mi{axis_mile*1000} or ft-main-mi{axis_mile*1000}",
            "normals_source":   "Open-Meteo Historical Weather API (ERA5-Land)",
            "normals_range":    f"{to_iso(HIST_START)}..{to_iso(HIST_END)}",
            "normals_years":    HIST_YEARS,
            "normals_dataset":  "ERA5-Land",
            "temperature_unit": "fahrenheit",
            "smoothing_window_days": SMOOTH_WINDOW_DAYS,
            "sampling_strategy": f"~1 point per {SAMPLE_EVERY_N_MILES} trail miles per section, min {SAMPLE_MIN_PER_SECTION}",
            "total_points":     len(points_out),
            "arrays": {
                "hi":     "avg daily max dry-bulb temperature (365 values, Jan 1 = index 0)",
                "lo":     "avg daily min dry-bulb temperature",
                "hi_app": "avg daily max apparent temperature (Steadman feels-like / heat index)",
                "lo_app": "avg daily min apparent temperature (Steadman feels-like / wind chill)",
            },
        },
        "points": points_out,
    }

# ── Main ──────────────────────────────────────────────────────────────────────

def main():
    print("=" * 60)
    print("Florida Trail — Historical Weather Generator")
    print("=" * 60)
    print(f"Historical range : {to_iso(HIST_START)} → {to_iso(HIST_END)} ({HIST_YEARS} years)")
    print(f"Smoothing window : ±{SMOOTH_WINDOW_DAYS} days")
    print(f"Delay per call   : {DELAY_BETWEEN_CALLS_S}s")
    print(f"Points file      : {POINTS_FILE}")
    print(f"Cache file       : {CACHE_FILE}")
    print(f"Output file      : {OUTPUT_FILE}")
    print()

    # Load points
    if not os.path.exists(POINTS_FILE):
        raise FileNotFoundError(
            f"Cannot find {POINTS_FILE}. "
            "Place points.json in the same directory as this script."
        )
    with open(POINTS_FILE, "r", encoding="utf-8") as f:
        all_points = json.load(f)
    print(f"Loaded {len(all_points)} total FT points.")

    # Select sample
    sampled = select_sample_points(all_points)
    print(f"Sampled {len(sampled)} points for weather fetch.")
    print()

    # Load resume cache
    cache = load_cache()

    # Identify which points still need fetching
    todo = [p for p in sampled if p["id"] not in cache]
    already_done = len(sampled) - len(todo)

    print(f"Already fetched  : {already_done}")
    print(f"Remaining to fetch: {len(todo)}")
    print()

    if not todo:
        print("All points already fetched. Assembling output...")
    else:
        # Fetch loop
        for i, point in enumerate(todo, start=1):
            pid = point["id"]
            section = point["section_id"]
            axis_mile = point["axis_mile"]

            print(f"[{i}/{len(todo)}] {pid}  ({section}, mile {axis_mile})")

            try:
                raw = fetch_point_data(point)
                daily = raw.get("daily", {})

                if not daily.get("time"):
                    print(f"  WARNING: No daily data returned. Skipping.")
                    # Don't cache — will retry on next run
                    time.sleep(DELAY_BETWEEN_CALLS_S)
                    continue

                hi, lo, hi_app, lo_app = compute_normals(daily)

                # Sanity check: warn if any array has more than 10% None values
                for arr_name, arr in [("hi", hi), ("lo", lo), ("hi_app", hi_app), ("lo_app", lo_app)]:
                    none_count = sum(1 for v in arr if v is None)
                    if none_count > 36:  # >10% of 365
                        print(f"  WARNING: {arr_name} has {none_count}/365 None values.")

                cache[pid] = {
                    "hi":     hi,
                    "lo":     lo,
                    "hi_app": hi_app,
                    "lo_app": lo_app,
                }

                save_cache(cache)
                print(f"  ✓ Saved to cache. ({already_done + i}/{len(sampled)} total done)")

            except RuntimeError as e:
                print(f"  ERROR: {e}")
                print(f"  Skipping this point. It will be retried on next run.")
                time.sleep(DELAY_BETWEEN_CALLS_S)
                continue

            # Polite delay between calls
            if i < len(todo):
                time.sleep(DELAY_BETWEEN_CALLS_S)

    # Assemble and write final output
    print()
    print("Assembling final output...")
    output = assemble_output(sampled, cache)

    completed = len(output["points"])
    total     = len(sampled)

    if completed < total:
        print(f"WARNING: Only {completed}/{total} points have data.")
        print("         Run the script again to fetch the missing points.")
        print("         The output file will be written with available data only.")

    tmp_out = OUTPUT_FILE + ".tmp"
    with open(tmp_out, "w", encoding="utf-8") as f:
        json.dump(output, f, separators=(",", ":"))  # compact — no extra whitespace
    os.replace(tmp_out, OUTPUT_FILE)

    size_kb = os.path.getsize(OUTPUT_FILE) / 1024
    print(f"Done. Wrote {completed} points to {OUTPUT_FILE} ({size_kb:.1f} KB)")
    print()

    if completed == total:
        print("All points fetched successfully.")
        print(f"You can now delete {CACHE_FILE} if desired.")
    else:
        missing = total - completed
        print(f"{missing} point(s) still missing. Re-run the script to complete them.")

if __name__ == "__main__":
    main()
