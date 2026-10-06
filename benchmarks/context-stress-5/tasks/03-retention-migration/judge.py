import argparse, json
from pathlib import Path
p=argparse.ArgumentParser(); p.add_argument('--workspace',type=Path,required=True); a=p.parse_args()
w=a.workspace.resolve(); here=Path(__file__).resolve().parent
checks={}; edge=False; notes=[]

import sqlite3, tempfile, shutil
from datetime import date
checks={k:False for k in ('keys_names_rows','emails','decisions','counts_and_sources','private_export')}
def evaluate(db):
    with tempfile.TemporaryDirectory() as td:
        target=Path(td)/'db.sqlite'; shutil.copyfile(db,target); c=sqlite3.connect(target)
        original=c.execute('SELECT * FROM customers ORDER BY customer_key').fetchall()
        holds=c.execute('SELECT * FROM holds').fetchall(); tickets=c.execute('SELECT * FROM tickets').fetchall(); opts=c.execute('SELECT * FROM opt_outs').fetchall()
        counts={key:sum(t[1]==key and t[2] in ('open','pending') for t in tickets) for key,*_ in original}
        expected=[]; emails=[]
        for key,name,email,last in original:
            if (key,) in opts: action,reason='redact','opt_out'
            elif any(k==key and until>='2026-10-01' for k,until in holds): action,reason='keep','legal_hold'
            elif counts[key]: action,reason='keep','open_support'
            elif (date(2026,10,1)-date.fromisoformat(last)).days>90: action,reason='redact','stale'
            else: action,reason='keep','active'
            expected.append((key,action,reason,counts[key])); emails.append((key,None if action=='redact' else email))
        sql=(w/'solution/migrate.sql').read_text(); c.executescript(sql)
        def snapshot():
            return [c.execute(statement).fetchall() for statement in (
                'SELECT * FROM customers ORDER BY customer_key',
                'SELECT customer_key,action,reason,open_ticket_count FROM retention_decisions ORDER BY customer_key',
                'SELECT * FROM customer_export ORDER BY customer_key')]
        first=snapshot(); c.executescript(sql); stable=first==snapshot()
        after=c.execute('SELECT * FROM customers ORDER BY customer_key').fetchall()
        decisions=c.execute('SELECT customer_key,action,reason,open_ticket_count FROM retention_decisions ORDER BY customer_key').fetchall()
        cur=c.execute('SELECT * FROM customer_export ORDER BY customer_key'); fields=[d[0] for d in cur.description]; exported=cur.fetchall()
        result={
          'keys_names_rows':[(r[0],r[1],r[3]) for r in after]==[(r[0],r[1],r[3]) for r in original],
          'emails':[(r[0],r[2]) for r in after]==emails,
          'decisions':[r[:3] for r in decisions]==[r[:3] for r in expected],
          'counts_and_sources':[(r[0],r[3]) for r in decisions]==[(r[0],r[3]) for r in expected] and c.execute('SELECT * FROM holds').fetchall()==holds and c.execute('SELECT * FROM tickets').fetchall()==tickets and c.execute('SELECT * FROM opt_outs').fetchall()==opts,
          'private_export':fields==['customer_key','state','open_ticket_count'] and exported==[(r[0],r[1],r[3]) for r in expected] and c.execute("SELECT type FROM sqlite_master WHERE name='customer_export'").fetchone()==('view',)
        }; c.close(); return {key:bool(value and stable) for key,value in result.items()}
try:
    checks=evaluate(here/'stages/06/inputs/customers.sqlite'); edge=all(evaluate(here/'edge/customers.sqlite').values())
except Exception as e: notes.append(type(e).__name__+': '+str(e))

passed=sum(checks.values())
print(json.dumps({'status':'pass' if passed==5 and edge else 'fail','progress_level':5 if passed==5 and edge else 4 if passed==5 else 3 if passed else 1,'main_checks_passed':passed,'main_checks_total':5,'edge_check_passed':bool(edge),'checks':checks,'notes':notes},sort_keys=True))
