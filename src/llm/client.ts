/**
 * Shared LLM client seam for the builder (Lane D) and verifier (Lane C).
 *
 * Both modules take an `LlmClient` by injection — production passes
 * `AnthropicClient`, tests pass `FakeLlmClient`. Nothing constructs a real
 * client at import time, so unit suites run with no API key.
 */
import Anthropic from "@anthropic-ai/sdk";

export interface LlmImage {
  mediaType: "image/jpeg" | "image/png";
  /** Base64-encoded image bytes (no data: prefix). */
  dataBase64: string;
}

export interface LlmCompleteOptions {
  system: string;
  user: string;
  /** Optional images for vision (verifier keyframes). */
  images?: LlmImage[];
  maxTokens?: number;
}

export interface LlmClient {
  complete(opts: LlmCompleteOptions): Promise<string>;
}

export const DEFAULT_MODEL = "claude-opus-4-8";

export class AnthropicClient implements LlmClient {
  private client: Anthropic;
  constructor(
    apiKey: string | undefined = process.env.ANTHROPIC_API_KEY,
    private model: string = DEFAULT_MODEL,
  ) {
    if (!apiKey) throw new Error("ANTHROPIC_API_KEY is required for AnthropicClient");
    this.client = new Anthropic({ apiKey });
  }

  async complete(opts: LlmCompleteOptions): Promise<string> {
    const content: Anthropic.ContentBlockParam[] = [];
    for (const img of opts.images ?? []) {
      content.push({
        type: "image",
        source: { type: "base64", media_type: img.mediaType, data: img.dataBase64 },
      });
    }
    content.push({ type: "text", text: opts.user });

    const res = await this.client.messages.create({
      model: this.model,
      max_tokens: opts.maxTokens ?? 1024,
      system: opts.system,
      messages: [{ role: "user", content }],
    });
    return res.content
      .filter((b): b is Anthropic.TextBlock => b.type === "text")
      .map((b) => b.text)
      .join("\n");
  }
}

/**
 * Test double. Pass an array of canned responses (one per call, last repeats)
 * or a function of (opts, callIndex). Records `lastOptions` so tests can assert
 * what the prompt contained (e.g. the verifier independence check).
 */
export class FakeLlmClient implements LlmClient {
  private calls = 0;
  lastOptions?: LlmCompleteOptions;
  readonly seenOptions: LlmCompleteOptions[] = [];

  constructor(
    private responses: string[] | ((opts: LlmCompleteOptions, call: number) => string),
  ) {}

  async complete(opts: LlmCompleteOptions): Promise<string> {
    this.lastOptions = opts;
    this.seenOptions.push(opts);
    const i = this.calls++;
    if (typeof this.responses === "function") return this.responses(opts, i);
    return this.responses[Math.min(i, this.responses.length - 1)] ?? "";
  }
}
