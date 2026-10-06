# Multi-file Node order-label service upgrade

Use the installed native tools and any supplied runtime. You may keep notes or scripts in notes/, delegate independent work, save command output, and repeat reads or commands. These choices earn no points by themselves. Inputs remain available after later stages, compaction, and process restart. Do not contact external services. Work only in this workspace. All numeric criteria are in the task and stage messages. The judge runs outside your workspace. It scores artifacts and behavior, not your wording or tool choice.

Repair and extend a small dependency-free Node.js order-label service over six updates.
Use Node 22 already installed; no package downloads. You may add files under service/.
CLI contract: node service/bin/route.mjs INPUT_JSON OUTPUT_DIRECTORY. It creates/replaces
plan.json and labels.csv and exits zero. Keep service/src/pricing.mjs export quote(items),
which returns sum(unit_cents*quantity) with no discount/tax. That legacy API remains supported.
The supplied modules are incomplete; fix them rather than editing input fixtures.

Input JSON has orders[], carriers[], holds[], policy{}. Each order has order_id (opaque ASCII),
customer_name (exact text), zone, and items[]. Each item has unit_cents, quantity, weight_g,
discount_bps, tax_bps, hazardous. Integers are nonnegative and quantity positive. Discounts and
taxes are each 0..10000 basis points. No external decimal package is needed.

plan.json is an array in input order. Every row has exactly order_id,status,carrier_id,
subtotal_cents,discount_cents,tax_cents,shipping_cents,total_cents. subtotal_cents is gross
merchandise before discount; total for a ready order is subtotal-discount+tax+shipping.
Status ready uses selected carrier_id; held/unsupported use null carrier_id. Later updates
specify holds, discount/tax and carrier rules. Initially all orders are ready and shipping=0.

labels.csv header is order_id,customer_name,status,carrier_id,total_cents. Preserve all names
exactly including embedded newline and quotes. Null carrier is empty. CSV row order matches
plan.json. Always use decimal integer strings for totals, including zero. Output encoding UTF-8.
The five checks are line pricing, carrier selection/free shipping, revision-aware holds,
CLI/legacy API plus exact output fields/order, and CSV values. One edge fixture combines newline
names, a rounding boundary, competing equal-price carriers, and a higher-revision cleared hold.
