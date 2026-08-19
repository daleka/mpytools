# Change Log

All notable changes to the "mpytools" extension will be documented in this file.

Check [Keep a Changelog](http://keepachangelog.com/) for recommendations on how to structure this file.

## [Unreleased]

- Initial release

## [0.3.1]

- Run a project-configured firmware version generator before `Compile & Run`.
- Stop the build when version generation fails.
- Keep a local source snapshot for every generated firmware version.
- Support project-defined SemVer-style firmware names such as `v1.0.1-alpha.1+sHASH`.
