#!/usr/bin/env python3.12
from __future__ import annotations
import argparse,csv,io,json,shutil,subprocess,tempfile
from datetime import date
from decimal import Decimal, InvalidOperation
from pathlib import Path
from xml.etree import ElementTree as ET
PY="/usr/bin/python3.12";CAP=6000

def run(argv,cwd,timeout=120):
    with tempfile.TemporaryFile() as out,tempfile.TemporaryFile() as err:
        try:p=subprocess.run(argv,cwd=cwd,stdout=out,stderr=err,timeout=timeout,env={"PATH":"/usr/bin:/bin","PYTHONHASHSEED":"0"})
        except (OSError,subprocess.TimeoutExpired) as exc:return 124,str(exc)[:CAP]
        out.seek(0);err.seek(0);return p.returncode,(out.read(CAP)+err.read(CAP)).decode("utf-8","replace")

def stage(task,root,name,kind):
    source=task/"stages"/name; payload=Path(tempfile.mkdtemp(prefix="pcbench28-stage-"))
    try:
        gen=source/"_generate.py"
        if gen.is_file():
            rc,d=run([PY,"-E","-S",str(gen),"--output",str(payload),"--fixture",kind],source)
            if rc:raise RuntimeError(d[:300])
        for item in source.rglob("*"):
            if item.is_file() and item.name!="_generate.py":
                dst=payload/item.relative_to(source);dst.parent.mkdir(parents=True,exist_ok=True);shutil.copy2(item,dst)
        shutil.copytree(payload,root,dirs_exist_ok=True)
    finally:shutil.rmtree(payload,ignore_errors=True)

def fixture(task,candidate,kind):
    root=Path(tempfile.mkdtemp(prefix=f"pcbench28-{kind}-"))
    rc,d=run([PY,"-E","-S",str(task/"seed.py"),"--workspace",str(root),"--fixture",kind],task)
    if rc:raise RuntimeError("seed failed "+d[:300])
    target=root/"permitflow"
    if target.exists():shutil.rmtree(target)
    shutil.copytree(candidate,target)
    for name in ("ordinance-update","correction-batch","final-status"):stage(task,root,name,kind)
    return root

def cmd(root,*args):return run([PY,"-E","-S","-m","permitflow",*args],root)
HEADERS = {
    "applications": ["application_id", "source_id", "revision", "parcel_id", "owner_id", "permit_type", "submitted_date", "closed_date"],
    "validation_issues": ["application_id", "source_id", "code", "detail"],
    "fees": ["application_id", "source_id", "required_fee", "paid_fee", "fee_due"],
    "ordinance_impacts": ["application_id", "source_id", "field", "before", "after"],
    "status": ["application_id", "source_id", "status", "fee_due"],
}


def reference_outputs(inputs):
    """Derive every output row from the supplied, well-typed main/edge inputs."""
    def records(name):
        with (inputs / name).open(encoding="utf-8", newline="") as stream:
            return list(csv.DictReader(stream))

    raw = json.loads((inputs / "applications.json").read_text(encoding="utf-8"))["applications"]
    raw += [{child.tag: child.text or "" for child in node}
            for node in ET.parse(inputs / "applications.xml").getroot()]
    fields = HEADERS["applications"][1:] + ["fee_paid"]
    applications = {}
    for record in raw:
        app = {field: str(record.get(field, "")) for field in fields}
        app["revision"] = int(record["revision"])
        source = app["source_id"]
        old = applications.get(source)
        app["application_id"] = old["application_id"] if old else len(applications) + 1
        if old is None or app["revision"] > old["revision"]:
            applications[source] = app

    batch = inputs / "correction_batch"
    corrections = json.loads((batch / "owner_corrections.json").read_text(encoding="utf-8"))["corrections"]
    for correction in corrections:
        app = applications[correction["source_id"]]
        revision = int(correction["revision"])
        if revision > app["revision"]:
            app.update(owner_id=correction["owner_id"], revision=revision)

    # Keep the minimum original ID and its fields, including across linked pairs.
    parents = {source: source for source in applications}
    def survivor(source):
        while parents[source] != source:
            source = parents[source]
        return source
    for link in records("correction_batch/duplicate_links.csv"):
        first, second = survivor(link["source_id_a"]), survivor(link["source_id_b"])
        keep, remove = sorted((first, second), key=lambda source: applications[source]["application_id"])
        parents[remove] = keep
    attachments = {}
    for attachment in records("attachments.csv"):
        source = survivor(attachment["source_id"])
        attachments.setdefault((source, attachment["document_type"]), []).append(attachment["expires_on"])

    parcels = {row["parcel_id"]: row for row in records("parcels.csv")}
    owners = {row["owner_id"] for row in records("owners.csv")}
    zoning = {(row["zone"], row["permit_type"]) for row in records("zoning_rules.csv")}
    documents = {}
    for row in records("document_requirements.csv"):
        documents.setdefault(row["permit_type"], set()).add(row["document_type"])
    fees = {row["permit_type"]: Decimal(row["required_fee"]) for row in records("fee_table.csv")}
    validation_date = date.fromisoformat(json.loads((inputs / "settings.json").read_text(encoding="utf-8"))["validation_date"])
    ordinance = json.loads((inputs / "ordinance_update.json").read_text(encoding="utf-8"))
    effective_date = date.fromisoformat(ordinance["effective_date"])
    expected = {name: [] for name in HEADERS}
    letters = {}
    current = sorted((app for source, app in applications.items() if survivor(source) == source),
                     key=lambda app: app["application_id"])
    for app in current:
        aid, source, permit_type = app["application_id"], app["source_id"], app["permit_type"]
        expected["applications"].append(tuple(app[field] for field in HEADERS["applications"]))
        required_docs = documents.get(permit_type, set())
        required_fee = fees[permit_type]
        if not app["closed_date"] or date.fromisoformat(app["closed_date"]) >= effective_date:
            new_docs = set(ordinance["document_requirements"].get(permit_type, required_docs))
            new_fee = Decimal(ordinance["fees"].get(permit_type, required_fee))
            if new_docs != required_docs:
                expected["ordinance_impacts"].append((aid, source, "documents", "+".join(sorted(required_docs)), "+".join(sorted(new_docs))))
            if new_fee != required_fee:
                expected["ordinance_impacts"].append((aid, source, "fee", f"{required_fee:.2f}", f"{new_fee:.2f}"))
            required_docs, required_fee = new_docs, new_fee
        issues = []
        parcel = parcels.get(app["parcel_id"])
        if parcel is None:
            issues.append(("PARCEL_NOT_FOUND", app["parcel_id"]))
        else:
            if app["owner_id"] not in owners or app["owner_id"] != parcel["owner_id"]:
                issues.append(("OWNER_MISMATCH", app["owner_id"]))
            if (parcel["zone"], permit_type) not in zoning:
                issues.append(("ZONING_INCOMPATIBLE", f"{parcel['zone']}/{permit_type}"))
        for document_type in sorted(required_docs):
            expiries = attachments.get((source, document_type), [])
            if not expiries:
                issues.append(("MISSING_DOCUMENT", document_type))
            elif all(expiry and date.fromisoformat(expiry) < validation_date for expiry in expiries):
                issues.append(("EXPIRED_DOCUMENT", document_type))
        paid = Decimal(app["fee_paid"])
        due = max(required_fee - paid, Decimal("0.00"))
        if paid != required_fee:
            issues.append(("FEE_MISMATCH", f"required {required_fee:.2f}; paid {paid:.2f}"))
        issues.sort()
        expected["validation_issues"].extend((aid, source, code, detail) for code, detail in issues)
        expected["fees"].append((aid, source, f"{required_fee:.2f}", f"{paid:.2f}", f"{due:.2f}"))
        blockers = {code for code, _ in issues if code != "FEE_MISMATCH"}
        status = ("approved" if not blockers else "needs_information"
                  if blockers <= {"MISSING_DOCUMENT", "EXPIRED_DOCUMENT"} else "manual_review")
        expected["status"].append((aid, source, status, f"{due:.2f}"))
        issue_lines = "\n".join(f"- {code}: {detail}" for code, detail in issues) if issues else "- none"
        letters[f"{aid}.txt"] = (f"Permit application {source}\nStatus: {status}\nFee due: {due:.2f}\n"
                                f"Outstanding issues:\n{issue_lines}\n").encode("utf-8")
    return expected, letters


def output_rows(path, header):
    raw = path.read_bytes()
    if b"\r" in raw:
        raise ValueError(f"{path.name}: expected LF line endings")
    with io.StringIO(raw.decode("utf-8"), newline="") as stream:
        reader = csv.reader(stream, strict=True)
        if next(reader, None) != header:
            raise ValueError(f"{path.name}: incorrect header")
        rows = []
        for row in reader:
            if len(row) != len(header):
                raise ValueError(f"{path.name}: incorrect field count")
            for index, field in enumerate(header):
                if field in {"application_id", "revision"}:
                    value = Decimal(row[index])
                    if not value.is_finite() or value != value.to_integral_value():
                        raise ValueError(f"{path.name}: non-integer {field}")
                    row[index] = int(value)
            rows.append(tuple(row))
        return rows


def evaluate(task, candidate, kind):
    root = fixture(task, candidate, kind)
    runnable = False
    try:
        expected, letters = reference_outputs(root / "inputs")
        for args in [("import", "inputs", "workspace/permits.db"),
                     ("import", "inputs", "workspace/permits.db"),
                     ("validate", "workspace/permits.db", "--output", "output")]:
            rc, detail = cmd(root, *args)
            runnable = True
            if rc:
                return ([False] * 5 if kind == "main" else False), runnable, False, "command failed: " + detail[:500], root
        actual = {name: output_rows(root / "output" / f"{name}.csv", header)
                  for name, header in HEADERS.items()}
        notices = root / "output/notices"
        letters_ok = {path.name for path in notices.glob("*.txt")} == set(letters)
        letters_ok = letters_ok and all((notices / name).read_bytes() == body for name, body in letters.items())
        names = ["applications", "validation_issues", "ordinance_impacts", "fees", "status"]
        checks = [actual[name] == expected[name] for name in names]
        checks[-1] = checks[-1] and letters_ok
        failed = [name for name, ok in zip(names, checks) if not ok]
        detail = kind + " output mismatch: " + ", ".join(failed) if failed else ""
        return (checks if kind == "main" else all(checks)), runnable, True, detail, root
    except (OSError, UnicodeError, csv.Error, json.JSONDecodeError, KeyError, ValueError, TypeError, InvalidOperation) as exc:
        return ([False] * 5 if kind == "main" else False), runnable, False, "malformed output: " + str(exc)[:500], root

def main():
    p=argparse.ArgumentParser();p.add_argument("--workspace",type=Path,required=True);a=p.parse_args();task=Path(__file__).resolve().parent;candidate=a.workspace.resolve()/"permitflow"
    if not candidate.is_dir() or not (candidate/"__main__.py").is_file():
        print(json.dumps({"status":"fail","progress_level":0,"main_checks_passed":0,"main_checks_total":5,"edge_check_passed":False,"notes":[]}));return
    roots=[];notes=[]
    try:
        checks,runnable,parsed,d,r=evaluate(task,candidate,"main");roots.append(r)
        if d:notes.append(d)
        edge,_,_,d,r=evaluate(task,candidate,"edge");roots.append(r)
        if d:notes.append(d)
        n=sum(map(bool,checks));level=5 if n==5 and edge else 4 if n==5 else 3 if n>=2 else 2 if parsed else 1 if runnable else 0
        print(json.dumps({"status":"pass" if level==5 else "fail","progress_level":level,"main_checks_passed":n,"main_checks_total":5,"edge_check_passed":bool(edge),"notes":notes[:2]},sort_keys=True))
    except Exception as exc:print(json.dumps({"status":"error","progress_level":1,"main_checks_passed":0,"main_checks_total":5,"edge_check_passed":False,"notes":[str(exc)[:500]]},sort_keys=True))
    finally:
        for r in roots:shutil.rmtree(r,ignore_errors=True)
if __name__=="__main__":main()
