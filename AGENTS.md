# Kiro adapter

- `src/adapter.ts` owns the per-request Kiro transport lifecycle. `src/serialize.ts` builds the provider payload and `src/translate.ts` converts response frames into DSH chunks.
- `src/tool-names.ts` owns Kiro wire aliases. Use one request-local mapping for tool declarations and replayed calls; restore names from current declarations before dispatch in DSH. Leave compatible names and tool-call IDs unchanged by the name mapping.
- `tests/serialize.spec.ts` and `tests/adapter-request.spec.ts` cover replay and the mock transport tool loop. Run `npm run check` to type-check, test, and rebuild the tracked `lib/` artifacts.
