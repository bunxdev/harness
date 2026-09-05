#!/bin/bash

apt update
apt upgrade -y

apt install neofetch nano docker.io curl -y
neofetch
curl -fsSL https://claude.ai/install.sh | bash

echo 'export PATH="$HOME/.local/bin:$PATH"' >> ~/.bashrc && source ~/.bashrc
claude --help

tail -f /dev/null