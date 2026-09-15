#!/usr/bin/env python3.12
from __future__ import annotations
import argparse,csv,json,re,shutil,subprocess,tempfile
from decimal import Decimal
from pathlib import Path

PY="/usr/bin/python3.12"; CAP=6000

def run(argv,cwd,timeout=90):
    with tempfile.TemporaryFile() as out, tempfile.TemporaryFile() as err:
        try: p=subprocess.run(argv,cwd=cwd,stdout=out,stderr=err,timeout=timeout,env={"PATH":"/usr/bin:/bin","PYTHONHASHSEED":"0"})
        except (OSError,subprocess.TimeoutExpired) as exc:return 124,str(exc)[:CAP]
        out.seek(0);err.seek(0)
        return p.returncode,(out.read(CAP)+err.read(CAP)).decode("utf-8","replace")

def copytree(src,dst):
    if dst.exists(): shutil.rmtree(dst)
    shutil.copytree(src,dst)

def make_fixture(task,candidate,kind):
    root=Path(tempfile.mkdtemp(prefix=f"pcbench29-{kind}-"))
    rc,detail=run([PY,"-E","-S",str(task/"seed.py"),"--workspace",str(root),"--fixture",kind],task)
    if rc: raise RuntimeError("seed failed: "+detail[:300])
    copytree(candidate,root/"budgetdesk")
    # Generators run in a separate directory. Only their declared payload is copied.
    payload=Path(tempfile.mkdtemp(prefix="pcbench29-stage-"))
    try:
        rc,detail=run([PY,"-E","-S",str(task/"stages/splits/_generate.py"),"--output",str(payload),"--fixture",kind],task/"stages/splits")
        if rc: raise RuntimeError("split generator failed: "+detail[:300])
        shutil.copytree(payload,root,dirs_exist_ok=True)
    finally: shutil.rmtree(payload,ignore_errors=True)
    for rel in ("stages/export/EXPORT.md","stages/export/stage.json","stages/export/inputs/export_schema.json"):
        src=task/rel; dst=root/src.relative_to(task/"stages/export")
        dst.parent.mkdir(parents=True,exist_ok=True);shutil.copy2(src,dst)
    return root

def command(root,*args): return run([PY,"-E","-S","-m","budgetdesk",*args],root)

COLUMNS = ["source_account","source_id","date","description","amount","category","kind","split_part","split_amount","split_category"]


def unique_object(pairs):
    result = {}
    for key, value in pairs:
        if key in result:
            raise ValueError("duplicate JSON member")
        result[key] = value
    return result


def money_text(value):
    if not isinstance(value, str) or re.fullmatch(r"-?\d+\.\d{2}", value) is None:
        raise ValueError("money must be a two-decimal string")
    number = Decimal(value)
    return f"{number if number else Decimal(0):.2f}"


def read_exports(root):
    csvpath = root/"output/transactions.csv"
    if b"\r" in csvpath.read_bytes() or not csvpath.read_bytes().endswith(b"\n"):
        raise ValueError("export CSV must use LF")
    with csvpath.open(encoding="utf-8",newline="") as f:
        rd=csv.DictReader(f); header=rd.fieldnames; rows=list(rd)
    if any(None in row or None in row.values() for row in rows):
        raise ValueError("malformed CSV row")
    def read(name):
        return json.loads((root/"output"/name).read_text(encoding="utf-8"), object_pairs_hook=unique_object)
    return header,rows,read("transactions.json"),read("monthly.json"),read("split_errors.json")


def reference_exports(kind):
    # Complete independent fixture values, including the supplied legacy transaction.
    values = [
        ("legacy-card","legacy-april","2025-04-30","ARCHIVED PURCHASE","-9.99","Uncategorized","spending"),
        ("checking-001","a-pay","2025-05-02","ACME PAYROLL","3000.00","Earned Income","income"),
        ("checking-001","a-rent","2025-05-03","MAY RENT","-1200.00","Housing","spending"),
        ("checking-001","a-grocery","2025-05-08","Neighborhood GROCER","-45.50","Groceries","spending"),
        ("checking-001","shared-7","2025-05-15","TRANSFER TO SAVINGS","-500.00","Internal Transfer","transfer"),
        ("savings-01","shared-7","2025-05-15","TRANSFER FROM CHECKING","500.00","Internal Transfer","transfer"),
        ("savings-01","b-freelance","2025-05-20","Freelance payment","1100.00","Earned Income","income"),
        ("savings-01","b-grocery","2025-05-22","Market grocer","-73.00","Groceries","spending"),
        ("savings-01","b-util","2025-05-28","City utilities","-120.00","Utilities","spending"),
    ]
    result=[]
    for row in values:
        parts=[("","","")]
        if row[1]=="a-rent" and kind=="main":
            parts=[("1","-1000.00","Housing"),("2","-200.00","Home Office")]
        if row[1]=="b-util":
            parts=[("1","-80.00","Utilities"),("2","-40.00","Internet")]
        result.extend(dict(zip(COLUMNS,(*row,*part))) for part in parts)
    return result


def output_checks(root,kind):
    header,rows,data,report,errors=read_exports(root)
    expected=reference_exports(kind)
    if not isinstance(report,dict) or not isinstance(errors,list):
        raise ValueError("wrong report or errors shape")
    normalized=[]
    for row in rows:
        copy=row.copy();copy["amount"]=money_text(row["amount"])
        if row["split_amount"]:copy["split_amount"]=money_text(row["split_amount"])
        normalized.append(copy)
    base=lambda row:tuple(row[k] for k in COLUMNS[:7])
    check1={base(r) for r in normalized}=={base(r) for r in expected}
    check2=len(normalized)==len(expected) and len({(r["source_account"],r["source_id"],r["split_part"]) for r in rows})==len(rows)
    cats={"Groceries":"118.50","Home Office":"200.00","Housing":"1000.00","Internet":"40.00","Utilities":"80.00"}
    variance={"Groceries":"81.50","Home Office":"50.00","Housing":"300.00","Internet":"20.00","Utilities":"70.00"}
    if kind=="edge":
        del cats["Home Office"];cats["Housing"]="1200.00"
        variance.update({"Home Office":"250.00","Housing":"100.00"})
    wanted={"month":"2025-05","income":"4100.00","spending":"1438.50","transfers_in":"500.00","transfers_out":"500.00","categories":cats,"budget_variance":variance}
    normalized_report=report.copy()
    for field in ("income","spending","transfers_in","transfers_out"):
        normalized_report[field]=money_text(report[field])
    ordered=True
    for field in ("categories","budget_variance"):
        if not isinstance(report[field],dict):raise ValueError("category totals must be an object")
        ordered &= list(report[field])==sorted(report[field])
        normalized_report[field]={k:money_text(v) for k,v in report[field].items()}
    check3=ordered and normalized_report==wanted
    errors_ok=errors==[] if kind=="main" else (
        len(errors)==1 and isinstance(errors[0],dict)
        and set(errors[0])=={"source_account","source_id","error"}
        and errors[0]["source_account"]=="checking-001" and errors[0]["source_id"]=="a-rent"
        and isinstance(errors[0]["error"],str) and bool(errors[0]["error"].strip()))
    check4=errors_ok and normalized==expected
    check5=header==COLUMNS and data==rows and (root/"output/transactions.json").read_bytes().endswith(b"\n")
    return [check1,check2,check3,check4,check5]

def evaluate(task,candidate,kind):
    root=make_fixture(task,candidate,kind); logs=[]; runnable=False
    try:
        cmds=[
          ("import", "workspace/budget.db","inputs/accounts.json","inputs/statements"),
          ("import", "workspace/budget.db","inputs/accounts.json","inputs/statements"),
          ("report","workspace/budget.db","--month","2025-05","--output","output/monthly.json"),
          ("export","workspace/budget.db","--format","csv","--output","output/transactions.csv"),
          ("export","workspace/budget.db","--format","json","--output","output/transactions.json"),
        ]
        for args in cmds:
            rc,detail=command(root,*args); logs.append(detail)
            if args[0]=="import": runnable=True
            if rc: return ([False]*5 if kind=="main" else False),runnable,False,"command failed: "+detail[:500],root
        checks=output_checks(root,kind)
        return (checks if kind=="main" else all(checks)),runnable,True,"",root
    except (OSError,UnicodeError,csv.Error,json.JSONDecodeError,KeyError,ValueError,TypeError) as exc:
        return ([False]*5 if kind=="main" else False),runnable,False,"malformed output: "+str(exc)[:500],root

def main():
    p=argparse.ArgumentParser();p.add_argument("--workspace",type=Path,required=True);a=p.parse_args()
    task=Path(__file__).resolve().parent; candidate=a.workspace.resolve()/"budgetdesk"
    if not candidate.is_dir() or not any(candidate.glob("*.py")):
        print(json.dumps({"status":"fail","progress_level":0,"main_checks_passed":0,"main_checks_total":5,"edge_check_passed":False,"notes":[]}));return
    roots=[];notes=[]
    try:
        checks,runnable,parsed,detail,root=evaluate(task,candidate,"main");roots.append(root)
        if detail:notes.append(detail)
        edge,_,_,detail,root=evaluate(task,candidate,"edge");roots.append(root)
        if detail:notes.append(detail)
        passed=sum(bool(x) for x in checks)
        level=5 if passed==5 and edge else 4 if passed==5 else 3 if passed>=2 else 2 if parsed else 1 if runnable else 0
        result={"status":"pass" if level==5 else "fail","progress_level":level,"main_checks_passed":passed,"main_checks_total":5,"edge_check_passed":bool(edge),"notes":notes[:2]}
        print(json.dumps(result,sort_keys=True))
    except Exception as exc:
        print(json.dumps({"status":"error","progress_level":1,"main_checks_passed":0,"main_checks_total":5,"edge_check_passed":False,"notes":[str(exc)[:500]]},sort_keys=True))
    finally:
        for root in roots:shutil.rmtree(root,ignore_errors=True)
if __name__=="__main__":main()
