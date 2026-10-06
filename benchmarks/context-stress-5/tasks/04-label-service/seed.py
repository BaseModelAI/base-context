import argparse
from pathlib import Path
p=argparse.ArgumentParser(); p.add_argument('--workspace',type=Path,required=True); p.add_argument('--fixture',default='main')
a=p.parse_args(); a.workspace.mkdir(parents=True,exist_ok=True)
for name in ('solution','output','notes'): (a.workspace/name).mkdir(exist_ok=True)
