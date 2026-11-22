# dsh-plugin-filtration

A companion filter layer for [`dsh-plugin-masterprompt`](https://github.com/c137650/dsh-plugin-masterprompt).

It does two things, both on the `llm/stream` waterfall — the one place where a reply can still be rewritten before it lands in the session.

## 1. Final-reply filtration

After the agent finishes the text of a reply, that text is handed to a second model together with the **same persona and language habits** the session is already using, and rewritten once. The reply the user sees — and the text text-to-speech reads — is the rewritten one.

- Only the final reply. A step that carries tool calls is passed through untouched.
- Empty text is passed through untouched.
- The persona is not stored here: it is read from `dsh-plugin-masterprompt`'s `state.json`, and rendered with masterprompt's own `style.js` (`mergeVoice` / `voiceBlock` / `voiceOpenerBlock`). One copy of the code, no drift.

### Fact guard

A rewrite is accepted only if everything below survives verbatim:

- fenced code blocks and inline `code`
- Windows and relative paths
- URLs
- text inside 「」 and double quotes
- every number

Plus: the result must stay under 1.15× the original length. If any check fails the original is used — the layer never blocks a reply and never degrades one.

## 2. `maxOutputTokens` clamp

Gemini rejects `maxOutputTokens` above 65537 with

```
Unable to submit request because it has a maxOutputTokens value of 128000 but the supported range is from 1 (inclusive) to 65537 (exclusive).
```

When the request's provider, adapter or model looks like Gemini and the cap is above the configured limit (default 65536), the request is re-dispatched with the cap lowered. Other providers are untouched.

## Where the model comes from

Two independent things carry the name "model":

- **The model that does the filtering** — `provider` + `model` in `~/.dsh/dsh-plugin-filtration/state.json`. Change it from the panel below, or with `POST /dsh-flt/settings {"provider":"dku0","model":"gemini-3.8-flash"}`.
- **The models offered in the panel** — enumerated live from DSH itself: `llm.listProviders()` then `llm.listModels(provider)` for each route. Nothing is hard-coded, so every provider and model added to DSH shows up, including ones added later.

## Panel

`conversation.input.left`, next to the access-mode control: a small「过滤」button with a dot showing whether filtering is on. The panel has an on/off switch, a model picker grouped by provider, save, and refresh. It is backed by `GET /dsh-flt/models`.

## Install

```bash
# in your DSH profile directory
pnpm add link:/path/to/dsh-plugin-filtration
```

Then add it to the profile's bundle list, right after `dsh-plugin-masterprompt`:

```json
"dsh": { "profile": { "bundles": [ "...", "dsh-plugin-masterprompt", "dsh-plugin-filtration", "..." ] } }
```

`dsh-plugin-filtration` imports `dsh-plugin-masterprompt/lib/style.js`, and a `link:` dependency resolves that subpath from the plugin's own directory. Create the link once:

```powershell
New-Item -ItemType Junction -Path node_modules\dsh-plugin-masterprompt -Target /path/to/dsh-plugin-masterprompt
```

Restart DSH afterwards.

## HTTP

| Method | Path | Purpose |
| --- | --- | --- |
| `GET` | `/dsh-flt/state` | settings, rendered persona size, counters |
| `GET` | `/dsh-flt/models` | every provider and model DSH knows, for the panel |
| `GET`/`POST` | `/dsh-flt/settings` | `enabled`, `provider`, `model`, `maxTokens` |
| `POST` | `/dsh-flt/test` | `{ text }` → original, rewritten, reason |

## Notes

- The rewrite costs one extra model round trip per reply, so replies appear later than they would streamed.
- Turn it off from the panel or with `POST /dsh-flt/settings {"enabled": false}` — no restart needed.
- Failure is always silent: the original text goes through.

## License

MIT
