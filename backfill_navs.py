#!/usr/bin/env python3
"""
Backfill Wafrah Public NAV history into Firestore.
Default range: 2025-07-01 through today.
Writes:
  - meezan/portfolio.navHistory
  - public/navHistory.navHistory
  - meezan/fyHistory
  - public/fyHistory
  - latest successful date into meezan/navs and public/navs
"""

import argparse
import time
from datetime import date, datetime, timedelta
import requests

from fetch_navs import (
    ALL_TRACKED_FUNDS,
    HEADERS,
    MUFAP_URL,
    init_firebase,
    match_fund,
    parse_html_navs,
)


def fiscal_year(day):
    if day.month >= 7:
        return f"FY{day.year}-{str(day.year + 1)[2:]}"
    return f"FY{day.year - 1}-{str(day.year)[2:]}"


def fetch_navs_for_date(day):
    date_ymd = day.strftime('%Y-%m-%d')
    date_dmy = day.strftime('%d/%m/%Y')
    attempts = [
        lambda: requests.post(MUFAP_URL, data={'nav_date': date_ymd, 'date': date_ymd, 'filter_date': date_ymd}, headers=HEADERS, timeout=25),
        lambda: requests.post(MUFAP_URL, data={'nav_date': date_dmy, 'date': date_dmy, 'filter_date': date_dmy}, headers=HEADERS, timeout=25),
        lambda: requests.get(MUFAP_URL, params={'nav_date': date_ymd, 'date': date_ymd, 'filter_date': date_ymd}, headers=HEADERS, timeout=25),
        lambda: requests.get(MUFAP_URL, params={'nav_date': date_dmy, 'date': date_dmy, 'filter_date': date_dmy}, headers=HEADERS, timeout=25),
    ]
    for i, attempt in enumerate(attempts, start=1):
        try:
            resp = attempt()
            if resp.status_code == 200 and len(resp.content) > 1000:
                parsed = parse_html_navs(resp.text)
                if parsed:
                    tracked = {}
                    for fund in ALL_TRACKED_FUNDS:
                        nav = match_fund(parsed, fund)
                        if nav and nav > 0:
                            tracked[fund] = nav
                    if tracked:
                        return tracked
        except Exception as exc:
            print(f"      attempt {i} failed: {exc}")
        time.sleep(0.15)
    return {}


def merge_fy(fy_history, day, navs):
    fy = fiscal_year(day)
    cur = fy_history.setdefault(fy, {})
    for fund, nav in navs.items():
        item = cur.setdefault(fund, {'high': nav, 'low': nav})
        if nav > item.get('high', 0):
            item['high'] = nav
        if nav < item.get('low', float('inf')):
            item['low'] = nav


def daterange(start, end):
    day = start
    while day <= end:
        yield day
        day += timedelta(days=1)


def parse_args():
    ap = argparse.ArgumentParser()
    ap.add_argument('--start', default='2025-07-01', help='Start date YYYY-MM-DD')
    ap.add_argument('--end', default=date.today().isoformat(), help='End date YYYY-MM-DD')
    ap.add_argument('--include-weekends', action='store_true', help='Try weekends too')
    ap.add_argument('--sleep', type=float, default=0.35, help='Seconds between dates')
    return ap.parse_args()


def main():
    args = parse_args()
    start = date.fromisoformat(args.start)
    end = date.fromisoformat(args.end)
    db = init_firebase()
    print(f"Backfilling NAVs from {start} to {end}")

    port_ref = db.collection('meezan').document('portfolio')
    port_doc = port_ref.get()
    nav_history = port_doc.to_dict().get('navHistory', {}) if port_doc.exists else {}

    fy_ref = db.collection('meezan').document('fyHistory')
    fy_doc = fy_ref.get()
    fy_history = fy_doc.to_dict() if fy_doc.exists else {}

    latest_date = None
    latest_navs = None
    fetched = skipped = failed = 0

    for day in daterange(start, end):
        if not args.include_weekends and day.weekday() >= 5:
            skipped += 1
            continue
        iso = day.isoformat()
        if iso in nav_history and nav_history[iso]:
            skipped += 1
            continue
        print(f"  {iso} ...", end='', flush=True)
        navs = fetch_navs_for_date(day)
        if not navs:
            print(' no data')
            failed += 1
            time.sleep(args.sleep)
            continue
        nav_history[iso] = navs
        merge_fy(fy_history, day, navs)
        latest_date = iso
        latest_navs = navs
        fetched += 1
        print(f" {len(navs)} NAVs")
        time.sleep(args.sleep)

    now = datetime.utcnow().isoformat() + 'Z'
    port_ref.set({'navHistory': nav_history, 'lastBackfilledAt': now}, merge=True)
    db.collection('public').document('navHistory').set({'navHistory': nav_history, 'lastBackfilledAt': now}, merge=True)
    fy_ref.set(fy_history)
    db.collection('public').document('fyHistory').set(fy_history)

    if latest_navs:
        nav_doc = {'navs': latest_navs, 'success': True, 'updatedAt': now, 'lastChecked': now, 'sourceDate': latest_date}
        db.collection('meezan').document('navs').set(nav_doc)
        db.collection('public').document('navs').set(nav_doc)

    print('\nDone.')
    print(f"Fetched days: {fetched}")
    print(f"Skipped days: {skipped}")
    print(f"No-data days: {failed}")
    print(f"History dates stored: {len(nav_history)}")
    if latest_date:
        print(f"Latest NAV document source date: {latest_date}")


if __name__ == '__main__':
    main()
