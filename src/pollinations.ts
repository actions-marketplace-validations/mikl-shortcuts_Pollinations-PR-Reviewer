export interface ChatMessage {
  role: "system" | "user" | "assistant";
  content: string;
}

export interface PollinationsOptions {
  apiKey: string;
  model: string;
  temperature: number;
}

export async function chat(
  messages: ChatMessage[],
  options: PollinationsOptions,
  signal?: AbortSignal
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
      signal,
    }
  );

  if (response.status === 401) {
    throw new PermanentError(
      "Invalid Pollinations API key. Get one at https://enter.pollinations.ai"
    );
  }

  if (response.status === 402) {
    throw new PermanentError(
      "Insufficient pollen balance. Top up at https://enter.pollinations.ai"
    );
  }

  if (response.status === 403) {
    throw new PermanentError(
      "API key lacks permission for this model. Check your key settings."
    );
  }

  if (response.status === 429) {
    throw new TransientError("Rate limited by Pollinations API");
  }

  if (!response.ok) {
    const text = await response.text().catch(() => "unknown");
    throw new TransientError(
      `Pollinations API error ${response.status}: ${text}`
    );
  }

  const data = (await response.json()) as any;

  if (!data.choices?.length) {
    throw new TransientError("Pollinations API returned no choices");
  }

  const content = data.choices[0]?.message?.content;
  if (!content || String(content).trim().length === 0) {
    throw new TransientError("Pollinations API returned empty content");
  }

  return String(content).trim();
}

export async function chatWithRetry(
  messages: ChatMessage[],
  options: PollinationsOptions,
  maxRetries: number = 3
): Promise<string> {
  let lastError: Error | null = null;

  for (let attempt = 1; attempt <= maxRetries; attempt++) {
    try {
      const controller = new AbortController();
      const timeout = setTimeout(() => controller.abort(), 120_000);

      try {
        return await chat(messages, options, controller.signal);
      } finally {
        clearTimeout(timeout);
      }
    } catch (error) {
      lastError = error instanceof Error ? error : new Error(String(error));

      if (error instanceof PermanentError) {
        throw error;
      }

      if (attempt < maxRetries) {
        const delay = Math.min(attempt * 5000, 30_000);
        await new Promise((resolve) => setTimeout(resolve, delay));
      }
    }
  }

  throw lastError;
}

export class PermanentError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "PermanentError";
  }
}

export class TransientError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "TransientError";
  }
}