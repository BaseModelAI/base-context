import argparse, json
from pathlib import Path
p=argparse.ArgumentParser(); p.add_argument('--workspace',type=Path,required=True); a=p.parse_args()
w=a.workspace.resolve(); here=Path(__file__).resolve().parent
checks={}; edge=False; notes=[]

import sqlite3, csv
names=['merchant_id','capture_cents','refund_cents','chargeback_cents','net_cents']
checks={key:False for key in names}
def oracle(db):
    c=sqlite3.connect(f'file:{db}?mode=ro',uri=True)
    totals={x[0]:[0,0,0,0] for x in c.execute('SELECT merchant_id FROM merchants')}
    rates=dict(c.execute('SELECT * FROM fx')); orders={r[0]:r[1:] for r in c.execute('SELECT * FROM orders')}
    latest={}
    for r in c.execute('SELECT * FROM events'):
        if r[0] not in latest or r[1]>latest[r[0]][1]: latest[r[0]]=r
    components={oid:[0,0,0] for oid in orders}
    for _,_,oid,kind,cents,status in latest.values():
        if status==('posted' if kind=='chargeback' else 'settled'):
            components[oid][['capture','refund','chargeback'].index(kind)]+=cents
    for oid,(mid,currency,state) in orders.items():
        if state!='complete': continue
        cap,ref,cb=components[oid]; ref=min(ref,cap); cb=min(cb,max(0,cap-ref))
        cap,ref,cb=[(v*rates[currency]+5000)//10000 for v in (cap,ref,cb)]
        for i,v in enumerate((cap,ref,cb,cap-ref-cb)): totals[mid][i]+=v
    c.close(); return [(mid,*values) for mid,values in sorted(totals.items())]
def candidate(db):
    c=sqlite3.connect(f'file:{db}?mode=ro',uri=True); c.execute('PRAGMA query_only=ON')
    # Bound only the judge's SQL runtime; the task deadline belongs to the native runner.
    steps=0
    def limit():
        nonlocal steps
        steps+=1; return int(steps>50000)
    c.set_progress_handler(limit,10000)
    cur=c.execute((w/'solution/reconcile.sql').read_text())
    if [d[0] for d in cur.description]!=names: raise ValueError('wrong columns')
    rows=cur.fetchall(); c.close(); return rows
try:
    db=here/'stages/06/inputs/settlement.sqlite'; got=candidate(db); expected=oracle(db)
    with (w/'output/reconciliation.csv').open(newline='',encoding='utf-8') as stream:
        exported=list(csv.reader(stream))
    for i,key in enumerate(names):
        checks[key]=(len(got)==len(expected) and [r[i] for r in got]==[r[i] for r in expected]
            and (i==0 or all(type(r[i]) is int for r in got))
            and bool(exported) and exported[0]==names and len(exported)==len(expected)+1
            and all(len(r)==5 for r in exported)
            and [r[i] for r in exported[1:]]==[str(r[i]) for r in expected])
    edge=candidate(here/'edge/settlement.sqlite')==oracle(here/'edge/settlement.sqlite')
except Exception as e: notes.append(type(e).__name__+': '+str(e))

passed=sum(checks.values())
print(json.dumps({'status':'pass' if passed==5 and edge else 'fail','progress_level':5 if passed==5 and edge else 4 if passed==5 else 3 if passed else 1,'main_checks_passed':passed,'main_checks_total':5,'edge_check_passed':bool(edge),'checks':checks,'notes':notes},sort_keys=True))
