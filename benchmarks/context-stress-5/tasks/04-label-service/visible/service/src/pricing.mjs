export function quote(items) { return items.reduce((sum, item) => sum + item.unit_cents * item.quantity, 0); }
export function price(items) { return { subtotal_cents: quote(items), discount_cents: 0, tax_cents: 0 }; }
