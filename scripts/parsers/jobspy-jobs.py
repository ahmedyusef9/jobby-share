#!/usr/bin/env python3
"""JobSpy -> jobs-json-v1 bridge for scan.mjs's local_parser provider.

Covers the boards that have no upstream provider and no public API: LinkedIn,
Indeed, Google Jobs, Glassdoor, Bayt. JobSpy reverse-engineers their endpoints,
so a board silently returning zero rows is expected drift, not a bug here.

Lives in scripts/ rather than providers/, which update-system.mjs replaces
wholesale on every update.

Launched through jobspy-jobs.mjs, never directly: JobSpy needs Python >= 3.10
and the system python3 is 3.9, so it runs from .venv-jobspy.

Indentation is 2-space because .editorconfig's [*] rule is authoritative in this
repo, not PEP 8's 4.
"""

import argparse
import json
import logging
import sys

DEFAULT_RESULTS = 20
DEFAULT_HOURS = 336  # 14 days


def parse_args(argv):
  parser = argparse.ArgumentParser(add_help=False)
  parser.add_argument('--site', action='append', dest='sites', default=[])
  parser.add_argument('--term', action='append', dest='terms', default=[])
  parser.add_argument('--location', default='')
  parser.add_argument('--results', type=int, default=DEFAULT_RESULTS)
  parser.add_argument('--hours', type=int, default=DEFAULT_HOURS)
  parser.add_argument('--country', default='')
  parser.add_argument('--distance', type=int, default=0)
  parser.add_argument('--google-term', dest='google_term', default='')
  # Indeed returns Hebrew city names and an "IL" country code, neither of which
  # matches portals.yml's English location_filter. Appending the English country
  # makes always_allow fire instead of every row dropping as unknown-location.
  parser.add_argument('--location-suffix', dest='location_suffix', default='')
  args = parser.parse_args(argv)

  if not args.sites:
    raise SystemExit('jobspy-jobs: at least one --site is required')
  if not args.terms:
    raise SystemExit('jobspy-jobs: at least one --term is required')
  return args


def silence_library_output():
  """Keep stdout pure JSON.

  Two separate leaks: JobSpy's loggers attach a StreamHandler bound to the real
  sys.stdout at import time (so reassigning sys.stdout later does not reach
  them), and some code paths print directly. Scrub the handlers AND swap
  sys.stdout, returning the original stream to emit JSON on.
  """
  real_stdout = sys.stdout

  for name, logger in logging.root.manager.loggerDict.items():
    if not isinstance(logger, logging.Logger):
      continue
    if 'jobspy' in name.lower():
      logger.handlers = [logging.NullHandler()]
      logger.propagate = False
      logger.setLevel(logging.CRITICAL)

  sys.stdout = sys.stderr
  return real_stdout


def normalize_location(value, suffix):
  text = '' if value is None else str(value).strip()
  if text.lower() in ('', 'nan', 'none'):
    text = ''
  if suffix and suffix.lower() not in text.lower():
    text = f'{text}, {suffix}' if text else suffix
  return text


def normalize_posted(value):
  text = '' if value is None else str(value).strip()
  if text.lower() in ('', 'nan', 'none'):
    return ''
  if len(text) >= 10 and text[4] == '-' and text[7] == '-':
    return text[:10]
  return ''


DESCRIPTION_MAX = 4000


def normalize_description(value):
  text = '' if value is None else str(value).strip()
  if text.lower() in ('', 'nan', 'none'):
    return ''
  # Collapse whitespace; keep markdown-ish newlines as spaces for JSON size.
  text = ' '.join(text.split())
  if len(text) > DESCRIPTION_MAX:
    text = text[: DESCRIPTION_MAX - 1].rstrip() + '…'
  return text


def normalize_row(row, suffix):
  title = str(row.get('title') or '').strip()
  url = str(row.get('job_url') or row.get('job_url_direct') or '').strip()
  if not title or not url or url.lower() == 'nan':
    return None

  company = str(row.get('company') or '').strip()
  if company.lower() == 'nan':
    company = ''

  job = {
    'title': title,
    'url': url,
    'company': company,
    'location': normalize_location(row.get('location'), suffix),
    'postedAt': normalize_posted(row.get('date_posted')),
  }
  description = normalize_description(row.get('description'))
  if description:
    job['description'] = description
  return job


def scrape(args):
  from jobspy import scrape_jobs

  by_url = {}
  failures = []
  attempts = 0

  for site in args.sites:
    for term in args.terms:
      attempts += 1
      kwargs = {
        'site_name': [site],
        'search_term': term,
        'results_wanted': args.results,
        'hours_old': args.hours,
        'verbose': 0,
        'description_format': 'markdown',
      }
      # LinkedIn list scrape omits JD text unless this flag fetches each posting.
      if site == 'linkedin':
        kwargs['linkedin_fetch_description'] = True
      if args.location:
        kwargs['location'] = args.location
      if args.distance and args.distance > 0:
        kwargs['distance'] = args.distance
      if site in ('indeed', 'glassdoor') and args.country:
        kwargs['country_indeed'] = args.country
      if site == 'google':
        kwargs['google_search_term'] = args.google_term or f'{term} jobs {args.location}'.strip()

      try:
        frame = scrape_jobs(**kwargs)
      except Exception as err:  # one dead board must not abort the whole scan
        failures.append(f'{site}/{term}: {type(err).__name__}: {err}')
        continue

      if frame is None or len(frame) == 0:
        continue
      for row in frame.to_dict('records'):
        job = normalize_row(row, args.location_suffix)
        if job:
          by_url[job['url']] = job

  # Every attempt erroring out is a real failure (no network, JobSpy broken,
  # blocked IP). Some attempts merely returning nothing is a normal quiet scan.
  if failures and len(failures) == attempts:
    raise RuntimeError('every board failed -> ' + ' | '.join(failures))
  for failure in failures:
    print(f'jobspy-jobs: {failure}', file=sys.stderr)

  return list(by_url.values())


def main():
  args = parse_args(sys.argv[1:])
  real_stdout = silence_library_output()
  jobs = scrape(args)
  json.dump(jobs, real_stdout)
  real_stdout.flush()


if __name__ == '__main__':
  try:
    main()
  except Exception as err:
    print(f'jobspy-jobs: {err}', file=sys.stderr)
    sys.exit(1)
