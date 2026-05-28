# Vendored: ws@8.21.0

- Upstream: https://github.com/websockets/ws
- Tag: `8.21.0`
- License: MIT (see `LICENSE`)

## Why vendored

The `tm` CLI runs TypeScript sources directly through
`node --experimental-transform-types`; the zero-install shape forbids a
runtime `npm install` step. `ws` is `tm`'s only runtime npm dependency, so
its source is committed here verbatim and consumed via the
`#ws` subpath in the plugin's `package.json` `imports` map.

## Updating

1. `npm install ws@<new-version> --no-save` in `plugins/claudemux/`.
2. `rsync` the runtime files into this directory:
   ```
   cp node_modules/ws/{index.js,wrapper.mjs,browser.js,LICENSE,README.md} \
      plugins/claudemux/third_party/ws/
   cp node_modules/ws/lib/*.js plugins/claudemux/third_party/ws/lib/
   ```
3. Bump `version` in this directory's `package.json` *and* the
   `Tag:` line at the top of this file — both are the authoritative
   record of what is checked in.
4. Skim the diff for new transitive `require()` calls — ws's runtime
   surface is `index.js` + `lib/*.js`; anything new outside those is a
   signal that the vendoring shape changed.
5. Run `npm test` in `plugins/claudemux/`.

## Security advisories

`ws` is no longer in the npm dependency tree — `npm audit`, Dependabot,
and GitHub's default vulnerability alerts do not cover this directory.
A CVE in ws will not surface automatically; the project has to watch the
upstream and pull in patches by hand.

Two practices that cover the gap together:

- **Subscribe to the GitHub Security Advisory feed at
  https://github.com/websockets/ws/security/advisories.** A new advisory
  is the trigger to ship a vendored bump. Tag a maintainer of the
  claudemux-core code on each advisory so the response is not blocked on
  one person noticing the email.
- **Run the drift check at every release.** Before cutting a release
  for the `claudemux` plugin, run
  `bash plugins/claudemux/scripts/check-ws-drift.sh`: it prints
  the vendored version, fetches the upstream `latest` dist-tag via
  `npm view`, and exits non-zero when the two diverge. Any non-zero
  exit means re-do the **Updating** flow before releasing.

The check script is intentionally cheap and read-only — it does not
auto-bump the vendored copy, because a vendor bump should be reviewed
the same way any other runtime change is.
