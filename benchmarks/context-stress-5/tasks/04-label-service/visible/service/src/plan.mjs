import { price } from './pricing.mjs';
import { chooseCarrier } from './carriers.mjs';
export function plan(input) {
 return input.orders.map(order => {
  const amounts = price(order.items);
  const carrier = chooseCarrier(order, input.carriers);
  return { order_id: order.order_id, status: 'ready', carrier_id: carrier?.carrier_id ?? null, ...amounts, shipping_cents: 0, total_cents: amounts.subtotal_cents };
 });
}
