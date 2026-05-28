// Registers the resolve hook in `./resolver.mjs` on the active loader chain.
// `--import` only runs this file — it does not auto-register its hooks —
// so we call `module.register` ourselves. See `resolver.mjs` for the
// rules the hook applies and why they are needed at all.
import { register } from 'node:module'

register('./resolver.mjs', import.meta.url)
