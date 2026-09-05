#!/bin/bash

apt update
apt upgrade -y

apt install curl unzip -y
curl -fsSL https://bun.sh/install | bash
source ~/.bashrc
bun -v
bun add -g opencode-ai
opencode -v

tail -f /dev/null