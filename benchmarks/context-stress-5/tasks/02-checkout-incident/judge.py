import argparse, json
from pathlib import Path
p=argparse.ArgumentParser(); p.add_argument('--workspace',type=Path,required=True); a=p.parse_args()
w=a.workspace.resolve(); here=Path(__file__).resolve().parent
checks={}; edge=False; notes=[]

checks={key:False for key in ('cause','corrected_chain','affected_requests','rollback','unchanged_settings')}
try:
    r=json.loads((w/'output/incident.json').read_text()); got=json.loads((w/'config/runtime.json').read_text())
    original=json.loads((here/'visible/config/runtime.json').read_text())
    checks['cause']=all(r.get(k)==v for k,v in {'release_id':'r2026.40','region':'eu-west','route':'checkout','cause_event_id':'deploy-causal-0042'}.items())
    checks['corrected_chain']=all(r.get(k)==v for k,v in {'first_error_event_id':'checkout-error-00','first_customer_event_id':'gateway-fail-00','first_customer_utc_ms':1790589620000}.items())
    checks['affected_requests']=r.get('failed_request_ids')==[f'checkout-{i:03}' for i in range(7)]
    checks['rollback']=got['regions']['eu-west']['checkout']['timeout_ms']==1200 and r.get('rollback_timeout_ms')==1200
    original['regions']['eu-west']['checkout']['timeout_ms']=1200
    checks['unchanged_settings']=got==original
    fields={'release_id','region','route','cause_event_id','first_error_event_id','first_customer_event_id','first_customer_utc_ms','failed_request_ids','rollback_timeout_ms','excluded_reused_request_count'}
    edge=r.get('excluded_reused_request_count')==1 and r.get('failed_request_ids')==[f'checkout-{i:03}' for i in range(7)] and set(r)==fields
except Exception as e: notes.append(type(e).__name__+': '+str(e))

passed=sum(checks.values())
print(json.dumps({'status':'pass' if passed==5 and edge else 'fail','progress_level':5 if passed==5 and edge else 4 if passed==5 else 3 if passed else 1,'main_checks_passed':passed,'main_checks_total':5,'edge_check_passed':bool(edge),'checks':checks,'notes':notes},sort_keys=True))
