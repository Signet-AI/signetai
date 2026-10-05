# Model portability

Dreaming is model-agnostic: users bring any model, and every supported model should reach results comparable to the benchmarks. A change to the Dreaming prompt, tools, or operation contract can help one model and hurt another, so check it on models that fail differently.

## Which models to run

Best effort, in this order:

1. **GLM-5.3-Flash** (Z.ai coding plan). The reference model. It is judgment-driven: it infers intent from loose rules and tends to file a lot.
2. **An OpenAI model** (for example `gpt-6-luna` through a ChatGPT plan). OpenAI models follow instructions literally: they do exactly what is written, infer little, and, given a choice, defer or ask instead of acting.

Contributors without access to one of them run what they can and report which run is missing. Never imply a model was checked when it was not.

## Running Dreaming on a ChatGPT plan

The `openai-codex` provider uses a ChatGPT subscription session, so a human has to sign in once per workspace:

1. Create and keep a workspace with the Dreaming model set, for example `SIGNET_BENCH_DREAMING_PROVIDER_FAMILY=openai-codex SIGNET_BENCH_DREAMING_MODEL=gpt-6-luna SIGNET_BENCH_DREAMING_CONCURRENCY=10` with `--keep-workspace --workspace <dir> --port <port>`. The bench writes a `subscription_session` account instead of requiring an API key.
2. Start that workspace's daemon and give the human the dashboard URL (`http://127.0.0.1:<port>/#settings/inference`). The ChatGPT / Codex card shows **Sign in** until the daemon holds a credential. Wait until `/api/inference/oauth/providers` reports `openai-codex` connected. Do not drive the sign-in yourself.
3. Stop that daemon, then run the bench with the same `--workspace` and `--port`. The bench reuses a set-up workspace and its stored credential.
4. Between runs, stop the daemon and move `agents/data/signet.db*` and `agents/transcripts` aside. The credential lives in `agents/.secrets/`, separate from the database, so it survives the reset.

Keep subscription concurrency at 8 to 12.

## Writing prompt rules that work on both

Literal models expose every rule that relied on judgment. What worked:

- **State the procedure, not the goal.** "Before excluding a source, list each statement the user makes about themselves and file each one" works; "file what the user discloses" does not.
- **Name the only valid exceptions.** Literal models invent blockers ("no entity exists yet", "excerpt is partial", "claim not checked"). List the allowed reasons to defer and say everything else is work to do now.
- **Spell out multi-step sequences.** For example: create the entity, then the aspect with the returned id, then the claims, all in the same pass.
- **Say "bias toward action".** OpenAI's GPT-6 guidance recommends telling the model to carry the task to completion; without it the model stops at describing what it would file.
- **Give each rule its own limit.** Literal models over-apply rules, so "one fact per claim" needs "and each claim still states its subject" next to it.

After a prompt change, inspect what the literal model actually did (`pass-inspect.ts`: pass logs, failed filings, exclusion reasons) and sample its claims for over-application: fragment claims, filed advice, or junk entities. Then confirm the judgment-driven model did not regress (`regression-check.md`).

OpenAI's current prompting guidance lives in its developer docs ("Using GPT-6" and "Prompt engineering"); check them for the model in use rather than relying on remembered advice.
