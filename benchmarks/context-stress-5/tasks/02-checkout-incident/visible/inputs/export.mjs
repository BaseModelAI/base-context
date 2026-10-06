import fs from 'node:fs';
for (const f of fs.readdirSync('inputs/logs').filter(x=>x.endsWith('.jsonl')).sort()) process.stdout.write(fs.readFileSync('inputs/logs/'+f));
