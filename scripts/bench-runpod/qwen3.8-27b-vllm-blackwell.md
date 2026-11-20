# Qwen3.8-27B on one RTX PRO 6000 Blackwell (vLLM)

Inference recipe for running Signet Dreaming, answering and judging on a single 96 GB
Blackwell GPU. Everything below was measured on the run recorded in
[PR #2169](https://github.com/Signet-AI/signetai/pull/2169), not estimated.

## Recommended setup

| piece | choice | why |
|---|---|---|
| engine | vLLM 0.32.0 (`+cu129` wheel) | continuous batching, prefix caching, MTP, `thinking_token_budget` |
| weights | `nvidia/Qwen3.8-27B-NVFP4` (NVFP4 MLP, FP8 attention, 19.75 GiB) | native FP4 GEMMs on sm_120, more room for KV than the 28 GiB FP8 checkpoint |
| KV cache | `fp8` | correct output, 1.72M tokens at a 262K max length |
| speculative decoding | built-in MTP head, `num_speculative_tokens: 3` | 72-91% acceptance on real transcripts; beats 2 at every measured point |
| context | `--max-model-len 262144` | Dreaming passes need more than 128K |
| reasoning | thinking on, capped per request by Signet (`thinking.budgetTokens: 2000`) | Qwen3.8 is trained to think; the budget keeps a turn from spending its whole output on reasoning |

```bash
vllm serve nvidia/Qwen3.8-27B-NVFP4 \
  --served-model-name qwen3.8-27b \
  --max-model-len 262144 \
  --kv-cache-dtype fp8 \
  --gpu-memory-utilization 0.92 \
  --language-model-only \
  --enable-prefix-caching \
  --reasoning-parser qwen3 \
  --enable-auto-tool-choice --tool-call-parser qwen3_coder \
  --max-num-seqs 256 --max-num-batched-tokens 16384 \
  --speculative-config '{"method":"mtp","num_speculative_tokens":3}'
```

Signet inference target (agent.yaml). The context window is read from the server's
`/v1/models` (`max_model_len`), so it does not need to be set:

```yaml
inference:
  targets:
    background:
      executor: openai-compatible
      endpoint: http://127.0.0.1:8000/v1
      thinking:
        format: chat-template
        budgetTokens: 2000
        budgetField: thinking_token_budget
        chatTemplateKwargs:
          enable_thinking: { $var: thinking.enabled }
          preserve_thinking: false
      models:
        default:
          model: qwen3.8-27b
```

`preserve_thinking: false` keeps earlier turns' reasoning out of later prompts. With it on,
every Dreaming turn would re-send roughly 2K tokens of old reasoning per previous turn.

## Measured decode speed

Steady-state decode: N streams share a real-text prefix of the given length, the benchmark
waits until every stream is decoding, then reads vLLM's `generation_tokens_total` over a
20 s window. Prefill is excluded. Per-stream tok/s, aggregate in parentheses.

NVFP4 + fp8 KV + MTP 3 (recommended):

| context | 1 stream | 16 streams | 48 streams |
|---|---:|---:|---:|
| 2K | 154 | 114 (1,831) | 62 (2,974) |
| 16K | 140 | 104 (1,668) | 52 (2,498) |
| 48K | 154 | 88 (1,405) | 39 (1,865) |
| 100K | 154 | 72 (1,151) | 28 (1,324) |

Alternatives measured on the same harness:

| config | 2K x 48 | 16K x 16 | 48K x 48 | note |
|---|---:|---:|---:|---|
| MTP 2 | 57 | 93 | 34 | slower than MTP 3 everywhere |
| DFlash2 drafter (7 tokens) | 30 (26 of 48 admitted) | 108 | 21 (17 of 48 admitted) | up to 244 tok/s single stream, but the drafter cuts the KV pool to 758K tokens |
| TurboQuant `k8v4` KV, no MTP | 24 | 28 | 7 | 2.6M KV tokens, but dequantizing every read costs more than it saves (measured with an earlier harness that let prefill overlap decode, so these are low bounds) |

Decode on this card is bandwidth-bound (~1.8 TB/s). Each step reads the weights (~20 GB)
plus every running sequence's KV (~32 KB per token at fp8, since only 16 of 64 layers use
full attention), so per-stream speed at high concurrency is set by context length.

## Concurrency budget

- The KV pool holds 1.72M tokens.
- Each running sequence also holds a recurrent state for the 48 linear-attention layers.
  With prefix caching on, this costs about 20K tokens of KV per sequence regardless of
  context: at 48 sequences of 2K context, the pool was already 60% full.
- Dreaming agents carry 60K-110K tokens of history, so roughly 14-25 can stay resident.
  More passes than that wait in vLLM's queue, and a waiting agent's cached prefix can be
  evicted and recomputed.

## Pitfalls hit on the way

| symptom | cause | fix |
|---|---|---|
| EngineCore dies with no traceback; `cuModuleLoadData` segfault / `Illegal instruction` in Triton `_init_handles` | vLLM 0.32 pulls Triton 3.7.1, whose launcher crashes on NVIDIA driver 570 (CUDA 12.8) | `uv pip install triton==3.6.0`, and `TRITON_PTXAS_PATH` pointing at Triton's bundled CUDA 12.8 ptxas (vLLM also ships `tokenspeed_triton` with a CUDA 13.4 ptxas) |
| `OSError: Could not load this library: libtorchcodec_image.so` at import | torchcodec built for CUDA 13; vLLM only catches `ImportError`/`RuntimeError` | `uv pip uninstall torchcodec` (audio input not needed) |
| looping reasoning, `000...` content, wrong arithmetic | TurboQuant KV (`turboquant_k8v4`, `turboquant_4bit_nc`) combined with MTP on this hybrid model | use fp8 KV with MTP, or TurboQuant without MTP |
| first NVFP4 start takes ~9 minutes | FlashInfer JIT-compiles sm_120 FP4 GEMMs on few CPUs | one-time; cached in `~/.cache/flashinfer` |
| OOM during CUDA graph capture | `--max-num-batched-tokens 32768` at 0.92 memory utilization | keep 16384 |
| every Dreaming pass failed with `length` | Pi's 4096-token per-turn default, and Qwen thinks before each tool call | `memory.dreaming.maxOutputTokens: 16384` plus the thinking budget |
| Dreaming passes peaked at 105-113K tokens | Signet assumed a 128K window for local servers and Pi auto-compacted at ~112K | the window is now discovered from the server |

`thinking_token_budget` is per request; vLLM has no server-wide default for it, which is
why the budget lives on the Signet target.

## Host notes

The RunPod community host exposed 6.8 CPUs and a 62 GB memory cgroup to the container.
Model load plus JIT reached the 62 GB peak (mostly page cache). Size the host RAM for the
Signet daemon, memorybench and vLLM together.
