# Changelog

## [Unreleased]

## [0.1.0] - 2026-08-02

### Added

- First release of Syrup, a statically typed, Swift-flavored scripting language that compiles to JavaScript.
- Parser, bidirectional type checker and JavaScript emitter.
- `ScriptHost` for compiling, analyzing and testing scripts, with host APIs injected as declarations plus runtime bindings.
- Web Worker sandbox runner, exported from `@paplico/syrup/worker`.
- Language service and Monaco editor integration (completion, hover, signature help, go to definition).
