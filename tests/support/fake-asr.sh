#!/bin/sh
# Stand-in for `python -c <helper> <request>` used by the acceptance test: answers every file with the same two words.
exec node "$(dirname "$0")/fake-asr.mjs" "$3"
