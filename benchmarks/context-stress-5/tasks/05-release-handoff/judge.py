import argparse, json
from pathlib import Path
p=argparse.ArgumentParser(); p.add_argument('--workspace',type=Path,required=True); a=p.parse_args()
w=a.workspace.resolve(); here=Path(__file__).resolve().parent
checks={}; edge=False; notes=[]

import csv
checks={k:False for k in ('security','capacity','billing','dependencies','owner_handoff')}
try:
    services=json.loads((here/'visible/inputs/services.json').read_text())
    capacity={(x['service_id'],x['region']):x for x in json.loads((here/'stages/02/inputs/capacity.json').read_text())}
    billing={(x['service_id'],x['region']):x for x in json.loads((here/'stages/04/inputs/billing.json').read_text())}
    deps={(x['service_id'],x['region']):x['depends_on'] for x in json.loads((here/'stages/05/inputs/dependencies.json').read_text())}
    security=json.loads((here/'stages/06/inputs/security.json').read_text()); latest={}
    for f in security['findings']:
        if f['finding_id'] not in latest or f['revision']>latest[f['finding_id']]['revision']: latest[f['finding_id']]=f
    expected={}; owners={}
    for service in services:
        key=(service['service_id'],service['region']); c=capacity[key]; b=billing[key]; blockers=[]
        required=(c['peak_rps']*10+c['capacity_per_replica_rps']*7-1)//(c['capacity_per_replica_rps']*7)
        replicas=max(required,service['current_replicas']); cost=replicas*720*b['hourly_cents']
        if replicas>c['max_replicas']: blockers.append('capacity')
        if cost>b['monthly_budget_cents']: blockers.append('budget')
        for f in latest.values():
            if (f['service_id'],f['region'])!=key or not f['active']: continue
            waived=any(v['finding_id']==f['finding_id'] and v['region']==f['region'] and v['expires_day']>='2026-10-01' for v in security['waivers'])
            if f['severity']=='critical' or f['severity']=='high' and not waived: blockers.append('security:'+f['finding_id'])
        expected[key]={'service_id':key[0],'region':key[1],'recommended_replicas':replicas,'monthly_cost_cents':cost,'direct_blockers':sorted(blockers),'blocked_by':[],'decision':'ready'}; owners[key]=service['owner']
    def ancestors(key):
        found=set()
        for sid in deps[key]:
            found.add(sid); found.update(ancestors((sid,key[1])))
        return found
    for key,row in expected.items():
        row['blocked_by']=sorted(sid for sid in ancestors(key) if expected[(sid,key[1])]['direct_blockers'])
        row['decision']='blocked' if row['direct_blockers'] or row['blocked_by'] else 'ready'
    want=[expected[k] for k in sorted(expected)]; got=json.loads((w/'output/readiness.json').read_text())
    matched=len(got)==len(want) and [(x.get('service_id'),x.get('region')) for x in got]==sorted(expected)
    def groups(predicate): return matched and all(predicate(r,e) for r,e in zip(got,want))
    checks['security']=groups(lambda r,e:[x for x in r['direct_blockers'] if x.startswith('security:')]==[x for x in e['direct_blockers'] if x.startswith('security:')])
    checks['capacity']=groups(lambda r,e:r['recommended_replicas']==e['recommended_replicas'] and ('capacity' in r['direct_blockers'])==('capacity' in e['direct_blockers']))
    checks['billing']=groups(lambda r,e:r['monthly_cost_cents']==e['monthly_cost_cents'] and ('budget' in r['direct_blockers'])==('budget' in e['direct_blockers']))
    checks['dependencies']=groups(lambda r,e:set(r)==set(e) and r['direct_blockers']==e['direct_blockers'] and r['blocked_by']==e['blocked_by'] and r['decision']==e['decision'])
    actions=[['owner','service_id','region','blocker']]+[list(row) for row in sorted((owners[k],k[0],k[1],blocker) for k in expected for blocker in expected[k]['direct_blockers'])]
    actual_actions=list(csv.reader((w/'output/owner-actions.csv').open(newline='',encoding='utf-8')))
    regions=sorted({k[1] for k in expected}); summary={label+'_by_region':{reg:sum(r['region']==reg and r['decision']==label for r in want) for reg in regions} for label in ('ready','blocked')}
    checks['owner_handoff']=actual_actions==actions and json.loads((w/'output/summary.json').read_text())==summary
    indexed={(r['service_id'],r['region']):r for r in got}
    edge='security:EDGE-CRITICAL' in indexed[('svc-001','eu-west')]['direct_blockers'] and 'security:EDGE-EXPIRY' not in indexed[('svc-002','eu-west')]['direct_blockers'] and 'security:EDGE-SCOPE' in indexed[('svc-003','eu-west')]['direct_blockers'] and 'security:EDGE-CLEARED' not in indexed[('svc-004','us-east')]['direct_blockers']
except Exception as e: notes.append(type(e).__name__+': '+str(e))

passed=sum(checks.values())
print(json.dumps({'status':'pass' if passed==5 and edge else 'fail','progress_level':5 if passed==5 and edge else 4 if passed==5 else 3 if passed else 1,'main_checks_passed':passed,'main_checks_total':5,'edge_check_passed':bool(edge),'checks':checks,'notes':notes},sort_keys=True))
