import argparse, json
from pathlib import Path
p=argparse.ArgumentParser(); p.add_argument('--workspace',type=Path,required=True); a=p.parse_args()
w=a.workspace.resolve(); here=Path(__file__).resolve().parent
checks={}; edge=False; notes=[]

import subprocess, tempfile, shutil, csv
checks={k:False for k in ('line_pricing','carrier_shipping','revision_holds','cli_legacy_contract','csv_text')}
def expected(data):
    latest={}
    for h in data['holds']:
        if h['event_id'] not in latest or h['revision']>latest[h['event_id']]['revision']: latest[h['event_id']]=h
    result=[]
    for order in data['orders']:
        subtotal=discount=tax=weight=0
        for item in order['items']:
            gross=item['unit_cents']*item['quantity']; d=(gross*item['discount_bps']+5000)//10000
            subtotal+=gross; discount+=d; tax+=((gross-d)*item['tax_bps']+5000)//10000; weight+=item['weight_g']*item['quantity']
        hazardous=any(i['hazardous'] for i in order['items'])
        available=sorted((c['flat_cents']+((weight+999)//1000)*c['per_kg_cents'],c['carrier_id']) for c in data['carriers'] if order['zone'] in c['zones'] and (not hazardous or c['hazardous']))
        held=any(h['order_id']==order['order_id'] and h['active'] for h in latest.values())
        status='held' if held else 'ready' if available else 'unsupported'
        shipping=available[0][0] if status=='ready' and subtotal-discount<data['policy']['free_shipping_min_cents'] else 0
        result.append(dict(order_id=order['order_id'],status=status,carrier_id=available[0][1] if status=='ready' else None,subtotal_cents=subtotal,discount_cents=discount,tax_cents=tax,shipping_cents=shipping,total_cents=subtotal-discount+tax+shipping if status=='ready' else 0))
    return result

def evaluate(path):
    data=json.loads(path.read_text()); want=expected(data)
    with tempfile.TemporaryDirectory() as td:
        td=Path(td); shutil.copytree(w/'service',td/'service'); shutil.copyfile(path,td/'orders.json')
        run=subprocess.run(['node','service/bin/route.mjs','orders.json','output'],cwd=td,capture_output=True,text=True,timeout=120)
        if run.returncode: raise ValueError('CLI failed: '+run.stderr[-1000:])
        got=json.loads((td/'output/plan.json').read_text()); rows=list(csv.reader((td/'output/labels.csv').open(newline='',encoding='utf-8')))
        legacy=subprocess.run(['node','--input-type=module','-e',"import {quote} from './service/src/pricing.mjs'; console.log(JSON.stringify([quote([{unit_cents:199,quantity:3},{unit_cents:2,quantity:2}]),quote([])]));"],cwd=td,capture_output=True,text=True,timeout=10)
        def columns(names): return len(got)==len(want) and all([r.get(k) for k in names]==[e[k] for k in names] for r,e in zip(got,want))
        label_want=[['order_id','customer_name','status','carrier_id','total_cents']]+[[r['order_id'],o['customer_name'],r['status'],r['carrier_id'] or '',str(r['total_cents'])] for r,o in zip(want,data['orders'])]
        return {
         'line_pricing':columns(['subtotal_cents','discount_cents','tax_cents','total_cents']) and all(type(r[k]) is int for r in got for k in ('subtotal_cents','discount_cents','tax_cents','total_cents')),
         'carrier_shipping':columns(['carrier_id','shipping_cents']),
         'revision_holds':columns(['status']),
         'cli_legacy_contract':columns(['order_id']) and all(set(r)==set(want[0]) for r in got) and legacy.returncode==0 and json.loads(legacy.stdout)==[601,0],
         'csv_text':rows==label_want
        }
try:
    checks=evaluate(here/'stages/06/inputs/orders.json'); edge=all(evaluate(here/'edge/orders.json').values())
except Exception as e: notes.append(type(e).__name__+': '+str(e))

passed=sum(checks.values())
print(json.dumps({'status':'pass' if passed==5 and edge else 'fail','progress_level':5 if passed==5 and edge else 4 if passed==5 else 3 if passed else 1,'main_checks_passed':passed,'main_checks_total':5,'edge_check_passed':bool(edge),'checks':checks,'notes':notes},sort_keys=True))
