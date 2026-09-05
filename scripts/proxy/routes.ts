export type ModelTransport = "chat-completions" | "responses"

export interface ModelRoute {
  id: string
  upstreamModel: string
  displayName: string
  transport: ModelTransport
  maxOutputTokens: number
  supportsAttachments: boolean
  supportsStructuredOutput: boolean
}

export const MODEL_ROUTES = [
  {
    id: "claude-opencode-nemotron-3.5-lightning-free",
    upstreamModel: "nemotron-3.5-lightning-free",
    displayName: "OpenCode Zen: Nemotron 3.5 Lightning (Free)",
    transport: "chat-completions",
    maxOutputTokens: 262_144,
    supportsAttachments: false,
    supportsStructuredOutput: true,
  },
  {
    id: "claude-opencode-nemotron-3-ultra-free",
    upstreamModel: "nemotron-3-ultra-free",
    displayName: "OpenCode Zen: Nemotron 3 Ultra (Free)",
    transport: "chat-completions",
    maxOutputTokens: 128_000,
    supportsAttachments: false,
    supportsStructuredOutput: false,
  },
  {
    id: "claude-opencode-muse-spark-1.3-contributor-free",
    upstreamModel: "muse-spark-1.3-contributor-free",
    displayName: "OpenCode Zen: Muse Spark 1.3 Contributor (Free)",
    transport: "responses",
    maxOutputTokens: 131_072,
    supportsAttachments: true,
    supportsStructuredOutput: true,
  },
  {
    id: "claude-opencode-muse-spark-1.2-contributor-free",
    upstreamModel: "muse-spark-1.2-contributor-free",
    displayName: "OpenCode Zen: Muse Spark 1.2 Contributor (Free)",
    transport: "responses",
    maxOutputTokens: 131_072,
    supportsAttachments: true,
    supportsStructuredOutput: true,
  },
  {
    id: "claude-opencode-mimo-v2.5-free",
    upstreamModel: "mimo-v2.5-free",
    displayName: "OpenCode Zen: MiMo V2.5 (Free)",
    transport: "chat-completions",
    maxOutputTokens: 32_000,
    supportsAttachments: true,
    supportsStructuredOutput: false,
  },
  {
    id: "claude-opencode-ling-3.0-flash-fin-free",
    upstreamModel: "ling-3.0-flash-fin-free",
    displayName: "OpenCode Zen: Ling 3.0 Flash Fin (Free)",
    transport: "chat-completions",
    maxOutputTokens: 32_768,
    supportsAttachments: false,
    supportsStructuredOutput: false,
  },
  {
    id: "claude-opencode-big-pickle",
    upstreamModel: "big-pickle",
    displayName: "OpenCode Zen: Big Pickle (Free)",
    transport: "chat-completions",
    maxOutputTokens: 32_000,
    supportsAttachments: false,
    supportsStructuredOutput: true,
  },
] as const satisfies readonly ModelRoute[]

export const DEFAULT_MODEL = MODEL_ROUTES[0]

const modelById = new Map<string, ModelRoute>()

for (const route of MODEL_ROUTES) {
  modelById.set(route.id.toLowerCase(), route)
  modelById.set(route.upstreamModel.toLowerCase(), route)
  modelById.set(`opencode/${route.upstreamModel}`.toLowerCase(), route)
}

export function resolveModel(requestedModel: string): ModelRoute | undefined {
  const normalized = requestedModel.toLowerCase()
  const exact = modelById.get(normalized)
  if (exact) return exact

  if (normalized === "sonnet") {
    return DEFAULT_MODEL
  }
  if (
    normalized === "opus" ||
    normalized === "opusplan" ||
    normalized === "fable"
  ) {
    return MODEL_ROUTES[1]
  }
  if (normalized === "haiku") {
    return MODEL_ROUTES[2]
  }

  if (normalized.startsWith("claude-") && normalized.includes("sonnet")) {
    return DEFAULT_MODEL
  }
  if (
    normalized.startsWith("claude-") &&
    (normalized.includes("opus") || normalized.includes("fable"))
  ) {
    return MODEL_ROUTES[1]
  }
  if (normalized.startsWith("claude-") && normalized.includes("haiku")) {
    return MODEL_ROUTES[2]
  }

  return undefined
}

export function getDiscoverableModels() {
  return MODEL_ROUTES.map(({ id, displayName }) => ({
    id,
    display_name: displayName,
  }))
}
