/**
 * Injected Replicate seam for the offline preprocess pipeline (Lane E).
 *
 * Every submodule (transcribe / frameUnderstand / embed) takes a
 * `ReplicateRunner` by injection — production passes a thin wrapper around the
 * real `replicate` SDK, unit tests pass a fake that returns canned model output.
 * Nothing constructs a real client at import time, so the unit suite runs with
 * no `REPLICATE_API_TOKEN` and no network.
 *
 * We deliberately depend only on the one method we use (`run`) rather than the
 * whole `Replicate` class, so the mock surface stays tiny and stable.
 */
import Replicate from "replicate";

/** The slice of the Replicate SDK the pipeline actually calls. */
export interface ReplicateRunner {
  run(
    identifier: `${string}/${string}` | `${string}/${string}:${string}`,
    options: { input: object },
  ): Promise<unknown>;
}

/**
 * Production runner. Lazily constructs the real SDK — only call this from the
 * CLI / demo path where a token is present, never at module import.
 */
export function makeReplicateRunner(
  token: string | undefined = process.env.REPLICATE_API_TOKEN,
): ReplicateRunner {
  if (!token) {
    throw new Error("REPLICATE_API_TOKEN is required for the Replicate runner");
  }
  const client = new Replicate({ auth: token });
  return {
    run: (identifier, options) => client.run(identifier, options),
  };
}

/**
 * Test double. Pass an array of canned outputs (one per call, last repeats) or
 * a function of (identifier, input, callIndex). Records every call so tests can
 * assert request construction (model id + input payload).
 */
export interface ReplicateCall {
  identifier: string;
  input: object;
}

export class FakeReplicateRunner implements ReplicateRunner {
  private calls = 0;
  readonly seenCalls: ReplicateCall[] = [];

  constructor(
    private outputs:
      | unknown[]
      | ((identifier: string, input: object, call: number) => unknown),
  ) {}

  async run(
    identifier: `${string}/${string}` | `${string}/${string}:${string}`,
    options: { input: object },
  ): Promise<unknown> {
    this.seenCalls.push({ identifier, input: options.input });
    const i = this.calls++;
    if (typeof this.outputs === "function") {
      return this.outputs(identifier, options.input, i);
    }
    return this.outputs[Math.min(i, this.outputs.length - 1)];
  }
}
