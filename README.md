# Claude Code con OpenCode Zen

Este repositorio ejecuta Claude Code sobre los modelos gratuitos de
[OpenCode Zen](https://opencode.ai/) mediante un gateway local compatible con
la API Messages de Anthropic. No necesita una API key de Anthropic.

```text
Claude Code -> Anthropic Messages/SSE -> gateway Bun -> OpenCode Zen
```

El contenedor `opencode` ejecuta el gateway, no el CLI de OpenCode. El
contenedor `claude` instala Claude Code `2.1.261` y lo configura para usar ese
gateway en `http://127.0.0.1:3000`.

## Funcionalidad

- Descubrimiento de los siete modelos permitidos mediante `GET /v1/models`.
- Traducción de mensajes, sistema, herramientas y resultados de herramientas.
- Respuestas normales y streaming SSE con el formato de Anthropic.
- Uso de imágenes y documentos en los modelos que los admiten.
- Salida JSON estructurada mediante `output_config.format`.
- Propagación del esfuerzo de razonamiento y restricciones de herramientas.
- Cancelación de solicitudes, timeout y clasificación de errores upstream.
- Razonamiento privado separado del texto visible.
- Coste administrado de `0 USD` para evitar presupuestos ficticios en Claude.
- Allowlist estricta: no se pueden solicitar modelos upstream arbitrarios.

## Requisitos

- Linux con Docker Engine y Docker Compose.
- Acceso saliente a GitHub, `claude.ai` y OpenCode Zen durante la instalación.
- `/dev/net/tun` disponible.
- Permiso para montar `/var/run/docker.sock`.

Los contenedores usan red host, se ejecutan como root, montan el socket de
Docker y reciben `NET_ADMIN` y `/dev/net/tun`. Esta configuración está pensada
para un harness local de confianza, no para un host multiusuario ni para
exponerla a Internet.

## Inicio Rápido

Clona el repositorio y entra en su directorio:

```bash
git clone https://github.com/bunxdev/harness.git
cd harness
```

Levanta primero el gateway y después Claude Code:

```bash
docker compose -f opencode.yml up -d --wait
docker compose -f claude.yml up -d --wait
```

Comprueba su estado:

```bash
docker compose -f opencode.yml ps
docker compose -f claude.yml ps
curl -fsS http://127.0.0.1:3000/health
```

La primera ejecución instala Bun, las dependencias fijadas del gateway y
Claude Code. Las siguientes recreaciones reutilizan el volumen de dependencias
del gateway.

## Uso

Abre una sesión interactiva de Claude en el directorio montado `./scripts`:

```bash
docker exec -it -w /scripts claude claude
```

Ejecuta una consulta no interactiva:

```bash
docker exec -w /scripts claude \
  claude -p "Explica este proyecto" --output-format text
```

Autoriza una herramienta concreta en modo no interactivo:

```bash
docker exec -w /scripts claude \
  claude -p "Ejecuta las pruebas y resume el resultado" \
  --allowedTools Bash --output-format text
```

Selecciona un modelo con `--model`:

```bash
docker exec -it -w /scripts claude claude \
  --model claude-opencode-muse-spark-1.3-contributor-free
```

Dentro de una sesión interactiva también puedes usar `/model`.

## Modelos

| ID para Claude Code | Transporte | Adjuntos | JSON estructurado |
| --- | --- | --- | --- |
| `claude-opencode-nemotron-3.5-lightning-free` | Chat Completions | No | Sí |
| `claude-opencode-nemotron-3-ultra-free` | Chat Completions | No | No |
| `claude-opencode-muse-spark-1.3-contributor-free` | Responses | Sí | Sí |
| `claude-opencode-muse-spark-1.2-contributor-free` | Responses | Sí | Sí |
| `claude-opencode-mimo-v2.5-free` | Chat Completions | Solo mensajes de usuario | No |
| `claude-opencode-ling-3.0-flash-fin-free` | Chat Completions | No | No |
| `claude-opencode-big-pickle` | Chat Completions | No | Sí |

Los aliases de Claude se resuelven de esta forma:

| Alias | Modelo |
| --- | --- |
| `sonnet` | Nemotron 3.5 Lightning |
| `opus`, `opusplan`, `fable` | Nemotron 3 Ultra |
| `haiku` | Muse Spark 1.3 Contributor |

Nemotron 3.5 Lightning es el modelo predeterminado. La lista gratuita de Zen
puede cambiar o aplicar límites de frecuencia aunque Claude Code muestre coste
local de cero.

## Usar Otro Proyecto

Por defecto, Claude solo puede ver `./scripts`. Para trabajar sobre otro
proyecto, agrega un bind mount al servicio `claude` de `claude.yml`:

```yaml
volumes:
  - ./scripts:/scripts
  - /ruta/absoluta/al/proyecto:/workspace
  - ./scripts/claude-managed-settings.json:/etc/claude-code/managed-settings.json:ro
  - /var/run/docker.sock:/var/run/docker.sock
```

Recrea el contenedor y abre Claude en ese directorio:

```bash
docker compose -f claude.yml up -d --force-recreate --wait
docker exec -it -w /workspace claude claude
```

Los cambios hechos en `/workspace` se guardan directamente en el proyecto del
host.

## Configuración

Puedes definir estas variables antes de crear los contenedores o guardarlas en
un archivo `.env` local:

| Variable | Valor predeterminado | Uso |
| --- | --- | --- |
| `OPENCODE_API_KEY` | `public` | Credencial enviada a OpenCode Zen |
| `CLAUDE_GATEWAY_TOKEN` | `sk-ant-opencode-internal` | Token compartido entre Claude y el gateway |

Para un entorno compartido, usa un token aleatorio en lugar del valor local:

```bash
export CLAUDE_GATEWAY_TOKEN="$(openssl rand -hex 32)"
docker compose -f opencode.yml up -d --force-recreate --wait
docker compose -f claude.yml up -d --force-recreate --wait
```

El gateway escucha solo en `127.0.0.1:3000`. `/health` no requiere
autenticación; `/v1/models` y `/v1/messages` requieren Bearer token o
`x-api-key`.

## Reinicio

Para reiniciar los procesos sin cambiar la configuración:

```bash
docker restart opencode claude
```

Si modificaste Compose, variables, scripts de instalación o montajes, recrea
los servicios:

```bash
docker compose -f opencode.yml up -d --force-recreate --wait
docker compose -f claude.yml up -d --force-recreate --wait
```

Para detenerlos:

```bash
docker compose -f claude.yml down
docker compose -f opencode.yml down
```

## Pruebas

Ejecuta la suite dentro del contenedor para usar las dependencias del volumen:

```bash
docker exec -w /scripts/proxy opencode bun test
docker exec -w /scripts/proxy opencode bun run typecheck
```

Valida los archivos de infraestructura:

```bash
bash -n scripts/opencode.sh scripts/claude.sh
docker compose -f opencode.yml config --quiet
docker compose -f claude.yml config --quiet
```

## Limitaciones

- Los IDs personalizados pueden producir avisos `unrecognized_model` en
  Claude Code; no impiden completar las solicitudes.
- OpenCode Zen no implementa el precalentamiento de caché de Anthropic con
  `max_tokens: 0`; el gateway devuelve un error explícito.
- Los resultados multimedia de herramientas no se envían por Chat
  Completions. Muse puede recibirlos mediante Responses.
- La ventana de autocompactación se fija en 160 000 tokens para mantenerse por
  debajo del contexto de Big Pickle.
- Claude Code limita la salida a 32 000 tokens aunque algunos modelos anuncien
  límites superiores.

## Estructura

| Ruta | Propósito |
| --- | --- |
| `opencode.yml` | Servicio del gateway y volumen de dependencias |
| `claude.yml` | Servicio de Claude Code y configuración del cliente |
| `scripts/opencode.sh` | Bootstrap reproducible de Bun y arranque del gateway |
| `scripts/claude.sh` | Instalación y verificación de Claude Code |
| `scripts/claude-managed-settings.json` | Tarifas administradas en cero |
| `scripts/proxy/index.ts` | Adaptador Anthropic, autenticación y streaming |
| `scripts/proxy/routes.ts` | Allowlist, aliases y capacidades de modelos |
| `scripts/proxy/index.test.ts` | Pruebas del contrato y regresiones |
