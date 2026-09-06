#!/bin/bash
apt install curl unzip -y
curl -fsSL https://cli.kiro.dev/install | bash
echo 'export PATH="$HOME/.local/bin:$PATH"' >> ~/.bashrc
source ~/.bashrc


tail -f /dev/null