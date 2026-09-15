#!/usr/bin/env python3
"""Direct main-and-edge judge for Task 06."""
from __future__ import annotations
import argparse, csv, json, shutil, subprocess, sys, tempfile
from collections import Counter, defaultdict
from datetime import datetime, timedelta
from pathlib import Path

TASK_DIR=Path(__file__).resolve().parent
SF=["shift_id","seat","volunteer_id"]
UF=["shift_id","seat","required_skill","reason"]

def rcsv(path, fields):
    raw=path.read_bytes()
    if b"\r" in raw or (raw and not raw.endswith(b"\n")): raise ValueError("line endings")
    with path.open(encoding="utf-8",newline="") as h:
        r=csv.DictReader(h)
        if r.fieldnames!=fields: raise ValueError("header")
        rows = list(r)
        if any(None in row or any(value is None for value in row.values()) for row in rows): raise ValueError("malformed CSV row")
        return rows

def dt(value): return datetime.fromisoformat(value.replace("Z","+00:00"))

def generate(root, fixture):
    commands=[
      [sys.executable,str(TASK_DIR/"seed.py"),"--workspace",str(root),"--fixture",fixture],
      [sys.executable,str(TASK_DIR/"visible/_generate.py"),"--output",str(root),"--fixture",fixture]]
    for command in commands: subprocess.run(command,check=True,capture_output=True,timeout=20)

def inject(root, fixture, stage):
    subprocess.run(
        [sys.executable,str(TASK_DIR/f"stages/{stage}/_generate.py"),"--output",str(root),"--fixture",fixture],
        check=True,capture_output=True,timeout=20)

def run_candidate(root):
    return subprocess.run(
        [sys.executable,"-E","-S","-m","solution.volunteer_schedule","inputs","--output","output"],
        cwd=root,text=True,capture_output=True,timeout=300)

def execute(candidate, fixture):
    temporary=tempfile.TemporaryDirectory(prefix=f"pcbench-06-{fixture}-")
    root=Path(temporary.name); generate(root,fixture)
    if (candidate/"solution").is_dir():
        shutil.rmtree(root/"solution"); shutil.copytree(candidate/"solution",root/"solution")
    run=run_candidate(root)
    for stage in ("callout","fairness"):
        if run.returncode != 0: break
        inject(root,fixture,stage)
        run=run_candidate(root)
    return root,run,temporary

def input_data(root):
    volunteers={r["volunteer_id"]:r for r in rcsv(root/"inputs/volunteers.csv",["volunteer_id","skills","preferred_locations","max_shifts"])}
    shifts={r["shift_id"]:r for r in rcsv(root/"inputs/shifts.csv",["shift_id","start","end","location","required_skill","seats"])}
    availability=defaultdict(list)
    for r in rcsv(root/"inputs/availability.csv",["volunteer_id","start","end"]): availability[r["volunteer_id"]].append((dt(r["start"]),dt(r["end"])))
    travel={}
    for r in rcsv(root/"inputs/travel_times.csv",["from_location","to_location","minutes"]): travel[r["from_location"],r["to_location"]]=int(r["minutes"])
    unavailable=set(json.loads((root/"inputs/callout.json").read_text())["unavailable_volunteer_ids"])
    return volunteers,shifts,availability,travel,unavailable

def baseline(shifts):
    return {sid: row["location"].replace("LOC-","") for sid,row in shifts.items()}

def expected_main(shifts):
    result=baseline(shifts)
    replacements=iter(["V07","V08","V19","V20"])
    for sid in sorted(result):
        if result[sid] in {"V01","V13"}: result[sid]=next(replacements)
    return result

def legal(schedule, data):
    volunteers,shifts,availability,travel,unavailable=data
    if len(schedule)!=len({(r["shift_id"],r["seat"]) for r in schedule}): return False
    assigned=defaultdict(list); counts=Counter()
    for row in schedule:
        sid,vid=row["shift_id"],row["volunteer_id"]
        if sid not in shifts or vid not in volunteers or vid in unavailable: return False
        shift=shifts[sid]
        try: seat=int(row["seat"])
        except ValueError: return False
        if not 1<=seat<=int(shift["seats"]): return False
        if shift["required_skill"] not in volunteers[vid]["skills"].split(";"): return False
        start,end=dt(shift["start"]),dt(shift["end"])
        if not any(a<=start and end<=b for a,b in availability[vid]): return False
        assigned[vid].append((start,end,shift["location"])); counts[vid]+=1
        if counts[vid]>int(volunteers[vid]["max_shifts"]): return False
    for values in assigned.values():
        values.sort()
        for first,second in zip(values,values[1:]):
            astart,aend,aloc=first; bstart,bend,bloc=second
            if bstart<aend: return False
            need=0 if aloc==bloc else max(30,travel.get((aloc,bloc),30))
            if bstart-aend<timedelta(minutes=need): return False
    return True

def output_rows(root, data):
    schedule=rcsv(root/"output/schedule.csv",SF); unfilled=rcsv(root/"output/unfilled.csv",UF)
    volunteers,shifts,availability,travel,unavailable=data
    seats={(sid,str(seat)) for sid,shift in shifts.items() for seat in range(1,int(shift["seats"])+1)}
    for rows in (schedule,unfilled):
        for row in rows: row["seat"]=str(int(row["seat"]))
        keys=[(row["shift_id"],row["seat"]) for row in rows]
        if len(keys)!=len(set(keys)) or not set(keys)<=seats: raise ValueError("unknown or duplicate seat")
        if rows!=sorted(rows,key=lambda row:(row["shift_id"],int(row["seat"]))): raise ValueError("seat order")
    assigned=[row for row in schedule if row["volunteer_id"]]
    assigned_keys={(row["shift_id"],row["seat"]) for row in assigned}
    missing={(row["shift_id"],row["seat"]) for row in unfilled}
    blanks={(row["shift_id"],row["seat"]) for row in schedule if not row["volunteer_id"]}
    if assigned_keys & missing or assigned_keys | missing != seats or not blanks<=missing:
        raise ValueError("assigned/unfilled correspondence")
    for row in unfilled:
        shift=shifts[row["shift_id"]]
        available=any(vid not in unavailable and shift["required_skill"] in volunteer["skills"].split(";")
                      and any(a<=dt(shift["start"]) and dt(shift["end"])<=b for a,b in availability[vid])
                      for vid,volunteer in volunteers.items())
        reason="capacity_or_conflict" if available else "no_qualified_volunteer"
        if row["required_skill"]!=shift["required_skill"] or row["reason"]!=reason:
            raise ValueError("unfilled reason or skill")
    return assigned,unfilled


def json_integer(value):
    return type(value) is int or (type(value) is float and value.is_integer())


def read_summary(root):
    raw=(root/"output/summary.json").read_bytes(); value=json.loads(raw)
    integer_fields={"required_seats","filled_seats","required_skill_coverage","preference_score","assignment_count_spread","changed_assignments"}
    if not isinstance(value,dict) or set(value)!=integer_fields|{"fairness_exceptions"}:
        raise ValueError("summary fields")
    if any(not json_integer(value[field]) for field in integer_fields) or not isinstance(value["fairness_exceptions"],list):
        raise ValueError("summary types")
    if b"\r" in raw or not raw.endswith(b"\n") or list(value)!=sorted(value): raise ValueError("summary format")
    return raw,value


def module_imports(root):
    result=subprocess.run([sys.executable,"-E","-S","-c","import solution.volunteer_schedule"],cwd=root,text=True,capture_output=True,timeout=10)
    return result.returncode==0

def main():
    parser=argparse.ArgumentParser(); parser.add_argument("--workspace",required=True,type=Path); args=parser.parse_args()
    candidate=args.workspace.resolve(); artifact=(candidate/"solution/volunteer_schedule.py").is_file()
    checks=[False]*5; notes=[]; runnable=parseable=False; mt=et=None
    try:
        if artifact:
            root,run,mt=execute(candidate,"main"); runnable=run.returncode==0 or module_imports(root)
            if run.returncode != 0: notes.append("main command failed")
            else:
                try:
                    data=input_data(root); volunteers,shifts,availability,travel,unavailable=data
                    schedule,unfilled=output_rows(root,data); raw,summary=read_summary(root); parseable=True
                    actual={(r["shift_id"],r["seat"]):r["volunteer_id"] for r in schedule}
                    expected=expected_main(shifts); base=baseline(shifts)
                    checks[0]=legal(schedule,data) and schedule==sorted(schedule,key=lambda r:(r["shift_id"],int(r["seat"])))
                    checks[1]=not unfilled and len(schedule)==sum(int(r["seats"]) for r in shifts.values()) and set(actual)=={(sid,"1") for sid in shifts}
                    checks[2]=all(vid not in unavailable for vid in actual.values())
                    checks[3]=actual=={(sid,"1"):vid for sid,vid in expected.items()} and sum(actual[(sid,"1")]!=vid for sid,vid in base.items())==4
                    counts=Counter(actual.values())
                    policy=json.loads((root/"inputs/fairness.json").read_text(encoding="utf-8"))
                    minimum=int(policy["eligible_shift_minimum"]); limit=int(policy["max_count_difference"])
                    eligible=[]
                    for vid,row in volunteers.items():
                        if vid in unavailable: continue
                        eligible_shifts=sum(
                            shift["required_skill"] in row["skills"].split(";")
                            and any(a<=dt(shift["start"]) and dt(shift["end"])<=b for a,b in availability[vid])
                            for shift in shifts.values())
                        if eligible_shifts>=minimum: eligible.append(vid)
                    all_volunteer_spread=max(counts.values())-min(counts[vid] for vid in volunteers)
                    eligible_spread=max(counts[vid] for vid in eligible)-min(counts[vid] for vid in eligible)
                    expected_summary={"assignment_count_spread":all_volunteer_spread,"changed_assignments":4,"fairness_exceptions":[],"filled_seats":36,"preference_score":sum(volunteers[v]["preferred_locations"]==shifts[s]["location"] for (s,_),v in actual.items()),"required_seats":36,"required_skill_coverage":36}
                    checks[4]=summary==expected_summary and raw.endswith(b"\n") and list(summary)==sorted(summary) and eligible_spread<=limit
                except (OSError,UnicodeError,csv.Error,json.JSONDecodeError,ValueError,KeyError,TypeError,AttributeError) as exc: notes.append(f"main outputs invalid: {type(exc).__name__}")
        edge=False
        if artifact:
            eroot,erun,et=execute(candidate,"edge")
            if erun.returncode==0:
                try:
                    es,eu=output_rows(eroot,input_data(eroot)); _,summary=read_summary(eroot)
                    edge=es==[] and eu==[{"shift_id":"EDGE-S1","seat":"1","required_skill":"water_rescue","reason":"no_qualified_volunteer"}] and summary=={"required_seats":1,"filled_seats":0,"required_skill_coverage":0,"preference_score":0,"assignment_count_spread":0,"changed_assignments":0,"fairness_exceptions":[]}
                except (OSError,UnicodeError,csv.Error,ValueError,KeyError,TypeError,AttributeError): pass
            else: notes.append("edge command failed")
    except (OSError,subprocess.SubprocessError) as exc:
        edge=False; notes.append(f"judge execution failed: {type(exc).__name__}")
    finally:
        if mt: mt.cleanup()
        if et: et.cleanup()
    passed=sum(checks)
    if not artifact or not runnable: level=0
    elif not parseable: level=1
    elif passed==5: level=5 if edge else 4
    elif passed: level=3
    else: level=2
    print(json.dumps({"status":"pass" if level==5 else "fail","progress_level":level,"main_checks_passed":passed,"main_checks_total":5,"edge_check_passed":edge,"notes":notes},sort_keys=True))

if __name__=="__main__": main()
