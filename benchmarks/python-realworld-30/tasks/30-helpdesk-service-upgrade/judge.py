#!/usr/bin/env python3.12
from __future__ import annotations
import argparse,csv,json,os,re,shutil,signal,sqlite3,subprocess,tempfile,time,urllib.error,urllib.parse,urllib.request
from collections import Counter
from datetime import datetime
from decimal import Decimal, InvalidOperation
from pathlib import Path
PY="/usr/bin/python3.12";CAP=6000

def run(argv,cwd,timeout=180):
 with tempfile.TemporaryFile() as out,tempfile.TemporaryFile() as err:
  try:p=subprocess.run(argv,cwd=cwd,stdout=out,stderr=err,timeout=timeout,env={"PATH":"/usr/bin:/bin","PYTHONHASHSEED":"0"})
  except (OSError,subprocess.TimeoutExpired) as exc:return 124,str(exc)[:CAP]
  out.seek(0);err.seek(0);return p.returncode,(out.read(CAP)+err.read(CAP)).decode("utf-8","replace")

def unique_object(pairs):
 result={}
 for key,value in pairs:
  if key in result:raise ValueError("duplicate JSON member")
  result[key]=value
 return result

def decode_json(raw):return json.loads(raw,object_pairs_hook=unique_object)

TIME_FIELDS={"created_at","updated_at","sla_started_at","sla_due_at","pending_since","due_at","as_of"}

def utc_parts(value):
 if not isinstance(value,str):raise ValueError("timestamp must be text")
 match=re.fullmatch(r"(\d{4}-\d{2}-\d{2}[Tt]\d{2}:\d{2}:\d{2})(?:\.(\d+))?Z",value)
 if not match:raise ValueError("timestamp must be RFC3339 UTC with Z")
 return datetime.fromisoformat(match[1]),(match[2] or "").rstrip("0")

def same_time(actual,expected):
 try:return utc_parts(actual)==utc_parts(expected)
 except ValueError:return False

def same_json(actual,expected,field=None):
 if field in TIME_FIELDS and isinstance(expected,str):return same_time(actual,expected)
 if type(expected) in (int,float):return type(actual) in (int,float) and actual==expected
 if isinstance(expected,dict):return isinstance(actual,dict) and set(actual)==set(expected) and all(same_json(actual[k],v,k) for k,v in expected.items())
 if isinstance(expected,list):return isinstance(actual,list) and len(actual)==len(expected) and all(same_json(a,e) for a,e in zip(actual,expected))
 return type(actual) is type(expected) and actual==expected

def has_fields(actual,expected):
 return isinstance(actual,dict) and all(k in actual and same_json(actual[k],v,k) for k,v in expected.items())

def ticket_list(value):return value.get("tickets",[]) if isinstance(value,dict) else value if isinstance(value,list) else []

TICKET_FIELDS=("id","subject","body","status","priority","assignee_id","requester_email","created_at","updated_at")
COMMENT_FIELDS=("id","ticket_id","author_email","author_type","body","created_at")

def same_ticket(actual,expected):
 return (has_fields(actual,{k:expected[k] for k in TICKET_FIELDS})
         and isinstance(actual.get("comments"),list) and len(actual["comments"])==len(expected["comments"])
         and all(has_fields(a,{k:e[k] for k in COMMENT_FIELDS}) for a,e in zip(actual["comments"],expected["comments"])))

def numeric_id(value):
 if not (type(value) is int or type(value) is float and value.is_integer()):raise ValueError("ID must be an integer")
 return int(value)

def last_json(text):
 try:value=decode_json(text)
 except json.JSONDecodeError:
  # Retain progress-output tolerance while allowing a multi-line final object.
  decoder=json.JSONDecoder(object_pairs_hook=unique_object);value=None;end=0
  for match in re.finditer(r"(?m)^[ \t]*\{",text):
   start=match.end()-1
   if start<end:continue
   try:item,length=decoder.raw_decode(text[start:])
   except json.JSONDecodeError:continue
   if isinstance(item,dict):value=item;end=start+length
 if not isinstance(value,dict):raise ValueError("JSON command summary must be an object")
 return value

def unused_id(used):
 value=1
 while value in used:value+=1
 return value

def inject(task,root,name,kind):
 source=task/"stages"/name;payload=Path(tempfile.mkdtemp(prefix="pcbench30-stage-"))
 try:
  gen=source/"_generate.py"
  if gen.is_file():
   rc,d=run([PY,"-E","-S",str(gen),"--output",str(payload),"--fixture",kind],source)
   if rc:raise RuntimeError("generator failed: "+d[:300])
  for item in source.rglob("*"):
   if item.is_file() and item.name!="_generate.py":
    dst=payload/item.relative_to(source);dst.parent.mkdir(parents=True,exist_ok=True);shutil.copy2(item,dst)
  shutil.copytree(payload,root,dirs_exist_ok=True)
 finally:shutil.rmtree(payload,ignore_errors=True)

def fixture(task,candidate,kind):
 root=Path(tempfile.mkdtemp(prefix=f"pcbench30-{kind}-"))
 rc,d=run([PY,"-E","-S",str(task/"seed.py"),"--workspace",str(root),"--fixture",kind],task)
 if rc:raise RuntimeError("seed failed: "+d[:300])
 shutil.copytree(candidate,root/"service")
 for name in ("mail","sla","search","maintenance"):inject(task,root,name,kind)
 return root

def cli(root,*args,timeout=180):return run([PY,"-E","-S","-m","helpdesk",*args],root/"service",timeout)

class Service:
 def __init__(self,root):self.root=root;self.p=None;self.base=None
 def __enter__(self):
  self.p=subprocess.Popen([PY,"-E","-S","-m","helpdesk","serve","--db","../workspace/helpdesk.db","--port","0"],cwd=self.root/"service",stdout=subprocess.PIPE,stderr=subprocess.STDOUT,text=True,bufsize=1,start_new_session=True,env={"PATH":"/usr/bin:/bin","PYTHONHASHSEED":"0"})
  deadline=time.monotonic()+8;seen=[]
  while time.monotonic()<deadline and self.p.poll() is None:
   import select
   ready,_,_=select.select([self.p.stdout],[],[],0.2)
   if not ready:continue
   line=self.p.stdout.readline();seen.append(line)
   if line.startswith("LISTENING "):
    port=int(line.split()[1]);self.base=f"http://127.0.0.1:{port}";return self
  self.close();raise RuntimeError("service did not report LISTENING: "+"".join(seen)[:300])
 def close(self):
  if self.p and self.p.poll() is None:
   try:os.killpg(self.p.pid,signal.SIGTERM);self.p.wait(timeout=3)
   except Exception:
    try:os.killpg(self.p.pid,signal.SIGKILL)
    except Exception:pass
  if self.p and self.p.stdout:self.p.stdout.close()
 def __exit__(self,*a):self.close()
 def request(self,method,path,body=None):
  data=None if body is None else body if isinstance(body,bytes) else json.dumps(body).encode();headers={"Content-Type":"application/json"} if data is not None else {}
  req=urllib.request.Request(self.base+path,data=data,method=method,headers=headers)
  try:
   with urllib.request.urlopen(req,timeout=5) as r:raw=r.read(2_000_000);return r.status,decode_json(raw or b"null")
  except urllib.error.HTTPError as e:
   raw=e.read(10000)
   return e.code,decode_json(raw)

def readcsv(path):
 with path.open(encoding="utf-8",newline="") as f:r=csv.DictReader(f);header=r.fieldnames;rows=list(r)
 if any(None in row or None in row.values() for row in rows):raise ValueError("malformed CSV row")
 return header,rows

def csv_number(value):
 try:number=Decimal(value)
 except (InvalidOperation,ValueError,TypeError):raise ValueError("invalid CSV number")
 if not number.is_finite():raise ValueError("non-finite CSV number")
 return number

def csv_id(value):
 number=csv_number(value)
 if number!=number.to_integral_value():raise ValueError("CSV ID must be integral")
 return int(number)

def same_csv(actual,expected):
 def value_equal(key,a,e):
  if key in TIME_FIELDS:return same_time(a,e)
  if key=="ticket_id":return csv_id(a)==csv_id(e)
  if key=="minutes_overdue":return csv_number(a)==csv_number(e)
  return a==e
 try:return len(actual)==len(expected) and all(set(a)==set(e) and all(value_equal(k,a[k],v) for k,v in e.items()) for a,e in zip(actual,expected))
 except ValueError:return False

def mail_body_text(value):
 if value.endswith("\r\n"):return value[:-2]
 if value.endswith("\n"):return value[:-1]
 return value

def evaluate_main(task,candidate):
 root=fixture(task,candidate,"main");runnable=False
 try:
  with sqlite3.connect(root/"workspace/helpdesk.db") as db:
   db.row_factory=sqlite3.Row
   original_tickets=[dict(r) for r in db.execute("SELECT * FROM tickets ORDER BY id")]
   original_agent_ids={r["id"] for r in db.execute("SELECT id FROM agents")}
   original_comments=[dict(r) for r in db.execute("SELECT * FROM comments ORDER BY id")]
  rc,d=cli(root,"create-agent","../workspace/helpdesk.db","--email","agent@example.test");runnable=True
  if rc:return [False]*5,runnable,False,"create-agent failed: "+d[:500],root
  agent=last_json(d);agent["id"]=numeric_id(agent.get("id"))
  rc,again=cli(root,"create-agent","../workspace/helpdesk.db","--email","ＡＧＥＮＴ@EXAMPLE.TEST")
  agent_ok=rc==0 and has_fields(agent,{"email":"agent@example.test","created_at":"1970-01-01T00:00:00Z"}) and has_fields(last_json(again),agent)
  rc,d1=cli(root,"import-mail","../workspace/helpdesk.db","../inputs/archive.mbox");
  if rc:return [False]*5,runnable,False,"mail import failed: "+d1[:500],root
  rc,d2=cli(root,"import-mail","../workspace/helpdesk.db","../inputs/archive.mbox");
  if rc:return [False]*5,runnable,False,"mail reimport failed: "+d2[:500],root
  first,second=last_json(d1),last_json(d2)
  rc,d=cli(root,"escalations","../workspace/helpdesk.db","--as-of","2025-05-28T17:00:00Z","--output","../output/escalations.csv")
  if rc:return [False]*5,runnable,False,"escalations failed: "+d[:500],root
  rc,d=cli(root,"export","../workspace/helpdesk.db","--status","open","--output","../output/tickets.csv")
  if rc:return [False]*5,runnable,False,"export failed: "+d[:500],root
  rc,d=cli(root,"maintenance","../workspace/helpdesk.db","--as-of","2025-06-02T17:00:00Z","--output","../output/maintenance.json")
  if rc:return [False]*5,runnable,False,"maintenance failed: "+d[:500],root
  eh,erows=readcsv(root/"output/escalations.csv");xh,xrows=readcsv(root/"output/tickets.csv");maint=decode_json((root/"output/maintenance.json").read_text())
  parsed=True
  with Service(root) as svc:
   # Discover allocated IDs from API-visible records rather than assuming ID44.
   lc,all_tickets=svc.request("GET","/tickets")
   listed_tickets=ticket_list(all_tickets);ticket_map={numeric_id(t["id"]):t for t in listed_tickets}
   original_ids={t["id"] for t in original_tickets};new_ids=set(ticket_map)-original_ids
   if len(new_ids)!=1:raise ValueError("expected one newly imported ticket")
   imported_id=new_ids.pop()
   known_assignees=original_agent_ids|{agent["id"]}|{numeric_id(t["assignee_id"]) for t in listed_tickets if t.get("assignee_id") is not None}
   missing_assignee_id=unused_id(known_assignees)
   c,t1=svc.request("GET","/tickets/1");c2,t2=svc.request("GET","/tickets/2");c3,t3=svc.request("GET","/tickets/3");ci,imported=svc.request("GET",f"/tickets/{imported_id}")
   mail_ok=(same_json(first,{"imported":4999,"skipped":1,"created_tickets":1,"created_comments":4998}) and same_json(second,{"imported":0,"skipped":5000,"created_tickets":0,"created_comments":0}) and c==c2==ci==200 and t2.get("status")=="open" and len(t1.get("comments",[]))==4997 and len(imported.get("comments",[]))==1 and imported.get("subject")=="VPN Café access")
   preserved=(lc==200 and [numeric_id(t["id"]) for t in listed_tickets]==sorted(original_ids|{imported_id})
              and all(has_fields(ticket_map.get(t["id"]),t) for t in original_tickets if t["id"]>=4))
   def comments_match(ticket,expected):
    comments=ticket.get("comments",[])
    ids=[numeric_id(c["id"]) for c in comments]
    signature=lambda c:(c["author_email"],c["author_type"],mail_body_text(c["body"]),utc_parts(c["created_at"]))
    return (ids==sorted(set(ids)) and all(same_json(c.get("ticket_id"),ticket["id"]) for c in comments)
            and Counter(signature(c) for c in comments)==Counter((a,k,b,utc_parts(t)) for a,k,b,t in expected))
   initial=original_comments[0]
   printer_expected=[(initial["author_email"],initial["author_type"],initial["body"],initial["created_at"]),
                     ("customer@example.test","customer","Still grinding after restart","2025-05-23T10:00:00Z")]
   printer_expected.extend(("customer@example.test","customer",f"Diagnostic observation {i:04d}","2025-05-23T13:00:00Z") for i in range(5,5000))
   mail_ok &= (preserved and comments_match(t1,printer_expected)
               and any(has_fields(c,initial) for c in t1["comments"])
               and comments_match(t2,[("customer@example.test","customer","The login loop remains","2025-05-23T11:00:00Z")])
               and comments_match(imported,[("customer@example.test","customer","The VPN token still fails","2025-05-23T12:30:00Z")]))
   # Core create, update, filter, and reopen behavior against the same durable service.
   body={"subject":"New monitor request","body":"Screen flickers","requester_email":"new@example.test","priority":"normal","created_at":"2025-06-03T09:00:00Z","assignee_id":agent.get("id")}
   cr,new=svc.request("POST","/tickets",body);nid=numeric_id(new.get("id"))
   pr,pending=svc.request("PATCH",f"/tickets/{nid}",{"status":"pending_customer"}) if nid is not None else (0,{})
   lr,listed=svc.request("GET",f"/tickets?status=pending_customer&assignee={agent.get('id')}")
   items=listed.get("tickets",[]) if isinstance(listed,dict) else listed if isinstance(listed,list) else []
   rr,resolved=svc.request("PATCH",f"/tickets/{nid}",{"status":"resolved","updated_at":"2025-06-03T11:00:00Z"}) if nid is not None else (0,{})
   reply={"author_email":"new@example.test","author_type":"customer","body":"Still broken","created_at":"2025-06-03T12:00:00Z"}
   cm,comment=svc.request("POST",f"/tickets/{nid}/comments",reply) if nid is not None else (0,{})
   gr,final=svc.request("GET",f"/tickets/{nid}") if nid is not None else (0,{})
   check1=(cr==201 and isinstance(nid,int) and pr==200 and lr==200 and len(items)==1 and has_fields(items[0],{"id":nid,"status":"pending_customer","assignee_id":agent["id"],"updated_at":body["created_at"]}) and rr==200 and cm==201 and gr==200 and final.get("status")=="open" and same_time(final.get("updated_at"),"2025-06-03T12:00:00Z") and t1.get("subject")=="Printer paper jam")
   check1 &= (agent_ok and has_fields(new,{**body,"id":nid,"status":"open","updated_at":body["created_at"]})
               and has_fields(final,{**body,"id":nid,"status":"open","updated_at":reply["created_at"]})
              and len(final.get("comments",[]))==1
              and has_fields(final["comments"][0],{"ticket_id":nid,"author_email":"new@example.test","author_type":"customer","body":"Still broken","created_at":"2025-06-03T12:00:00Z"}))
   missing_ticket_id=unused_id(set(ticket_map)|{nid})
   rejected=[]
   for bad in (b'{"status":', {"subject":"must not change","status":"invalid"}, {"assignee_id":missing_assignee_id}):
    error_code,_=svc.request("PATCH",f"/tickets/{nid}",bad);rejected.append(400<=error_code<500)
   missing_code,_=svc.request("GET",f"/tickets/{missing_ticket_id}")
   missing_patch,_=svc.request("PATCH",f"/tickets/{missing_ticket_id}",{"status":"open"})
   missing_comment,_=svc.request("POST",f"/tickets/{missing_ticket_id}/comments",reply)
   after_code,after=svc.request("GET",f"/tickets/{nid}")
   check1 &= all(rejected) and missing_code==missing_patch==missing_comment==404 and after_code==200 and same_ticket(after,final)
   check2=mail_ok
   sr,sprinter=svc.request("GET","/search?"+urllib.parse.urlencode({"q":"printer grinding"}));sv,s_vpn=svc.request("GET","/search?"+urllib.parse.urlencode({"q":"VPN café"}))
   check4=(sr==sv==200 and sprinter.get("tickets") and sprinter["tickets"][0].get("id")==1 and sprinter["tickets"][0].get("score")==8 and s_vpn.get("tickets") and s_vpn["tickets"][0].get("id")==imported_id and s_vpn["tickets"][0].get("score")==11 and xh==["ticket_id","subject","status","priority","assignee_email","requester_email","created_at","updated_at","sla_due_at"] and [csv_id(r["ticket_id"]) for r in xrows]==sorted([1,2,imported_id]))
   expected_export_values=[
    ("1","Printer paper jam","open","urgent","","pat@example.test","2025-05-22T16:30:00Z","2025-05-23T13:00:00Z","2025-05-23T09:30:00Z"),
    ("2","Cannot sign in to payroll","open","normal","legacy@example.test","alice@example.test","2025-05-21T10:00:00Z","2025-05-23T11:00:00Z","2025-05-27T11:00:00Z"),
    (str(imported_id),"VPN Café access","open","normal","","customer@example.test","2025-05-23T12:00:00Z","2025-05-23T12:30:00Z","2025-05-27T12:00:00Z"),
   ]
   check4 &= (same_csv(xrows,[dict(zip(xh,r)) for r in sorted(expected_export_values,key=lambda r:csv_id(r[0]))])
              and b"\r" not in (root/"output/tickets.csv").read_bytes()
              and (root/"output/tickets.csv").read_bytes().endswith(b"\n")
              and [numeric_id(t["id"]) for t in sprinter["tickets"]]==[1]
              and [numeric_id(t["id"]) for t in s_vpn["tickets"]]==[imported_id]
              and same_json(sprinter["tickets"][0]["score"],8) and same_json(s_vpn["tickets"][0]["score"],11))
   check5=(same_json(maint,{"as_of":"2025-06-02T17:00:00Z","closed_ticket_ids":[3]}) and c3==200 and t3.get("status")=="closed" and same_time(t3.get("updated_at"),"2025-06-02T17:00:00Z"))
  with Service(root) as restarted:
   durable_code,durable=restarted.request("GET",f"/tickets/{nid}")
   check1 &= durable_code==200 and same_ticket(durable,final)
  rc,d=cli(root,"maintenance","../workspace/helpdesk.db","--as-of","2025-06-02T17:00:00Z","--output","../output/maintenance.json")
  check5 &= rc==0 and same_json(decode_json((root/"output/maintenance.json").read_text()),{"as_of":"2025-06-02T17:00:00Z","closed_ticket_ids":[]})
  expected_escalations={
   "1":("urgent","2025-05-23T09:30:00Z","1410",""),
   "2":("normal","2025-05-27T11:00:00Z","840","legacy@example.test"),
   "3":("low","2025-05-20T17:00:00Z","2400","legacy@example.test"),
   str(imported_id):("normal","2025-05-27T12:00:00Z","780","")}
  expected_erows=[dict(zip(["ticket_id","priority","due_at","minutes_overdue","assignee_email"],(key,*value))) for key,value in sorted(expected_escalations.items(),key=lambda item:csv_id(item[0]))]
  check3=(eh==["ticket_id","priority","due_at","minutes_overdue","assignee_email"] and same_csv(erows,expected_erows))
  return [check1,check2,check3,check4,check5],runnable,parsed,"",root
 except (OSError,UnicodeError,csv.Error,json.JSONDecodeError,KeyError,ValueError,TypeError) as exc:return [False]*5,runnable,False,"malformed output: "+str(exc)[:500],root

def evaluate_edge(task,candidate):
 root=fixture(task,candidate,"edge");runnable=False
 try:
  with sqlite3.connect(root/"workspace/helpdesk.db") as db:
   db.row_factory=sqlite3.Row
   original=dict(db.execute("SELECT * FROM tickets WHERE id=1").fetchone())
   historical=[dict(r) for r in db.execute("SELECT * FROM comments ORDER BY id")]
  with Service(root) as svc:
   runnable=True;status,initial=svc.request("GET","/tickets/1")
  initial_comments=initial.get("comments",[])
  preserved=(status==200 and has_fields(initial,original) and len(initial_comments)==len(historical)
             and all(has_fields(a,e) for a,e in zip(initial_comments,historical)))
  rc,d1=cli(root,"import-mail","../workspace/helpdesk.db","../inputs/archive-a.mbox")
  if rc:return False,runnable,False,d1[:500],root
  one=last_json(d1)
  with Service(root) as svc:
   status,imported=svc.request("GET","/tickets/1")
   imported_ok=status==200 and same_time(imported.get("updated_at"),"2025-05-23T10:00:00Z")
   code,agent_comment=svc.request("POST","/tickets/1/comments",{
    "author_email":"legacy@example.test","author_type":"agent","body":"Backdated agent note.","created_at":"2025-05-21T10:00:00+02:00"})
   status,before_duplicate=svc.request("GET","/tickets/1")
   assigned=(code==201 and status==200 and before_duplicate.get("status")=="open"
             and same_time(before_duplicate.get("updated_at"),"2025-05-21T08:00:00Z"))
  # This duplicate's Date is newer than the backdated parent timestamp. It must
  # not touch that timestamp; migration must not backfill historical comments.
  rc,d2=cli(root,"import-mail","../workspace/helpdesk.db","../inputs/archive-b.mbox")
  if rc:return False,runnable,False,d2[:500],root
  two=last_json(d2)
  with Service(root) as svc:status,t=svc.request("GET","/tickets/1")
  comments=t.get("comments",[])
  ok=(preserved and imported_ok and assigned
      and same_json(one,{"imported":1,"skipped":0,"created_tickets":0,"created_comments":1})
      and same_json(two,{"imported":0,"skipped":1,"created_tickets":0,"created_comments":0})
      and status==200 and same_ticket(t,before_duplicate)
      and has_fields(t,{"id":1,"subject":"Edge printer","body":"Paper tray sticks","status":"open","priority":"normal","assignee_id":1,"requester_email":"edge.customer@example.test","created_at":"2025-05-22T10:00:00Z","updated_at":"2025-05-21T08:00:00Z"})
      and len(comments)==3 and [numeric_id(c["id"]) for c in comments]==sorted({numeric_id(c["id"]) for c in comments})
      and any(has_fields(c,{"id":100,"ticket_id":1,"author_email":"legacy@example.test","author_type":"agent","body":"Initial diagnostic recorded.","created_at":"2025-05-22T16:40:00Z"}) for c in comments)
      and any(has_fields(c,{"ticket_id":1,"author_email":"customer@example.test","author_type":"customer","created_at":"2025-05-23T10:00:00Z"}) and mail_body_text(c.get("body",""))=="One imported comment" for c in comments)
      and any(has_fields(c,{"ticket_id":1,"author_email":"legacy@example.test","author_type":"agent","body":"Backdated agent note.","created_at":"2025-05-21T08:00:00Z"}) for c in comments))
  return ok,runnable,True,"",root
 except Exception as exc:return False,runnable,False,"edge malformed: "+str(exc)[:500],root

def main():
 p=argparse.ArgumentParser();p.add_argument("--workspace",type=Path,required=True);a=p.parse_args();task=Path(__file__).resolve().parent;candidate=a.workspace.resolve()/"service"
 if not (candidate/"helpdesk/__main__.py").is_file():
  print(json.dumps({"status":"fail","progress_level":0,"main_checks_passed":0,"main_checks_total":5,"edge_check_passed":False,"notes":[]}));return
 roots=[];notes=[]
 try:
  checks,runnable,parsed,d,r=evaluate_main(task,candidate);roots.append(r)
  if d:notes.append(d)
  edge,_,_,d,r=evaluate_edge(task,candidate);roots.append(r)
  if d:notes.append(d)
  n=sum(map(bool,checks));level=5 if n==5 and edge else 4 if n==5 else 3 if n>=2 else 2 if parsed else 1 if runnable else 0
  print(json.dumps({"status":"pass" if level==5 else "fail","progress_level":level,"main_checks_passed":n,"main_checks_total":5,"edge_check_passed":bool(edge),"notes":notes[:2]},sort_keys=True))
 except Exception as exc:print(json.dumps({"status":"error","progress_level":1,"main_checks_passed":0,"main_checks_total":5,"edge_check_passed":False,"notes":[str(exc)[:500]]},sort_keys=True))
 finally:
  for r in roots:shutil.rmtree(r,ignore_errors=True)
if __name__=="__main__":main()
