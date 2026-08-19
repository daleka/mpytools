# Change Log

All notable changes to the "mpytools" extension will be documented in this file.

Check [Keep a Changelog](http://keepachangelog.com/) for recommendations on how to structure this file.

## [Unreleased]

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
