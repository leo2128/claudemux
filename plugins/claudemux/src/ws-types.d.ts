// Type-only shim: `#ws` is the package.json `imports` alias for our vendored
// copy of `ws` (under `third_party/ws/`). The runtime resolves it to the
// vendored `wrapper.mjs`; this declaration re-exports the upstream `@types/ws`
// type surface against the `#ws` specifier so the TypeScript checker can
// follow imports without a `paths`-mapping trick.
declare module '#ws' {
  export * from 'ws'
  export { default } from 'ws'
}
