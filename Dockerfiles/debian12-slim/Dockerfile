FROM debian:12-slim

# Evita avisos interactivos durante la instalación de paquetes
ENV DEBIAN_FRONTEND=noninteractive

# Actualiza el sistema y limpia el caché para minimizar el tamaño de la imagen
RUN apt-get update && \
    apt-get upgrade -y && \
    apt-get clean && \
    rm -rf /var/lib/apt-get/lists/*

CMD ["bash"]