#!/bin/bash

ln -s $(which bun) /usr/local/bin/node
bun pm -g trust @kilocode/cli
bun add -g trust @kilocode/cli

tail -f /dev/null