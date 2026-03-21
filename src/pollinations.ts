export interface ChatMessage {
  role: "system" | "user" | "assistant";
  content: string;
}

export interface PollinationsOptions {
  apiKey: string;
  model: string;
  temperature: number;
}

interface ChatCompletionResponse {
  id: string;
  choices: Array<{
    message: {
      content: string | null;
      role: string;
    };
    finish_reason: string | null;
    index: number;
  }>;
  model: string;
  usage?: {
    prompt_tokens?: number;
    completion_tokens?: number;
    total_tokens?: number;
  };
}

export async function chat(
  messages: ChatMessage[],
  options: PollinationsOptions
): Promise<string> {
  const response = await fetch(
    "https://gen.pollinations.ai/v1/chat/completions",
    {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${options.apiKey}`,
      },
      body: JSON.stringify({
        model: options.model,
        messages,
        temperature: options.temperature,
      }),
    }
  );

  if (response.status === 401) {
    throw new Error(
      "Invalid Pollinations API key. Get one at https://enter.pollinations.ai"
    );
  }

  if (response.status === 402) {
    throw new Error(
      "Insufficient pollen balance. Top up at https://enter.pollinations.ai"
    );
  }

  if (response.status === 403) {
    throw new Error(
      "API key does not have permission for this model. Check your key settings."
    );
  }

  if (!response.ok) {
    const text = await response.text();
    throw new Error(`Pollinations API error ${response.status}: ${text}`);
  }

  const data = (await response.json()) as any;

  if (!data.choices || data.choices.length === 0) {
    throw new Error("Pollinations API returned no choices");
  }

  const content = data.choices[0].message.content;
  if (!content || content.toString().trim().length === 0) {
    throw new Error("Pollinations API returned empty content");
  }

  return content.toString().trim();
}

export async function chatWithRetry(
  messages: ChatMessage[],
  options: PollinationsOptions,
  maxRetries: number = 3
): Promise<string> {
  let lastError: Error | null = null;

  for (let attempt = 1; attempt <= maxRetries; attempt++) {
    try {
      return await chat(messages, options);
    } catch (error) {
      lastError = error instanceof Error ? error : new Error(String(error));

      const message = lastError.message.toLowerCase();
      if (
        message.includes("invalid") ||
        message.includes("insufficient") ||
        message.includes("permission")
      ) {
        throw lastError;
      }

      if (attempt < maxRetries) {
        const delay = attempt * 5000;
        await new Promise((resolve) => setTimeout(resolve, delay));
      }
    }
  }

  throw lastError;
}