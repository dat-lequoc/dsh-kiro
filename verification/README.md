# Verification harness

`overflow-probe/` is a DSH plugin used to prove one contract that unit tests
cannot reach and live traffic cannot force cheaply: that a
`CONTEXT_WINDOW_EXCEEDED` failure from this adapter makes DSH compact the
conversation and retry the turn.

It registers a `kiro-probe` provider whose scripted responses are:

1. one tool call, so the turn produces durable history,
2. then a throw whose code comes from this package's own `httpErrorCode()`
   applied to a real recorded Kiro HTTP 400 body,
3. a short summary for the compaction summarizer,
4. the final answer on the retried request.

Everything else — agent loop, token meter, `dsh-compaction-basic`, retry — is the
genuine installed code, and no provider credits are spent.

## Run it

```sh
# 1. build the artifact under test
npm run check && npm run pack:dist

# 2. create a throwaway profile that loads it next to this probe
mkdir -p "$DSH_HOME/profiles/kiro-recovery"
# package.json bundles: @deepseek-ai/dsh-base, @deepseek-ai/dsh-headless,
# dsh-kiro (file: the packed tarball), dsh-kiro-overflow-probe (file: this dir)
# cordis.patch.yml: set agent-default-model to provider kiro-probe, model probe-1
dsh plugin --profile kiro-recovery install

# 3. answer one task against an isolated DSH_HOME
DSH_HOME=/tmp/dsh-recovery KIRO_PROBE_TRACE=/tmp/probe.jsonl \
  dsh --profile kiro-recovery "Run the probe step and then report the outcome."
```

Expected: the task prints `recovered-ok`, `/tmp/probe.jsonl` records a
`CONTEXT_WINDOW_EXCEEDED` throw followed by a `purpose: "compaction"` call, and
the session transcript contains `compaction/start`, `compaction/summary`,
`compaction/end`, and `turn/end` with `completed`.
