export function csv(rows) { return rows.map(row => row.join(',')).join('\n') + '\n'; }
