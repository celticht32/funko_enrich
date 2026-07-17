import json
d = json.load(open('funkodex_base_catalog.enriched.json', encoding='utf-8'))
print('total records:', len(d))
# how many lack _id?
no_id = sum(1 for r in d if '_id' not in r)
print('records missing _id:', no_id)
# show keys of first record + first record lacking _id
print('first record keys:', list(d[0].keys())[:12])
if no_id:
    bad = next(r for r in d if '_id' not in r)
    print('a record with no _id — keys:', list(bad.keys())[:12])
    print('  its title/id-ish fields:', {k:bad.get(k) for k in ['title','id','handle','funkoNumber'] if k in bad})