#!/bin/bash

apt update
apt upgrade -y

apt install curl unzip -y
curl -fsSL https://bun.sh/install | bash
source ~/.bashrc
bun -v
ln -s $(which bun) /usr/local/bin/node
node -v
cmd login

tail -f /dev/null