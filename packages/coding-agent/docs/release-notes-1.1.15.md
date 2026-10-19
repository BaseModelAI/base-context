# Base Context 1.1.15

This patch fixes job-watch and daemon lifecycle defects and improves task-independent API and solving guidance.

- Completed, drained watches no longer occupy the 16 active/unresolved watch slots. Cached results and pending reports remain available.
- Registering a job whose result is already complete returns its terminal status instead of a stale `running` snapshot. Running jobs remain nonblocking; terminal evidence is not consumed automatically.
- Empty idle-eviction sweeps no longer block unrelated daemon mutations. Timed child passivation respects known pending completion work.
- Invalid installed-skill calls show real callable names and canonical help instead of misleading spelling guesses. Invalid task-contract fields show the supported fields.
- Solving guidance keeps negative findings scoped to the evidence examined and uses a representative result from the required interface before scaling proxy-driven work.

No daemon protocol, watch limit, or child-limit increase is included.

## Validation and benchmark scope

The final fix candidate passed 64 focused watch-controller, system-prompt, and native-kernel tests, plus source build and repository checks. Earlier focused tests covered the other fixes. Release artifacts are checked through fresh-home local consumers before publication.

The retained benchmark analysis identified longer solving workflows as the main cost driver. These changes do not claim measured accuracy or cost recovery: no new provider benchmark was run for this patch. See [the paired cost analysis](v114-cost-cause.md) for findings and limits.
