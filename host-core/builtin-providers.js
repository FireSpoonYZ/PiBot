import { openaiProvider } from '@earendil-works/pi-ai/providers/openai';
import { anthropicProvider } from '@earendil-works/pi-ai/providers/anthropic';
import { googleProvider } from '@earendil-works/pi-ai/providers/google';
import { deepseekProvider } from '@earendil-works/pi-ai/providers/deepseek';
import { groqProvider } from '@earendil-works/pi-ai/providers/groq';
import { xaiProvider } from '@earendil-works/pi-ai/providers/xai';
import { openrouterProvider } from '@earendil-works/pi-ai/providers/openrouter';
import { moonshotaiProvider } from '@earendil-works/pi-ai/providers/moonshotai';
import { minimaxProvider } from '@earendil-works/pi-ai/providers/minimax';
import { zaiProvider } from '@earendil-works/pi-ai/providers/zai';

export function builtinProviders() {
  return [openaiProvider, anthropicProvider, googleProvider, deepseekProvider,
    groqProvider, xaiProvider, openrouterProvider, moonshotaiProvider, minimaxProvider, zaiProvider]
    .map(factory => {
      const provider = factory();
      const models = provider.getModels();
      return { id: provider.id, name: provider.name, baseUrl: provider.baseUrl,
        api: provider.id === 'openrouter' ? 'openai-completions' : models[0].api, models };
    });
}
