# Judges

One judge implementation, `ModelJudge` in `index.ts`, serves every model.
`createJudge(modelAlias)` resolves the alias through `src/utils/models.ts` and
calls the shared client in `src/utils/llm.ts`, so OpenAI, Anthropic, Google, and
Z.ai (GLM) judges share one request path and one usage record.

## Interface

```typescript
interface Judge {
  name: string
  modelAlias: string
  modelConfig: ModelConfig
  evaluate(input: JudgeInput): Promise<JudgeResult>
  generate(prompt: string, options?: GenerateOptions): Promise<GenerateResult>
  getModel(): LanguageModel
}
```

- `evaluate()` runs the legacy correct/incorrect prompt and returns
  `{ score: 0|1, label, explanation, usage }`.
- `generate()` is used by benchmark protocols that own their own judge prompts
  (BEAM's rubric and event-equivalence judges).
- `getModel()` is used by the optional LLM retrieval-relevance diagnostic.

Use these helpers from `./base.ts`:

- `buildJudgePrompt(input)` builds the full prompt from `JudgeInput`.
- `parseJudgeResponse(text)` parses a valid JSON verdict and rejects malformed,
  out-of-range, contradictory, or incorrectly typed fields.

## Adding a model

Add an entry to `MODEL_CONFIGS` in `src/utils/models.ts`. A new provider also
needs a case in `getLanguageModel()` and a credential in `src/utils/config.ts`.
A missing credential fails when the judge is created, before any run phase.

## Provider-specific prompts

Providers can override judge prompts. See
[providers/README.md](../providers/README.md#custom-prompts).
