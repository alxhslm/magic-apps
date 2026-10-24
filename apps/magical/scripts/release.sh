#!/usr/bin/env bash
#
# Create a release of Magical.
#
# This runs from a developer shell to tag, build, notarise and publish a release.
# Run with --dry-run to validate the git state and work out the next version
# without making changes.
#
# Releases and tags come strictly from a commit on main. The version comes from
# the release tag when one triggered the run, and from the Conventional Commit
# prefixes since the last magical-v tag otherwise.
#
# Everything it does is in tools/release.sh, shared with the other app; only the
# three names below differ. Run with --help for the options.
set -euo pipefail

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../../.." && pwd)"

RELEASE_APP_ID=magical
RELEASE_APP_NAME=Magical
RELEASE_ENV_PREFIX=MAGICAL

. "$REPO_ROOT/tools/release.sh"

release_main "$@"
