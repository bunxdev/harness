#!/bin/bash
apt install curl unzip -y
curl -fsSL https://bun.sh/install | bash
source ~/.bashrc
bun -v

tail -f /dev/null