---
'claudemux': patch
---

`tm kill`: tear down the tmux session on graceful exit too. The
idle-marker SessionEnd signal fires while Claude's REPL is still
unwinding, so the shell that hosted Claude was left holding the
tmux session alive as a bare prompt — the teammate appeared
`unknown` in `tm ls` and a subsequent `tm spawn`/`tm resume`
reported "already running". The graceful branch now issues a
best-effort `tmux kill-session` after the marker signal, matching
the SIGHUP-fallback path.
