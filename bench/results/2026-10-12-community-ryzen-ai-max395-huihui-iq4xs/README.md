# AMD Ryzen AI Max+ 395: Huihui IQ4_XS, Q4_0 MTP, vision and Codex

Recorded on 2026-10-12 by [xszwow](https://github.com/xszwow).  This is the
reproducibility record for a Windows local service built from Strata 0.1.42 on
an AMD Ryzen AI Max+ 395 with Radeon 8060S graphics (`gfx1151`) and about 125
GiB of unified memory.  It is tuned for one long-running Codex/code session,
not for multi-user throughput.

This branch adds two runtime changes used by the configuration:

- native Q4_0/Q8_0 expert layouts for the MTP draft layer;
- vision GPU warm-up sizing that follows image-token caps above 4,096.

## Production configuration

The exact machine-local launcher configuration is preserved in
[`strata-huihui-iq4xs-q4mtp.json`](strata-huihui-iq4xs-q4mtp.json).  Its
absolute paths are a record of the measured machine and must be changed on a
different checkout.

| Setting | Value |
| --- | --- |
| Model id | `huihui-qwen3.8-flash-next-iq4-xs` |
| Context | 262,144 tokens |
| Generation slots | 1 |
| Worker pool | 8 |
| Prefill chunk | 16,384 tokens |
| KV | INT8 |
| Expert cache | 24,576 entries |
| Prompt cache | 6 checkpoints |
| Host conversation parking | disabled (`0 MiB`) |
| MTP | native Q4_0, `--spec 8`, `--spec-min-p 0.6`, window 8,192 |
| Sampling | temperature 0, top-p 0.95, top-k 20, seed 12345 |
| Codex compaction cache | enabled |
| Vision | Vulkan vision tower, 1,024-8,192 image tokens, 16 CPU threads |

The launch also enables the tested `gfx1151` HIP paths (`STRATA_PF_FUSED`,
`STRATA_PF_GEMM`, `STRATA_HC_UPMIX`, `STRATA_PA_FAST`, `STRATA_HIP_WMMA`,
`STRATA_SELECT_WMMA` and `STRATA_HC_Q8`).  These options can change output bits
and should be revalidated on another architecture.

## Model provenance

No model binary is committed.  [`models.json`](models.json) records the exact
repositories, immutable revisions, file sizes, SHA-256 hashes and stable
download URLs for the language model and vision projector.  The 31 BF16 MTP
source tensor ranges and hashes are in
[`mtp-source-manifest.json`](mtp-source-manifest.json).

- Main language model and vision projector: `huihui-ai/Huihui-Qwen3.8-Flash-Next-abliterated-GGUF`
  at `c219df4f109fa42c402c44c702c4e33e2ce05fe2`.
- Strata MTP source tensors: `Qwen/Qwen3.8-Flash-Next` at
  `de4b8e4d43b917e7706784d8bb445c9af86a3540`.
- The active `mtp-rt-q4_0` directory is a local conversion product.  It is not
  the standalone llama.cpp MTP GGUF and cannot be substituted by that file.

The main model has three GGUF shards totalling 93,682,584,224 bytes.  The
vision projector is 907,543,008 bytes.  The Q4_0 MTP runtime consists of
`dense.bin`, `dense.txt`, `draft_vocab.bin`, `experts.bin` and `experts.txt`;
all five hashes are recorded in `models.json`.

## Codex cache check

[`codex-compaction-cache.json`](codex-compaction-cache.json) preserves the
live smoke check.  With `codex_compaction_cache` enabled, the matching
compaction reused 2,383 of 2,410 input tokens and took 1.046 seconds instead of
3.328 seconds with the setting disabled.  This is one controlled smoke test,
not a general performance claim, and the cache does not survive a service
restart.

## Observed performance

Four Codex-style code/tool tasks, three repetitions each, averaged 64.63
decode tokens/s; per-case medians were approximately 61.9-68.0 tokens/s.  A
simple coding validation produced 59.7 tokens/s and passed 11 checks.  Decode
speed varies with output, routing and speculative acceptance, so individual
requests can still fall into the 30-60+ tokens/s range.

The service also completed a cold read of 260,934 input tokens and recovered
all three inserted markers.  That long-context result was collected under an
earlier tuning state and is evidence of capacity, not a direct speed
comparison with the production configuration above.

## Limitations

- Results describe one Windows machine and one model family.
- The configuration uses local absolute paths and is not portable unchanged.
- `--lookup-chain` remains disabled: a real code/tool trace sweep was about
  0.85% slower overall.
- Six prompt-cache checkpoints are in memory only.  This setup does not add
  disk-persistent KV or cross-restart KV restoration.
- Model licenses and the source repositories' terms still apply; this record
  contains only provenance, configuration and hashes.
