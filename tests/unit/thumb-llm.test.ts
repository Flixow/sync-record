import { describe, expect, it } from "vitest";
import { llmThumbnailHooks, type LlmClient, type LlmPrompt } from "../../src/server/post/llm.js";

/** A model that answers every prompt with `answer` and keeps what it was asked. */
function model(answer: unknown): { client: LlmClient; prompts: LlmPrompt[] } {
  const prompts: LlmPrompt[] = [];
  return {
    prompts,
    client: {
      enabled: true,
      rank: (prompt) => {
        prompts.push(prompt);
        return Promise.resolve(answer);
      },
    },
  };
}

const input = { sentenceAroundFrame: "The garden needs water every morning. Why do the tomatoes dry out so fast?", title: "Garden talk", language: "en" } as const;

describe("headline ideas from the language model", () => {
  it("asks once, with text only, and keeps the usable answers", async () => {
    const { client, prompts } = model({ hooks: ["Why tomatoes dry out", "**Water at dawn** 🌱", "Garden talk", "Why tomatoes dry out", "One two three four five six", "A fifth idea"] });
    const hooks = await llmThumbnailHooks(client, input);
    expect(hooks).toEqual(["Why tomatoes dry out", "Water at dawn", "One two three four five"]);
    expect(prompts).toHaveLength(1);
    const prompt = prompts[0] as LlmPrompt;
    expect(prompt.user).toContain("Garden talk");
    expect(prompt.user).toContain("Why do the tomatoes dry out so fast?");
    expect(prompt.system).toContain("at most 5 words");
    expect(prompt.system).toContain("English");
    expect(Object.keys(prompt).sort()).toEqual(["effort", "maxTokens", "system", "user"]);
    await llmThumbnailHooks(client, { ...input, language: "pl" });
    expect(prompts[1]?.system).toContain("Polish");
  });

  it("sends a bounded amount of text", async () => {
    const { client, prompts } = model({ hooks: ["Something new"] });
    await llmThumbnailHooks(client, { sentenceAroundFrame: "word ".repeat(100_000), title: "t".repeat(10_000), language: "en" });
    expect((prompts[0] as LlmPrompt).user.length).toBeLessThan(1000);
  });

  it("is null when the model is off or its answer is of no use, and never throws", async () => {
    const off: LlmClient = { enabled: false, rank: () => Promise.reject(new Error("must not be called")) };
    expect(await llmThumbnailHooks(off, input)).toBeNull();
    for (const answer of [null, "hooks", { hooks: "Why tomatoes dry out" }, { hooks: [] }, { hooks: [5, null, "  "] }, { hooks: ["Garden talk"] }, { other: ["Why"] }]) {
      expect(await llmThumbnailHooks(model(answer).client, input), JSON.stringify(answer)).toBeNull();
    }
    const throwing: LlmClient = { enabled: true, rank: () => Promise.reject(new Error("boom")) };
    expect(await llmThumbnailHooks(throwing, input)).toBeNull();
  });
});
