# DeepSeek V4.1 Flash: source support

This unpublished source tree includes provider `deepseek`, model `deepseek-flash`
(`DeepSeek-V4.1-Flash`), through `openai-completions` at
`https://api.deepseek.com`. It uses the DeepSeek API, not an OpenAI subscription.
Existing DeepSeek API-key configuration applies.

- The output field is `max_tokens`; the model ceiling is 393216 tokens.
- The published context display is 1M. The configured size is a conservative
  1000000 tokens, not an independently established exact provider limit.
- Requested minimal/low maps to wire `low`; medium/high/xhigh maps to `high`;
  max maps to `max`. A medium benchmark must report that mapping honestly.
- Catalog rates are declared peak USD per million: ordinary/cache-miss input
  0.30, cache-read 0.006, output 1.20. There is no separate cache-write price.
  These estimates do not identify a billing window or verified debit.
- The announcement declares native multimodal support. The model catalog accepts
  text and images, but enforced native media budgeting remains unknown.

## Native context behavior

Fresh text and complete tool exchanges use the existing native source and usage
paths. With an **explicit matching request-token profile**, the direct canonical
route also supports native text/tool view selection and public checkpoints.
The actual serializer supplies the original message/group mapping. Whole eligible
groups can become descriptive user text without replaying their private reasoning
or pretending to be provider tool results. Remaining raw reasoning/tool fields
stay unchanged. The original source, dependency closure and append acknowledgment
still control adoption and send. Serialization and the payload callback each run
once; a changed final payload cannot borrow an accepted projection.

This is not a generic OpenAI-compatible replay permission. Other providers,
legacy aliases, proxies and alternate `/v1` bases do not gain this capability.
Foreign, opaque, unsupported and incomplete mappings still refuse where native
projection is required. Turning optimization off does not reset epoch authority.
No budget is synthesized when the caller supplies none. Catalog sizes are not a
tokenizer, and this text/tool path does not remove media-budget refusal.

One offline native case exercises actual model serialization, a selected tool and
its source record, public-checkpoint ACK, model compaction, the next request and
altered-payload refusal. It does not establish live API availability, vision
acceptance, cost savings or benchmark readiness. The new balanced three-model
runner and isolated API-key delivery are separate work.

## Public sources

- https://www.deepseek.com/en/news/deepseek-v4-1-flash/
- https://api-docs.deepseek.com/api/create-chat-completion
- https://api-docs.deepseek.com/guides/thinking_mode
- https://api-docs.deepseek.com/quick_start/pricing
- https://api-docs.deepseek.com/guides/kv_cache
