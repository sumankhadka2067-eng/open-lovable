import { createGroq } from '@ai-sdk/groq';
import { createGoogleGenerativeAI } from '@ai-sdk/google';
import { createOpenAI } from '@ai-sdk/openai';
import { generateText } from 'ai';

// Define supported provider types
export type ProviderType = 'groq' | 'google' | 'openrouter' | 'custom-render';

interface AIResponse {
  content: string;
  error?: string;
}

/**
 * Main function to route prompts to different AI providers.
 * This handles Groq, Gemini, DeepSeek (via OpenRouter), and your Render API.
 */
export async function getAICompletion(
  prompt: string,
  provider: ProviderType
): Promise<AIResponse> {
  try {
    // 1. Logic for Custom Render API (DuckDuckGo)
    if (provider === 'custom-render') {
      const renderBase =
        process.env.NEXT_PUBLIC_RENDER_URL ||
        'https://ai-coding-app-946t.onrender.com/generate';
      const response = await fetch(
        `${renderBase}?idea=${encodeURIComponent(prompt)}`
      );

      if (!response.ok) {
        throw new Error(`Render API failed with status ${response.status}`);
      }

      const data = await response.json();
      return { content: data.raw_output || 'No output generated' };
    }

    // 2. Logic for Standard Providers using Vercel AI SDK
    let model;

    switch (provider) {
      case 'groq':
        const groqClient = createGroq({
          apiKey: process.env.GROQ_API_KEY || '',
        });
        model = groqClient('llama-3.3-70b-versatile');
        break;

      case 'google':
        const googleClient = createGoogleGenerativeAI({
          apiKey: process.env.GEMINI_API_KEY || '',
        });
        model = googleClient('gemini-1.5-pro');
        break;

      case 'openrouter':
        const openrouterClient = createOpenAI({
          apiKey: process.env.OPENROUTER_API_KEY || '',
          baseURL: 'https://openrouter.ai/api/v1',
        });
        model = openrouterClient('deepseek/deepseek-chat');
        break;

      default:
        throw new Error('Unsupported AI provider selected');
    }

    // Generate text using the selected model
    const result = await generateText({
      model,
      prompt,
    });

    return { content: result.text };
  } catch (err: any) {
    console.error('AI Provider Error:', err.message);
    return { content: '', error: err.message || 'Unknown error occurred' };
  }
}
