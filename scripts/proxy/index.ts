import { timingSafeEqual } from "node:crypto"
import { createOpenAI } from "@ai-sdk/openai"
import { createOpenAICompatible } from "@ai-sdk/openai-compatible"
import {
  generateText,
  jsonSchema,
  Output,
  streamText,
  tool,
  type FinishReason,
  type LanguageModel,
  type LanguageModelUsage,
  type ModelMessage,
  type ToolChoice,
  type ToolSet,
  type UserContent,
} from "ai"
import {
  getDiscoverableModels,
  resolveModel,
  type ModelRoute,
} from "./routes"

type JsonObject = Record<string, unknown>

interface AnthropicRequest {
  model?: unknown
  max_tokens?: unknown
  messages?: unknown
  system?: unknown
  stream?: unknown
  temperature?: unknown
  top_p?: unknown
  stop_sequences?: unknown
  tools?: unknown
  tool_choice?: unknown
  output_config?: unknown
}

interface PreparedPrompt {
  messages: ModelMessage[]
  system?: string
  hasUserAttachments: boolean
  hasToolResultAttachments: boolean
}

interface GatewayGenerateResult {
  text: string
  reasoningText: string | undefined
  finishReason: FinishReason
  content: Awaited<ReturnType<typeof generateText<ToolSet>>>["content"]
  usage: LanguageModelUsage
}

type ToolResultPart = Extract<
  Extract<ModelMessage, { role: "tool" }>["content"][number],
  { type: "tool-result" }
>
type ToolResultOutput = ToolResultPart["output"]
type ToolResultContent = Extract<ToolResultOutput, { type: "content" }>["value"]

interface StreamLifecycle {
  onCancel?: () => void
  onClose?: () => void
}

class RequestError extends Error {
  constructor(
    message: string,
    readonly status = 400,
    readonly type = "invalid_request_error",
  ) {
    super(message)
  }
}

const ZEN_BASE_URL = (process.env.OPENCODE_BASE_URL ?? "https://opencode.ai/zen/v1").replace(
  /\/$/,
  "",
)
const ZEN_API_KEY = process.env.OPENCODE_API_KEY ?? "public"
const GATEWAY_AUTH_TOKEN =
  process.env.GATEWAY_AUTH_TOKEN ?? "sk-ant-opencode-internal"
const PORT = Number.parseInt(process.env.PROXY_PORT ?? "3000", 10)
const HOST = process.env.PROXY_HOST ?? "127.0.0.1"
const DISABLE_PARALLEL_TOOLS_HEADER = "x-gateway-disable-parallel-tools"

const chatFetch = (async (
  input: Parameters<typeof fetch>[0],
  init?: Parameters<typeof fetch>[1],
) => {
  const headers = new Headers(init?.headers)
  const disableParallelTools = headers.get(DISABLE_PARALLEL_TOOLS_HEADER) === "1"
  headers.delete(DISABLE_PARALLEL_TOOLS_HEADER)

  let body = init?.body
  if (disableParallelTools && typeof body === "string") {
    const payload = JSON.parse(body) as JsonObject
    body = JSON.stringify({ ...payload, parallel_tool_calls: false })
  }

  return fetch(input, { ...init, headers, body })
}) as typeof fetch

const chatProvider = createOpenAICompatible({
  name: "opencode",
  baseURL: ZEN_BASE_URL,
  apiKey: ZEN_API_KEY,
  includeUsage: true,
  supportsStructuredOutputs: true,
  fetch: chatFetch,
})
const responsesProvider = createOpenAI({
  name: "opencode",
  baseURL: ZEN_BASE_URL,
  apiKey: ZEN_API_KEY,
})

function isObject(value: unknown): value is JsonObject {
  return typeof value === "object" && value !== null && !Array.isArray(value)
}

function secureEqual(left: string, right: string): boolean {
  const leftBuffer = Buffer.from(left)
  const rightBuffer = Buffer.from(right)
  return (
    leftBuffer.length === rightBuffer.length &&
    timingSafeEqual(leftBuffer, rightBuffer)
  )
}

function isAuthorized(request: Request): boolean {
  const authorization = request.headers.get("authorization")
  const bearer = authorization?.match(/^Bearer\s+(.+)$/i)?.[1]
  const apiKey = request.headers.get("x-api-key")
  return (
    (bearer !== undefined && secureEqual(bearer, GATEWAY_AUTH_TOKEN)) ||
    (apiKey !== null && secureEqual(apiKey, GATEWAY_AUTH_TOKEN))
  )
}

function jsonResponse(body: unknown, status = 200): Response {
  return Response.json(body, {
    status,
    headers: { "cache-control": "no-store" },
  })
}

function errorResponse(message: string, status = 400, type = "invalid_request_error") {
  return jsonResponse(
    {
      type: "error",
      error: { type, message },
    },
    status,
  )
}

function textFromContent(content: unknown): string {
  if (typeof content === "string") return content
  if (!Array.isArray(content)) {
    return content === undefined ? "" : JSON.stringify(content)
  }

  return content
    .map((part) => {
      if (isObject(part) && part.type === "text" && typeof part.text === "string") {
        return part.text
      }
      return JSON.stringify(part)
    })
    .filter(Boolean)
    .join("\n")
}

function systemFromRequest(system: unknown): string | undefined {
  if (typeof system === "string") return system || undefined
  if (!Array.isArray(system)) return undefined

  const text = system
    .map((part) =>
      isObject(part) && part.type === "text" && typeof part.text === "string"
        ? part.text
        : "",
    )
    .filter(Boolean)
    .join("\n")
  return text || undefined
}

function blocksFromContent(content: unknown): unknown[] {
  if (typeof content === "string") return [{ type: "text", text: content }]
  if (Array.isArray(content)) return content
  throw new RequestError("Each message content must be a string or an array")
}

function prepareToolResult(
  content: unknown,
  isError: boolean,
): { output: ToolResultOutput; hasAttachments: boolean } {
  if (isError) {
    const value = Array.isArray(content)
      ? content
          .map((part) => {
            if (isObject(part) && part.type === "text" && typeof part.text === "string") {
              return part.text
            }
            if (isObject(part) && typeof part.type === "string") {
              return `[${part.type} omitted from error result]`
            }
            return JSON.stringify(part) ?? String(part)
          })
          .join("\n")
      : textFromContent(content)
    return { output: { type: "error-text", value }, hasAttachments: false }
  }

  if (typeof content === "string" || content === undefined) {
    return {
      output: { type: "text", value: typeof content === "string" ? content : "" },
      hasAttachments: false,
    }
  }
  if (!Array.isArray(content)) {
    throw new RequestError("tool_result content must be a string or an array")
  }

  const value: ToolResultContent = []
  let hasAttachments = false

  for (const part of content) {
    if (!isObject(part) || typeof part.type !== "string") {
      value.push({ type: "text", text: JSON.stringify(part) ?? String(part) })
      continue
    }

    if (part.type === "text" && typeof part.text === "string") {
      value.push({ type: "text", text: part.text })
      continue
    }

    if (part.type === "image" && isObject(part.source)) {
      if (
        part.source.type === "base64" &&
        typeof part.source.data === "string" &&
        typeof part.source.media_type === "string"
      ) {
        hasAttachments = true
        value.push({
          type: "image-data",
          data: part.source.data,
          mediaType: part.source.media_type,
        })
        continue
      }
      if (part.source.type === "url" && typeof part.source.url === "string") {
        try {
          new URL(part.source.url)
        } catch {
          throw new RequestError("Invalid image URL in tool_result")
        }
        hasAttachments = true
        value.push({ type: "image-url", url: part.source.url })
        continue
      }
      throw new RequestError("Unsupported image source in tool_result")
    }

    if (part.type === "document" && isObject(part.source)) {
      if (part.source.type === "text" && typeof part.source.data === "string") {
        value.push({ type: "text", text: part.source.data })
        continue
      }
      if (
        part.source.type === "base64" &&
        typeof part.source.data === "string" &&
        typeof part.source.media_type === "string"
      ) {
        hasAttachments = true
        value.push({
          type: "file-data",
          data: part.source.data,
          mediaType: part.source.media_type,
          filename: typeof part.title === "string" ? part.title : undefined,
        })
        continue
      }
      if (part.source.type === "url" && typeof part.source.url === "string") {
        try {
          new URL(part.source.url)
        } catch {
          throw new RequestError("Invalid document URL in tool_result")
        }
        hasAttachments = true
        value.push({ type: "file-url", url: part.source.url })
        continue
      }
      throw new RequestError("Unsupported document source in tool_result")
    }

    value.push({ type: "text", text: JSON.stringify(part) })
  }

  if (!hasAttachments) {
    return {
      output: {
        type: "text",
        value: value
          .map((part) => (part.type === "text" ? part.text : ""))
          .join("\n"),
      },
      hasAttachments: false,
    }
  }

  return { output: { type: "content", value }, hasAttachments: true }
}

export function preparePrompt(body: AnthropicRequest): PreparedPrompt {
  if (!Array.isArray(body.messages) || body.messages.length === 0) {
    throw new RequestError("messages must be a non-empty array")
  }

  const toolNames = new Map<string, string>()
  for (const message of body.messages) {
    if (!isObject(message) || message.role !== "assistant") continue
    for (const part of blocksFromContent(message.content)) {
      if (
        isObject(part) &&
        part.type === "tool_use" &&
        typeof part.id === "string" &&
        typeof part.name === "string"
      ) {
        toolNames.set(part.id, part.name)
      }
    }
  }

  const messages: ModelMessage[] = []
  let hasUserAttachments = false
  let hasToolResultAttachments = false

  for (const rawMessage of body.messages) {
    if (!isObject(rawMessage) || typeof rawMessage.role !== "string") {
      throw new RequestError("Each message must contain a valid role")
    }

    const blocks = blocksFromContent(rawMessage.content)

    if (rawMessage.role === "system") {
      const content = textFromContent(blocks)
      if (content) messages.push({ role: "system", content })
      continue
    }

    if (rawMessage.role === "assistant") {
      const content: Extract<ModelMessage, { role: "assistant" }>["content"] = []
      for (const part of blocks) {
        if (!isObject(part)) continue
        if (part.type === "text" && typeof part.text === "string" && part.text) {
          content.push({ type: "text", text: part.text })
        } else if (
          part.type === "tool_use" &&
          typeof part.id === "string" &&
          typeof part.name === "string"
        ) {
          if (!isObject(part.input)) {
            throw new RequestError(`tool_use ${part.id} input must be an object`)
          }
          content.push({
            type: "tool-call",
            toolCallId: part.id,
            toolName: part.name,
            input: part.input,
          })
        }
      }
      if (content.length > 0) messages.push({ role: "assistant", content })
      continue
    }

    if (rawMessage.role !== "user") {
      throw new RequestError(`Unsupported message role: ${rawMessage.role}`)
    }

    let userParts: UserContent extends string ? never : Exclude<UserContent, string> = []
    let toolParts: Extract<ModelMessage, { role: "tool" }>["content"] = []

    const flushUser = () => {
      if (userParts.length === 0) return
      messages.push({ role: "user", content: userParts })
      userParts = []
    }
    const flushTools = () => {
      if (toolParts.length === 0) return
      messages.push({ role: "tool", content: toolParts })
      toolParts = []
    }

    for (const part of blocks) {
      if (!isObject(part)) continue

      if (part.type === "tool_result" && typeof part.tool_use_id === "string") {
        flushUser()
        const toolName = toolNames.get(part.tool_use_id)
        if (!toolName) {
          throw new RequestError(
            `tool_result references unknown tool_use id: ${part.tool_use_id}`,
          )
        }
        if (part.is_error !== undefined && typeof part.is_error !== "boolean") {
          throw new RequestError("tool_result is_error must be a boolean")
        }
        const preparedResult = prepareToolResult(part.content, part.is_error === true)
        hasToolResultAttachments ||= preparedResult.hasAttachments
        toolParts.push({
          type: "tool-result",
          toolCallId: part.tool_use_id,
          toolName,
          output: preparedResult.output,
        })
        continue
      }

      flushTools()
      if (part.type === "text" && typeof part.text === "string") {
        if (part.text) userParts.push({ type: "text", text: part.text })
      } else if (part.type === "image" && isObject(part.source)) {
        if (part.source.type === "base64" && typeof part.source.data === "string") {
          hasUserAttachments = true
          userParts.push({
            type: "image",
            image: part.source.data,
            mediaType:
              typeof part.source.media_type === "string"
                ? part.source.media_type
                : undefined,
          })
        } else if (
          part.source.type === "url" &&
          typeof part.source.url === "string"
        ) {
          hasUserAttachments = true
          try {
            userParts.push({ type: "image", image: new URL(part.source.url) })
          } catch {
            throw new RequestError("Invalid image URL")
          }
        } else {
          throw new RequestError("Unsupported image source")
        }
      } else if (part.type === "document" && isObject(part.source)) {
        if (
          part.source.type === "base64" &&
          typeof part.source.data === "string" &&
          typeof part.source.media_type === "string"
        ) {
          hasUserAttachments = true
          userParts.push({
            type: "file",
            data: part.source.data,
            mediaType: part.source.media_type,
            filename: typeof part.title === "string" ? part.title : undefined,
          })
        } else if (
          part.source.type === "text" &&
          typeof part.source.data === "string"
        ) {
          userParts.push({ type: "text", text: part.source.data })
        } else if (
          part.source.type === "url" &&
          typeof part.source.url === "string"
        ) {
          hasUserAttachments = true
          try {
            userParts.push({
              type: "file",
              data: new URL(part.source.url),
              mediaType: "application/pdf",
              filename: typeof part.title === "string" ? part.title : undefined,
            })
          } catch {
            throw new RequestError("Invalid document URL")
          }
        } else {
          throw new RequestError("Unsupported document source")
        }
      } else {
        userParts.push({ type: "text", text: JSON.stringify(part) })
      }
    }

    flushTools()
    flushUser()
  }

  if (messages.length === 0) {
    throw new RequestError("messages contain no supported content")
  }

  return {
    messages,
    system: systemFromRequest(body.system),
    hasUserAttachments,
    hasToolResultAttachments,
  }
}

function prepareTools(rawTools: unknown): ToolSet | undefined {
  if (rawTools === undefined) return undefined
  if (!Array.isArray(rawTools)) throw new RequestError("tools must be an array")

  const tools = Object.create(null) as ToolSet
  for (const rawTool of rawTools) {
    if (!isObject(rawTool)) throw new RequestError("Each tool must be an object")

    if (
      typeof rawTool.name !== "string" ||
      !/^[a-zA-Z0-9_-]{1,128}$/.test(rawTool.name)
    ) {
      throw new RequestError("Each tool must have a valid name")
    }
    if (!isObject(rawTool.input_schema)) {
      throw new RequestError(`Tool ${rawTool.name} must have an input_schema`)
    }
    if (rawTool.input_schema.type !== "object") {
      throw new RequestError(`Tool ${rawTool.name} input_schema must have type object`)
    }
    if (Object.hasOwn(tools, rawTool.name)) {
      throw new RequestError(`Duplicate tool name: ${rawTool.name}`)
    }
    if (rawTool.strict !== undefined && typeof rawTool.strict !== "boolean") {
      throw new RequestError(`Tool ${rawTool.name} strict must be a boolean`)
    }

    tools[rawTool.name] = tool({
      description:
        typeof rawTool.description === "string" ? rawTool.description : undefined,
      inputSchema: jsonSchema(
        rawTool.input_schema as Parameters<typeof jsonSchema>[0],
      ),
      strict: rawTool.strict,
    })
  }

  return Object.keys(tools).length > 0 ? tools : undefined
}

function prepareToolChoice(
  rawChoice: unknown,
  tools: ToolSet | undefined,
  route: ModelRoute,
): ToolChoice<ToolSet> | undefined {
  if (rawChoice === undefined) return tools ? "auto" : undefined
  if (!isObject(rawChoice) || typeof rawChoice.type !== "string") {
    throw new RequestError("tool_choice must contain a valid type")
  }
  if (
    rawChoice.disable_parallel_tool_use !== undefined &&
    typeof rawChoice.disable_parallel_tool_use !== "boolean"
  ) {
    throw new RequestError("tool_choice disable_parallel_tool_use must be a boolean")
  }

  if (rawChoice.type === "none") return tools ? "none" : undefined
  if (!tools) throw new RequestError("tool_choice requires at least one tool")

  if (rawChoice.type === "auto") return "auto"
  if (route.transport === "responses") {
    throw new RequestError(
      `Model ${route.id} supports only auto or none tool_choice`,
    )
  }
  if (rawChoice.type === "any") return "required"
  if (rawChoice.type === "tool" && typeof rawChoice.name === "string") {
    if (!Object.hasOwn(tools, rawChoice.name)) {
      throw new RequestError(`Unknown tool in tool_choice: ${rawChoice.name}`)
    }
    return { type: "tool", toolName: rawChoice.name }
  }

  throw new RequestError(`Unsupported tool_choice type: ${rawChoice.type}`)
}

function getLanguageModel(route: ModelRoute): LanguageModel {
  return route.transport === "responses"
    ? responsesProvider.responses(route.upstreamModel)
    : chatProvider(route.upstreamModel)
}

function finiteNumber(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) ? value : undefined
}

function generationOptions(body: AnthropicRequest, route: ModelRoute) {
  const requestedMaxTokens = finiteNumber(body.max_tokens)
  if (
    requestedMaxTokens === undefined ||
    requestedMaxTokens < 0 ||
    !Number.isInteger(requestedMaxTokens)
  ) {
    throw new RequestError("max_tokens must be a non-negative integer")
  }
  if (requestedMaxTokens === 0) {
    throw new RequestError(
      "OpenCode Zen does not support max_tokens 0 cache prewarming",
    )
  }
  if (requestedMaxTokens > route.maxOutputTokens) {
    throw new RequestError(
      `max_tokens exceeds the ${route.maxOutputTokens} token limit for ${route.id}`,
    )
  }
  if (route.transport === "responses" && requestedMaxTokens < 16) {
    throw new RequestError(`Model ${route.id} requires max_tokens to be at least 16`)
  }

  if (body.temperature !== undefined && finiteNumber(body.temperature) === undefined) {
    throw new RequestError("temperature must be a finite number")
  }
  if (body.top_p !== undefined && finiteNumber(body.top_p) === undefined) {
    throw new RequestError("top_p must be a finite number")
  }
  if (body.stop_sequences !== undefined && !Array.isArray(body.stop_sequences)) {
    throw new RequestError("stop_sequences must be an array of strings")
  }
  if (
    Array.isArray(body.stop_sequences) &&
    !body.stop_sequences.every((value) => typeof value === "string")
  ) {
    throw new RequestError("stop_sequences must contain only strings")
  }

  const tools = prepareTools(body.tools)
  const toolChoice = prepareToolChoice(body.tool_choice, tools, route)
  const parallelToolCalls = isObject(body.tool_choice)
    ? typeof body.tool_choice.disable_parallel_tool_use === "boolean"
      ? !body.tool_choice.disable_parallel_tool_use
      : undefined
    : undefined
  const stopSequences = body.stop_sequences as string[] | undefined
  if (route.transport === "responses" && stopSequences?.length) {
    throw new RequestError(`Model ${route.id} does not support stop_sequences`)
  }
  let reasoningEffort: string | undefined
  let output: ReturnType<typeof Output.object> | undefined

  if (body.output_config !== undefined) {
    if (!isObject(body.output_config)) {
      throw new RequestError("output_config must be an object")
    }
    if (body.output_config.effort !== undefined) {
      if (
        typeof body.output_config.effort !== "string" ||
        !["low", "medium", "high", "xhigh", "max"].includes(
          body.output_config.effort,
        )
      ) {
        throw new RequestError("output_config effort is invalid")
      }
      reasoningEffort =
        body.output_config.effort === "max" ? "xhigh" : body.output_config.effort
    }
    if (body.output_config.format !== undefined) {
      if (
        !isObject(body.output_config.format) ||
        body.output_config.format.type !== "json_schema" ||
        !isObject(body.output_config.format.schema)
      ) {
        throw new RequestError("output_config format must contain a JSON schema")
      }
      if (!route.supportsStructuredOutput) {
        throw new RequestError(`Model ${route.id} does not support structured output`)
      }
      if (body.output_config.format.schema.type !== "object") {
        throw new RequestError("output_config JSON schema must have type object")
      }
      output = Output.object({
        schema: jsonSchema(
          body.output_config.format.schema as Parameters<typeof jsonSchema>[0],
        ),
      })
    }
  }

  let providerOptions: Parameters<typeof generateText>[0]["providerOptions"]
  if (route.transport === "responses") {
    providerOptions = {
      openai: {
        store: false,
        forceReasoning: true,
        ...(reasoningEffort ? { reasoningEffort } : {}),
        ...(parallelToolCalls !== undefined ? { parallelToolCalls } : {}),
      },
    }
  } else if (reasoningEffort) {
    providerOptions = { opencode: { reasoningEffort } }
  }

  return {
    model: getLanguageModel(route),
    ...preparePrompt(body),
    tools: toolChoice === "none" ? undefined : tools,
    toolChoice: toolChoice === "none" ? undefined : toolChoice,
    maxOutputTokens: requestedMaxTokens,
    temperature: finiteNumber(body.temperature),
    topP: finiteNumber(body.top_p),
    stopSequences: stopSequences?.length ? stopSequences : undefined,
    providerOptions,
    headers:
      route.transport === "chat-completions" && parallelToolCalls === false
        ? { [DISABLE_PARALLEL_TOOLS_HEADER]: "1" }
        : undefined,
    output,
    maxRetries: 0,
    timeout: 600_000,
  }
}

function anthropicUsage(usage: LanguageModelUsage) {
  return {
    input_tokens: usage.inputTokenDetails?.noCacheTokens ?? usage.inputTokens ?? 0,
    cache_creation_input_tokens: usage.inputTokenDetails?.cacheWriteTokens ?? 0,
    cache_read_input_tokens: usage.inputTokenDetails?.cacheReadTokens ?? 0,
    output_tokens: usage.outputTokens ?? 0,
    output_tokens_details: {
      thinking_tokens: usage.outputTokenDetails?.reasoningTokens ?? 0,
    },
  }
}

function stopReason(reason: FinishReason) {
  if (reason === "tool-calls") return "tool_use"
  if (reason === "length") return "max_tokens"
  if (reason === "content-filter") return "refusal"
  return "end_turn"
}

function messageId() {
  return `msg_${crypto.randomUUID().replaceAll("-", "")}`
}

function stripReasoningPrefix(text: string, reasoningText: string | undefined) {
  if (!reasoningText || !text.startsWith(reasoningText)) return text
  return text.slice(reasoningText.length)
}

export function nonStreamingResponse(
  requestedModel: string,
  result: GatewayGenerateResult,
) {
  if (result.finishReason === "error") {
    throw new Error("Model generation failed")
  }
  const content: JsonObject[] = []
  let pendingText = ""
  let checkedReasoningPrefix = false
  const flushText = () => {
    if (!pendingText) return
    const text = checkedReasoningPrefix
      ? pendingText
      : stripReasoningPrefix(pendingText, result.reasoningText)
    checkedReasoningPrefix = true
    pendingText = ""
    if (text) content.push({ type: "text", text })
  }

  for (const part of result.content) {
    if (part.type === "text") {
      pendingText += part.text
    } else if (part.type === "tool-call") {
      flushText()
      if (("invalid" in part && part.invalid) || !isObject(part.input)) {
        throw new Error(`Model returned invalid input for tool ${part.toolName}`)
      }
      content.push({
        type: "tool_use",
        id: part.toolCallId,
        name: part.toolName,
        input: part.input,
      })
    } else if (part.type === "tool-error") {
      throw new Error(`Model returned an invalid tool call for ${part.toolName}`)
    }
  }
  flushText()

  return {
    id: messageId(),
    type: "message",
    role: "assistant",
    model: requestedModel,
    content,
    stop_reason: stopReason(result.finishReason),
    stop_sequence: null,
    usage: anthropicUsage(result.usage),
  }
}

function sseEvent(type: string, data: unknown): Uint8Array {
  return new TextEncoder().encode(`event: ${type}\ndata: ${JSON.stringify(data)}\n\n`)
}

export function streamingResponse(
  requestedModel: string,
  result: ReturnType<typeof streamText<ToolSet>>,
  lifecycle: StreamLifecycle = {},
): Response {
  let cancelled = false
  const stream = new ReadableStream<Uint8Array>({
    start(controller) {
      void (async () => {
        const blocks = new Map<
          string,
          { index: number; kind: "text" | "tool"; closed: boolean }
        >()
        const textStates = new Map<
          string,
          { pending: string; prefixChecked: boolean }
        >()
        let nextIndex = 0
        let finished = false
        let reasoningText = ""

        const send = (type: string, data: unknown) => {
          if (cancelled) return
          try {
            controller.enqueue(sseEvent(type, data))
          } catch {
            cancelled = true
          }
        }
        const closeBlock = (id: string) => {
          const block = blocks.get(id)
          if (!block || block.closed) return
          send("content_block_stop", {
            type: "content_block_stop",
            index: block.index,
          })
          block.closed = true
        }
        const closeAllBlocks = () => {
          for (const [id] of blocks) closeBlock(id)
        }
        const sendText = (id: string, text: string) => {
          if (!text) return
          let block = blocks.get(id)
          if (!block || block.closed) {
            closeAllBlocks()
            const index = nextIndex++
            block = { index, kind: "text", closed: false }
            blocks.set(id, block)
            send("content_block_start", {
              type: "content_block_start",
              index,
              content_block: { type: "text", text: "" },
            })
          }
          send("content_block_delta", {
            type: "content_block_delta",
            index: block.index,
            delta: { type: "text_delta", text },
          })
        }
        const flushPendingText = () => {
          for (const [id, state] of textStates) {
            if (!state.prefixChecked && state.pending !== reasoningText) {
              sendText(id, state.pending)
            }
            state.pending = ""
            state.prefixChecked = true
            closeBlock(id)
          }
        }

        const ping = setInterval(() => send("ping", { type: "ping" }), 15_000)

        try {
          send("message_start", {
            type: "message_start",
            message: {
              id: messageId(),
              type: "message",
              role: "assistant",
              model: requestedModel,
              content: [],
              stop_reason: null,
              stop_sequence: null,
              usage: { input_tokens: 0, output_tokens: 0 },
            },
          })

          for await (const part of result.fullStream) {
            if (cancelled) break
            if (part.type === "text-start") {
              textStates.set(part.id, { pending: "", prefixChecked: false })
            } else if (part.type === "text-delta") {
              const state = textStates.get(part.id) ?? {
                pending: "",
                prefixChecked: false,
              }
              textStates.set(part.id, state)

              if (state.prefixChecked) {
                sendText(part.id, part.text)
                continue
              }

              state.pending += part.text
              if (!reasoningText) {
                state.prefixChecked = true
                sendText(part.id, state.pending)
                state.pending = ""
              } else if (state.pending.startsWith(reasoningText)) {
                const visibleText = state.pending.slice(reasoningText.length)
                if (visibleText) {
                  state.prefixChecked = true
                  sendText(part.id, visibleText)
                  state.pending = ""
                }
              } else if (!reasoningText.startsWith(state.pending)) {
                state.prefixChecked = true
                sendText(part.id, state.pending)
                state.pending = ""
              }
            } else if (part.type === "text-end") {
              const state = textStates.get(part.id)
              if (state && !state.prefixChecked && state.pending !== reasoningText) {
                sendText(part.id, state.pending)
              }
              closeBlock(part.id)
            } else if (part.type === "reasoning-delta") {
              reasoningText += part.text
            } else if (part.type === "tool-call" && !blocks.has(part.toolCallId)) {
              flushPendingText()
              closeAllBlocks()
              if (("invalid" in part && part.invalid) || !isObject(part.input)) {
                throw new Error(`Model returned invalid input for tool ${part.toolName}`)
              }
              const index = nextIndex++
              blocks.set(part.toolCallId, { index, kind: "tool", closed: false })
              send("content_block_start", {
                type: "content_block_start",
                index,
                content_block: {
                  type: "tool_use",
                  id: part.toolCallId,
                  name: part.toolName,
                  input: {},
                },
              })
              send("content_block_delta", {
                type: "content_block_delta",
                index,
                delta: {
                  type: "input_json_delta",
                  partial_json: JSON.stringify(part.input),
                },
              })
              closeBlock(part.toolCallId)
            } else if (part.type === "tool-error") {
              throw new Error(`Model returned an invalid tool call for ${part.toolName}`)
            } else if (part.type === "finish") {
              if (part.finishReason === "error") {
                throw new Error("Model generation failed")
              }
              closeAllBlocks()
              send("message_delta", {
                type: "message_delta",
                delta: {
                  stop_reason: stopReason(part.finishReason),
                  stop_sequence: null,
                },
                usage: anthropicUsage(part.totalUsage),
              })
              send("message_stop", { type: "message_stop" })
              finished = true
            } else if (part.type === "error") {
              throw part.error
            } else if (part.type === "abort") {
              throw new Error("Upstream request was aborted")
            }
          }

          if (!finished) {
            closeAllBlocks()
            send("message_delta", {
              type: "message_delta",
              delta: { stop_reason: "end_turn", stop_sequence: null },
              usage: { output_tokens: 0 },
            })
            send("message_stop", { type: "message_stop" })
          }
        } catch (error) {
          const status = upstreamErrorStatus(error)
          console.error(
            `[gateway] streaming error (${status}): ${upstreamErrorMessage(error)}`,
          )
          send("error", {
            type: "error",
            error: {
              type: anthropicErrorType(status),
              message: upstreamErrorMessage(error),
            },
          })
        } finally {
          clearInterval(ping)
          if (!cancelled) {
            try {
              controller.close()
            } catch {
              cancelled = true
            }
          }
          lifecycle.onClose?.()
        }
      })()
    },
    cancel() {
      cancelled = true
      lifecycle.onCancel?.()
    },
  })

  return new Response(stream, {
    headers: {
      "content-type": "text/event-stream",
      "cache-control": "no-cache, no-transform",
      connection: "keep-alive",
      "x-accel-buffering": "no",
    },
  })
}

function upstreamErrorMessage(error: unknown): string {
  if (!isObject(error)) return error instanceof Error ? error.message : String(error)

  if (typeof error.responseBody === "string") {
    try {
      const body: unknown = JSON.parse(error.responseBody)
      if (isObject(body) && isObject(body.error) && typeof body.error.message === "string") {
        return body.error.message
      }
    } catch {
      return error.responseBody
    }
  }

  return typeof error.message === "string" ? error.message : "OpenCode Zen request failed"
}

function upstreamErrorStatus(error: unknown): number {
  if (isObject(error) && typeof error.statusCode === "number") {
    return error.statusCode
  }
  return 502
}

function anthropicErrorType(status: number): string {
  if (status === 401) return "authentication_error"
  if (status === 403) return "permission_error"
  if (status === 404) return "not_found_error"
  if (status === 413) return "request_too_large"
  if (status === 429) return "rate_limit_error"
  if (status === 529) return "overloaded_error"
  return status >= 500 ? "api_error" : "invalid_request_error"
}

export async function handler(request: Request): Promise<Response> {
  const url = new URL(request.url)

  if ((url.pathname === "/" || url.pathname === "/health") && request.method === "GET") {
    return jsonResponse({ status: "ok" })
  }
  if (url.pathname === "/api/hello" && request.method === "HEAD") {
    return new Response(null, { status: 204 })
  }
  if (!url.pathname.startsWith("/v1/")) {
    return errorResponse("Not found", 404, "not_found_error")
  }
  if (!isAuthorized(request)) {
    return errorResponse("Invalid gateway credential", 401, "authentication_error")
  }
  if (url.pathname === "/v1/models" && request.method === "GET") {
    return jsonResponse({ data: getDiscoverableModels() })
  }
  if (url.pathname !== "/v1/messages" || request.method !== "POST") {
    return errorResponse("Not found", 404, "not_found_error")
  }

  try {
    let body: AnthropicRequest
    try {
      body = (await request.json()) as AnthropicRequest
    } catch {
      throw new RequestError("Request body must contain valid JSON")
    }
    if (!isObject(body)) throw new RequestError("Request body must be a JSON object")
    if (typeof body.model !== "string" || !body.model) {
      throw new RequestError("model must be a non-empty string")
    }

    const route = resolveModel(body.model)
    if (!route) {
      throw new RequestError(`Model ${body.model} is not available`, 404, "not_found_error")
    }

    if (body.stream !== undefined && typeof body.stream !== "boolean") {
      throw new RequestError("stream must be a boolean")
    }

    const {
      hasUserAttachments,
      hasToolResultAttachments,
      ...options
    } = generationOptions(body, route)
    if (
      (hasUserAttachments || hasToolResultAttachments) &&
      !route.supportsAttachments
    ) {
      throw new RequestError(`Model ${body.model} does not support attachments`)
    }
    if (hasToolResultAttachments && route.transport === "chat-completions") {
      throw new RequestError(
        `Model ${body.model} does not support attachments in tool results`,
      )
    }

    const startedAt = performance.now()
    console.info(`[gateway] ${body.model} -> ${route.upstreamModel}`)

    if (body.stream === true) {
      const abortController = new AbortController()
      const abortUpstream = () => abortController.abort(request.signal.reason)
      request.signal.addEventListener("abort", abortUpstream, { once: true })
      if (request.signal.aborted) abortUpstream()

      try {
        const result = streamText({
          ...options,
          abortSignal: abortController.signal,
          onError: () => {},
        })
        return streamingResponse(body.model, result, {
          onCancel: abortUpstream,
          onClose: () => request.signal.removeEventListener("abort", abortUpstream),
        })
      } catch (error) {
        request.signal.removeEventListener("abort", abortUpstream)
        throw error
      }
    }

    const result = await generateText({ ...options, abortSignal: request.signal })
    console.info(
      `[gateway] ${route.upstreamModel} completed in ${Math.round(performance.now() - startedAt)}ms`,
    )
    return jsonResponse(nonStreamingResponse(body.model, result))
  } catch (error) {
    if (error instanceof RequestError) {
      return errorResponse(error.message, error.status, error.type)
    }

    const status = upstreamErrorStatus(error)
    console.error(`[gateway] upstream error (${status}): ${upstreamErrorMessage(error)}`)
    return errorResponse(
      upstreamErrorMessage(error),
      status,
      anthropicErrorType(status),
    )
  }
}

if (import.meta.main) {
  Bun.serve({
    hostname: HOST,
    port: PORT,
    idleTimeout: 255,
    fetch: handler,
  })
  console.info(`[gateway] listening on http://${HOST}:${PORT}`)
  console.info(`[gateway] ${getDiscoverableModels().length} free models available`)
}
