#!/usr/bin/env python3
"""Regenerate lib/aishe.js (and its screen-cv copy) from the AISHE institutions list.
Usage: python3 scripts/aishe-names.py <path to aishe-institutions-list/data/institutions.json>
Source: github.com/BrahmjotSingh0/aishe-institutions-list (MIT)."""
import json, re, sys, shutil
d = json.load(open(sys.argv[1]))
INST = re.compile(r'\b(?:university|universit[yi]|college|institute|institution|iit|iiit|nit|bits|vit|srm|school|vidyalaya|vidyapeeth|academy|polytechnic|mahavidyalaya|campus|mahavid\w*|mahavidh\w*|vishwavid\w*|vishvavid\w*|vidhyalay\w*|vidyalay\w*|vidyapith|shikshan|sansthan)\b')
GENERIC = set("""computer computers education educational technology technologies information management research science sciences data software centre center centres training development studies study health care medical hospital paramedical nursing pharmacy technical engineering business commerce arts law professional skill skills institute of and the for in at on with india indian national international global new modern advanced advance digital systems system solutions services service it online learning knowledge career careers society trust foundation group academy art design fashion film media mass communication applied allied life clinical laboratory lab labs analytics analysis finance financial accounting accounts marketing hotel hospitality tourism aviation agricultural agriculture rural urban human resource resources public private government govt state central regional district community social welfare rehabilitation mission school teacher teachers physical yoga music fine performing""".split())
S = set()
for x in d:
    n = re.sub(r'\([^)]*\)', '', x['name'])
    n = re.sub(r'[^a-z0-9]+', ' ', n.lower()).strip()
    w = n.split()
    if len(w) < 2 or len(n) < 8 or INST.search(n): continue
    rest = [t for t in w if t not in GENERIC and not t.isdigit()]
    if not rest or (len(rest) == 1 and len(w) <= 3 and len(rest[0]) < 4): continue
    S.add(n)
hdr = open('lib/aishe.js').read().split('export const')[0]
open('lib/aishe.js', 'w').write(hdr + 'export const AISHE_NAMES = ' + json.dumps("\n".join(sorted(S))) + ';\n')
shutil.copy('lib/aishe.js', 'supabase/functions/_shared/screening/aishe.js')
print(len(S), 'names')
