# --- Etapa 1: Construcción/Descarga (Builder) ---
FROM debian AS builder

ENV BUN_INSTALL=/root/.bun

RUN apt update && apt upgrade -y && \
    apt install curl unzip -y && \
    curl -fsSL https://bun.sh/install | bash 

# --- Etapa 2: Imagen Final Limpia ---
FROM debian:12-slim

ENV BUN_INSTALL=/root/.bun
ENV PATH=$BUN_INSTALL/bin:$PATH

# Copiamos ÚNICAMENTE la carpeta de Bun compilada/descargada desde el builder
COPY --from=builder /root/.bun /root/.bun

CMD ["bash"]