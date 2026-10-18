# v1.1.14

- Fixed premature owned-session shutdown errors when a healthy session worker needs more than two seconds to finish cleanup.

Normal worker shutdown now has a bounded 20-second observation window within the existing 30-second client request deadline. Forced shutdown, timeout errors, and eventual cleanup remain unchanged. Agent prompts, model settings, and the daemon wire protocol are unchanged.

The v1.1.13 diagnostic benchmark passed task verification but exposed this shutdown error. The full benchmark was not started. This release makes no new benchmark accuracy, speed, or cost claim.
