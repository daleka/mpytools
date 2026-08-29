# Change Log

All notable changes to the "mpytools" extension will be documented in this file.

Check [Keep a Changelog](http://keepachangelog.com/) for recommendations on how to structure this file.

## [Unreleased]

## [0.4.6]

- Resolve every project-scoped command from the active editor's workspace
  instead of blindly using the first folder. Multi-root workspaces now ask for
  an explicit project whenever the active editor does not disambiguate it.
- Start source projects through MicroPython's standard friendly-REPL soft reset,
  allowing the runtime to execute `boot.py` and `main.py` without requiring a
  project-specific `main.run()` function.
- Preserve root `boot.py` and `main.py` as source entry scripts while compiling
  all importable modules to `.mpy`. Precompiled-only `main.mpy` projects use a
  plain `import main` fallback after reset.
- Remove only the conflicting stale `/main.py` or `/main.mpy` entry point after
  upload, preventing a previous project format from shadowing the new one while
  leaving all unrelated device data untouched.

## [0.4.5]

- Batch MPyTools Output writes into one block every 150 ms, with a bounded
  64 KiB buffer and guaranteed flush on show, hide, and dispose. This covers
  parallel `mpy-cross` diagnostics as well as build progress and sharply
  reduces Output model updates while preserving every log line.

## [0.4.4]

- Restore the proven REPL startup sequence used by earlier MPyTools releases:
  wait for `mpremote`, send `Ctrl-C`, then submit `import main` and `main.run()`
  as ordinary REPL commands so **Compile & Run** starts the project reliably.

## [0.4.3]

- Restore live build-log following by resetting the Output cursor once at the
  start of a build and then using VS Code's native auto-scroll, without the
  per-line UI command flood that caused compilation freezes.

## [0.4.2]

- Prefer the current managed `mpy-cross` when it emits the device's requested
  bytecode ABI, using archived compilers only as compatibility fallbacks. This
  preserves newer MicroPython syntax such as adjacent f-string concatenation.
- Replace the Marketplace extension icon with the new MPyTools artwork.

## [0.4.1]

- Move compilation output and generated asset wrappers completely out of the
  workspace into VS Code's workspace-scoped extension storage.
- Ignore `__pycache__`, `*.pyc`, virtual environments, tool caches, hidden
  directories, and symlinks while enumerating project sources.
- Wrap only explicitly configured text/resource extensions and copy unknown or
  binary assets unchanged.
- Remove per-line Output scroll commands and throttle progress updates to keep
  the Extension Host responsive on large projects.
- Add build-cache invalidation for extension, compiler, asset, and target ABI
  changes, plus Extension Host lag diagnostics around `mpy-cross`.
- Reject colliding asset outputs instead of silently overwriting them.

## [0.4.0]

- Fix Linux absolute serial paths being expanded from `/dev/ttyACM0` to
  `/dev//dev/ttyACM0`.
- Add typed `mpremote connect list` parsing and persist devices by USB serial
  number when available.
- Serialize device commands and coordinate them with a single extension-owned
  REPL terminal to prevent false "port busy" failures.
- Replace shell command construction with argument-safe process execution.
- Add isolated, pinned `mpremote` and `mpy-cross` installation under VS Code
  extension storage; do not modify the system Python or `PATH`.
- Add Linux-oriented diagnostics for ports, permissions, groups, tool source,
  and device connectivity.
- Move build artifacts and temporary device files into MPyTools-owned storage.
- Preserve spaces and Unicode in device file names and guard local paths against
  traversal.
- Install stubs only into `.mpytools/typings` without deleting user folders or
  rewriting `pyproject.toml`.
- Replace platform-specific ZIP commands with a cross-platform archive library.
- Add portable core tests, release checks, and Windows/Linux/macOS CI.

## [0.3.2]

- Resolve and run the native `mpy-cross` binary instead of starting its Python launcher for every file.
- Preserve the installed package's `-b` compatibility mapping by selecting the matching archived compiler.
- Compile independent Python files with up to four workers while keeping wrapped assets sequential.
- Find `mpy_cross` through Python even when its `Scripts` directory is missing from `PATH`.
- Support the Windows `py -3` launcher during dependency installation and validate the compiler afterwards.

## [0.3.1]

- Run a project-configured firmware version generator before `Compile & Run`.
- Stop the build when version generation fails.
- Keep a local source snapshot for every generated firmware version.
- Support project-defined SemVer-style firmware names such as `v1.0.1-alpha.1+sHASH`.
