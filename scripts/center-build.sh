#!/bin/sh
set -eu
cd "$(dirname "$0")/.."
docker build -f Dockerfile -t pibot-center:local "$@" .
