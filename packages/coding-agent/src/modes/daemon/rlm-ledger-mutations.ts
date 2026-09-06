export type RlmLedgerDeleteReason = "user" | "parent-teardown" | "revoked" | "gc";

export type RlmLedgerMutation =
	| { op: "spawn"; childId: string; parent: string; child: string; depth: number; name: string }
	| { op: "rename"; childId: string; child: string; name: string }
	| { op: "delete"; childId: string; child: string; reason: RlmLedgerDeleteReason }
	| { op: "rename_by_path"; child: string; name: string }
	| { op: "delete_by_path"; child: string; reason: RlmLedgerDeleteReason };

export type RlmLedgerAccess =
	| { mode: "reader" }
	| { mode: "owner"; assertOwner: () => void }
	| { mode: "remote"; mutate: (mutation: RlmLedgerMutation) => Promise<void> };

export const RLM_LEDGER_MAX_MUTATION_BYTES = 64 * 1024;
export const RLM_LEDGER_MAX_PENDING_BYTES = 1024 * 1024;
export const RLM_LEDGER_MAX_PENDING_OPERATIONS = 32;
