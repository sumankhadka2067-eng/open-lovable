// ============================================================================
// PRODUCTION-READY AI CODE GENERATION ROUTE
// File: app/api/generate-ai-code-stream/route.ts
// ============================================================================
// 
// Features:
// - Gemini (Google AI Studio) integration
// - Groq (Llama-3/Mixtral) integration  
// - Dynamic provider switching
// - DuckDuckGo search for real-time grounding
// - Streaming responses with SSE
// - Smart edit mode with file analysis
// - Conversation history tracking
//
// Environment Variables Required (at least one):
// - GOOGLE_GENERATIVE_AI_API_KEY (from https://makersuite.google.com/app/apikey)
// - GROQ_API_KEY (from https://console.groq.com/keys)
//
// Installation:
// npm install ai @ai-sdk/google @ai-sdk/groq zod
//
// ============================================================================

import { NextRequest, NextResponse } from 'next/server';
import { createGoogleGenerativeAI } from '@ai-sdk/google';
import { createGroq } from '@ai-sdk/groq';
import { streamText, tool } from 'ai';
import { z } from 'zod';
import type { SandboxState } from '@/types/sandbox';
import { selectFilesForEdit, getFileContents, formatFilesForAI } from '@/lib/context-selector';
import { executeSearchPlan, formatSearchResultsForAI, selectTargetFile } from '@/lib/file-search-executor';
import { FileManifest } from '@/types/file-manifest';
import type { ConversationState, ConversationMessage, ConversationEdit } from '@/types/conversation';
import { appConfig } from '@/config/app.config';

// Force dynamic route to enable streaming
export const dynamic = 'force-dynamic';
export const maxDuration = 300; // 5 minutes max for streaming responses

// Initialize AI providers with proper error handling
const initializeProviders = () => {
  const geminiApiKey = process.env.GOOGLE_GENERATIVE_AI_API_KEY;
  const groqApiKey = process.env.GROQ_API_KEY;

  console.log('[AI Providers] Initialization:', {
    hasGeminiKey: !!geminiApiKey,
    hasGroqKey: !!groqApiKey,
    timestamp: new Date().toISOString()
  });

  const providers = {
    google: geminiApiKey ? createGoogleGenerativeAI({ apiKey: geminiApiKey }) : null,
    groq: groqApiKey ? createGroq({ apiKey: groqApiKey }) : null
  };

  if (!providers.google && !providers.groq) {
    throw new Error('At least one AI provider (Gemini or Groq) must be configured with valid API keys');
  }

  return providers;
};

// DuckDuckGo Search Tool using native fetch
const duckDuckGoSearchTool = tool({
  description: 'Search the web using DuckDuckGo for real-time information, current events, documentation, or any query requiring up-to-date data',
  parameters: z.object({
    query: z.string().describe('The search query to find relevant information'),
    maxResults: z.number().optional().default(5).describe('Maximum number of results to return (default: 5)')
  }),
  execute: async ({ query, maxResults = 5 }) => {
    try {
      console.log('[DuckDuckGo Search] Executing search:', { query, maxResults });
      
      // DuckDuckGo Instant Answer API
      const searchUrl = `https://api.duckduckgo.com/?q=${encodeURIComponent(query)}&format=json&no_html=1&skip_disambig=1`;
      
      const response = await fetch(searchUrl, {
        headers: {
          'User-Agent': 'Mozilla/5.0 (compatible; AI-Agent/1.0)'
        }
      });

      if (!response.ok) {
        throw new Error(`DuckDuckGo API error: ${response.status}`);
      }

      const data = await response.json();
      
      // Format results from DuckDuckGo response
      const results = [];
      
      // Add abstract if available
      if (data.Abstract) {
        results.push({
          title: data.Heading || 'Overview',
          snippet: data.Abstract,
          url: data.AbstractURL || '',
          source: data.AbstractSource || 'DuckDuckGo'
        });
      }

      // Add related topics
      if (data.RelatedTopics && Array.isArray(data.RelatedTopics)) {
        for (const topic of data.RelatedTopics.slice(0, maxResults - results.length)) {
          if (topic.Text && topic.FirstURL) {
            results.push({
              title: topic.Text.split(' - ')[0] || topic.Text,
              snippet: topic.Text,
              url: topic.FirstURL,
              source: 'DuckDuckGo'
            });
          }
        }
      }

      // If no results, try the HTML scraping approach as fallback
      if (results.length === 0) {
        const htmlUrl = `https://html.duckduckgo.com/html/?q=${encodeURIComponent(query)}`;
        console.log('[DuckDuckGo Search] No instant answers, attempting HTML search as fallback');
        
        return {
          success: false,
          query,
          results: [],
          message: 'No instant answers available. For comprehensive search, consider using a dedicated search API with authentication.'
        };
      }

      console.log('[DuckDuckGo Search] Results found:', results.length);
      
      return {
        success: true,
        query,
        results: results.slice(0, maxResults),
        timestamp: new Date().toISOString()
      };

    } catch (error) {
      console.error('[DuckDuckGo Search] Error:', error);
      return {
        success: false,
        query,
        error: error instanceof Error ? error.message : 'Unknown search error',
        results: []
      };
    }
  }
});

// Helper function to analyze user preferences from conversation history
function analyzeUserPreferences(messages: ConversationMessage[]): {
  commonPatterns: string[];
  preferredEditStyle: 'targeted' | 'comprehensive';
} {
  const userMessages = messages.filter(m => m.role === 'user');
  const patterns: string[] = [];
  
  let targetedEditCount = 0;
  let comprehensiveEditCount = 0;
  
  userMessages.forEach(msg => {
    const content = msg.content.toLowerCase();
    
    // Check for targeted edit patterns
    if (content.match(/\b(update|change|fix|modify|edit|remove|delete)\s+(\w+\s+)?(\w+)\b/)) {
      targetedEditCount++;
    }
    
    // Check for comprehensive edit patterns
    if (content.match(/\b(rebuild|recreate|redesign|overhaul|refactor)\b/)) {
      comprehensiveEditCount++;
    }
    
    // Extract common request patterns
    if (content.includes('hero')) patterns.push('hero section edits');
    if (content.includes('header')) patterns.push('header modifications');
    if (content.includes('color') || content.includes('style')) patterns.push('styling changes');
    if (content.includes('button')) patterns.push('button updates');
    if (content.includes('animation')) patterns.push('animation requests');
  });
  
  return {
    commonPatterns: [...new Set(patterns)].slice(0, 3),
    preferredEditStyle: targetedEditCount > comprehensiveEditCount ? 'targeted' : 'comprehensive'
  };
}

// Global state declarations
declare global {
  var sandboxState: SandboxState;
  var conversationState: ConversationState | null;
}

// Model configuration mapping
const MODEL_CONFIG = {
  // Gemini models (Google AI Studio)
  'gemini-2.0-flash-exp': { provider: 'google', model: 'gemini-2.0-flash-exp', maxTokens: 8192 },
  'gemini-1.5-pro': { provider: 'google', model: 'gemini-1.5-pro-002', maxTokens: 8192 },
  'gemini-1.5-flash': { provider: 'google', model: 'gemini-1.5-flash-002', maxTokens: 8192 },
  
  // Groq models (Llama-3/Mixtral)
  'llama-3.3-70b': { provider: 'groq', model: 'llama-3.3-70b-versatile', maxTokens: 8192 },
  'llama-3.1-70b': { provider: 'groq', model: 'llama-3.1-70b-versatile', maxTokens: 8192 },
  'mixtral-8x7b': { provider: 'groq', model: 'mixtral-8x7b-32768', maxTokens: 8192 },
} as const;

type ModelKey = keyof typeof MODEL_CONFIG;

export async function POST(request: NextRequest) {
  try {
    const { 
      prompt, 
      model = 'gemini-2.0-flash-exp', // Default to Gemini Flash
      provider, // Optional: 'gemini' | 'groq'
      context, 
      isEdit = false,
      enableSearch = true // Flag to enable/disable web search
    } = await request.json();
    
    console.log('[Route] Request received:', {
      promptLength: prompt?.length,
      model,
      provider,
      isEdit,
      enableSearch,
      sandboxId: context?.sandboxId,
      filesCount: context?.currentFiles ? Object.keys(context.currentFiles).length : 0,
      timestamp: new Date().toISOString()
    });
    
    // Validate prompt
    if (!prompt || typeof prompt !== 'string' || prompt.trim().length === 0) {
      return NextResponse.json({ 
        success: false, 
        error: 'Valid prompt is required' 
      }, { status: 400 });
    }

    // Initialize providers
    let providers;
    try {
      providers = initializeProviders();
    } catch (error) {
      console.error('[Route] Provider initialization failed:', error);
      return NextResponse.json({
        success: false,
        error: error instanceof Error ? error.message : 'Failed to initialize AI providers'
      }, { status: 500 });
    }

    // Determine which provider and model to use
    let selectedProvider: 'google' | 'groq';
    let selectedModel: string;

    if (provider) {
      // Explicit provider specified
      selectedProvider = provider as 'google' | 'groq';
      if (!providers[selectedProvider]) {
        return NextResponse.json({
          success: false,
          error: `Provider '${provider}' is not configured. Please set the appropriate API key.`
        }, { status: 400 });
      }
    } else if (model in MODEL_CONFIG) {
      // Model key provided, use its configured provider
      const config = MODEL_CONFIG[model as ModelKey];
      selectedProvider = config.provider;
      selectedModel = config.model;
    } else {
      // Fallback: use first available provider
      selectedProvider = providers.google ? 'google' : 'groq';
      selectedModel = model;
    }

    // Verify selected provider is available
    if (!providers[selectedProvider]) {
      const fallbackProvider = selectedProvider === 'google' ? 'groq' : 'google';
      if (providers[fallbackProvider]) {
        console.log(`[Route] Provider '${selectedProvider}' not available, falling back to '${fallbackProvider}'`);
        selectedProvider = fallbackProvider;
      } else {
        return NextResponse.json({
          success: false,
          error: `Selected provider '${selectedProvider}' is not configured`
        }, { status: 500 });
      }
    }

    // Get final model string
    if (!selectedModel && model in MODEL_CONFIG) {
      selectedModel = MODEL_CONFIG[model as ModelKey].model;
    } else if (!selectedModel) {
      selectedModel = model;
    }

    console.log('[Route] Using provider:', {
      provider: selectedProvider,
      model: selectedModel
    });

    // Initialize or update conversation state
    if (!global.conversationState) {
      global.conversationState = {
        conversationId: `conv-${Date.now()}`,
        startedAt: Date.now(),
        lastUpdated: Date.now(),
        context: {
          messages: [],
          edits: [],
          projectEvolution: { majorChanges: [] },
          userPreferences: {}
        }
      };
    }
    
    // Add user message to conversation history
    const userMessage: ConversationMessage = {
      id: `msg-${Date.now()}`,
      role: 'user',
      content: prompt,
      timestamp: Date.now(),
      metadata: {
        sandboxId: context?.sandboxId,
        model: selectedModel,
        provider: selectedProvider
      }
    };
    global.conversationState.context.messages.push(userMessage);
    
    // Maintain conversation history (keep last 15 messages)
    if (global.conversationState.context.messages.length > 20) {
      global.conversationState.context.messages = global.conversationState.context.messages.slice(-15);
      console.log('[Route] Trimmed conversation history');
    }
    
    // Maintain edit history (keep last 8 edits)
    if (global.conversationState.context.edits.length > 10) {
      global.conversationState.context.edits = global.conversationState.context.edits.slice(-8);
    }

    // Create streaming response
    const encoder = new TextEncoder();
    const stream = new TransformStream();
    const writer = stream.writable.getWriter();
    
    // Helper to send progress updates
    const sendProgress = async (data: any) => {
      const message = `data: ${JSON.stringify(data)}\n\n`;
      try {
        await writer.write(encoder.encode(message));
        // Send keepalive for certain event types
        if (data.type === 'stream' || data.type === 'conversation') {
          await writer.write(encoder.encode(': keepalive\n\n'));
        }
      } catch (error) {
        console.error('[Route] Stream write error:', error);
      }
    };
    
    // Background processing
    (async () => {
      try {
        await sendProgress({ type: 'status', message: 'Initializing AI...' });
        
        // Build edit context if in edit mode
        let editContext = null;
        let enhancedSystemPrompt = '';
        
        if (isEdit) {
          console.log('[Route] Edit mode - starting agentic workflow');
          const manifest: FileManifest | undefined = global.sandboxState?.fileCache?.manifest;
          
          if (manifest) {
            await sendProgress({ type: 'status', message: 'Analyzing codebase...' });
            
            try {
              // Execute search plan to find relevant files
              const searchResults = await executeSearchPlan(prompt, manifest);
              
              if (searchResults.results.length > 0) {
                await sendProgress({ 
                  type: 'status', 
                  message: `Found ${searchResults.results.length} relevant files` 
                });
                
                // Select target file for edit
                const targetFile = selectTargetFile(searchResults.results, prompt);
                const primaryFiles = [targetFile.path];
                
                // Get file contents
                const fileContents = await getFileContents(
                  primaryFiles, 
                  context?.currentFiles || {}
                );
                
                // Format for AI
                const formattedFiles = formatFilesForAI(fileContents);
                const searchContext = formatSearchResultsForAI(searchResults);
                
                editContext = {
                  primaryFiles,
                  editIntent: {
                    type: 'MODIFY' as const,
                    description: prompt,
                    confidence: targetFile.score
                  },
                  contextFiles: fileContents
                };
                
                // Build enhanced system prompt
                enhancedSystemPrompt = `You are an expert code editor. You have analyzed the codebase and identified the following relevant files for the user's request:

${searchContext}

Current file contents:
${formattedFiles}

User request: ${prompt}

Please provide targeted, precise edits to address the user's request. Focus on the identified files and maintain code quality.`;
                
                console.log('[Route] Edit context prepared:', {
                  primaryFiles: primaryFiles.length,
                  confidence: targetFile.score
                });
              }
            } catch (searchError) {
              console.error('[Route] Search/context building error:', searchError);
              await sendProgress({
                type: 'warning',
                message: 'Could not analyze codebase - proceeding with direct edit'
              });
            }
          }
        }
        
        // Prepare system prompt
        const systemPrompt = enhancedSystemPrompt || `You are an expert full-stack developer specializing in modern web development with Next.js, React, and TypeScript.

When generating code:
- Use TypeScript with proper types
- Follow Next.js App Router patterns
- Write clean, maintainable code
- Include proper error handling
- Add helpful comments for complex logic
- Use modern ES6+ syntax

When using tools:
- Use web search for current information, API documentation, or real-time data
- Provide accurate, up-to-date information

Format your response with:
1. Brief explanation of changes
2. Complete code in <file path="...">...</file> tags
3. List any required packages for installation`;

        // Prepare messages
        const messages = [
          { role: 'system' as const, content: systemPrompt },
          { role: 'user' as const, content: prompt }
        ];

        // Add conversation context if available
        if (global.conversationState && global.conversationState.context.messages.length > 1) {
          const recentMessages = global.conversationState.context.messages
            .slice(-5) // Last 5 messages for context
            .filter(m => m.id !== userMessage.id) // Exclude current message
            .map(m => ({
              role: m.role as 'user' | 'assistant',
              content: m.content
            }));
          
          if (recentMessages.length > 0) {
            messages.splice(1, 0, ...recentMessages);
          }
        }

        await sendProgress({ type: 'status', message: 'Generating code...' });

        // Get the appropriate client
        const client = selectedProvider === 'google' ? providers.google! : providers.groq!;
        
        // Configure tools
        const tools: any = {};
        if (enableSearch) {
          tools.duckduckgo_search = duckDuckGoSearchTool;
        }

        // Stream the AI response
        const result = await streamText({
          model: client(selectedModel),
          messages,
          tools: Object.keys(tools).length > 0 ? tools : undefined,
          temperature: 0.7,
          maxTokens: MODEL_CONFIG[model as ModelKey]?.maxTokens || 8192,
          onFinish: async ({ text, toolCalls, toolResults }) => {
            if (toolCalls && toolCalls.length > 0) {
              console.log('[Route] Tool calls executed:', toolCalls.length);
            }
          }
        });

        // Stream the response
        let generatedCode = '';
        let explanation = '';
        let isInCodeBlock = false;

        for await (const chunk of result.textStream) {
          generatedCode += chunk;
          
          // Send progressive updates
          await sendProgress({
            type: 'stream',
            content: chunk
          });
        }

        // Extract explanation and code sections
        const explanationMatch = generatedCode.match(/^([\s\S]*?)(?=<file|$)/);
        if (explanationMatch) {
          explanation = explanationMatch[1].trim();
        }

        // Parse files
        const fileMatches = Array.from(generatedCode.matchAll(/<file path="([^"]+)">([\s\S]*?)<\/file>/g));
        const files = fileMatches.map(match => ({
          path: match[1],
          content: match[2].trim()
        }));

        // Detect packages from imports
        const packagesToInstall: string[] = [];
        const importRegex = /(?:import|require)\s*\(?['"]([^'"]+)['"]\)?/g;
        
        for (const file of files) {
          const matches = Array.from(file.content.matchAll(importRegex));
          for (const match of matches) {
            const pkg = match[1];
            // Skip relative imports and node built-ins
            if (!pkg.startsWith('.') && !pkg.startsWith('/') && 
                !['fs', 'path', 'http', 'https', 'crypto', 'os', 'util', 'events'].includes(pkg)) {
              const pkgName = pkg.startsWith('@') ? pkg.split('/').slice(0, 2).join('/') : pkg.split('/')[0];
              if (!packagesToInstall.includes(pkgName)) {
                packagesToInstall.push(pkgName);
              }
            }
          }
        }

        console.log('[Route] Generation complete:', {
          filesGenerated: files.length,
          packagesDetected: packagesToInstall.length,
          explanationLength: explanation.length
        });

        // Send completion
        await sendProgress({ 
          type: 'complete', 
          generatedCode,
          explanation: explanation || 'Code generated successfully',
          files: files.length,
          model: selectedModel,
          provider: selectedProvider,
          packagesToInstall: packagesToInstall.length > 0 ? packagesToInstall : undefined
        });
        
        // Track edit in conversation
        if (isEdit && editContext && global.conversationState) {
          const editRecord: ConversationEdit = {
            timestamp: Date.now(),
            userRequest: prompt,
            editType: editContext.editIntent.type,
            targetFiles: editContext.primaryFiles,
            confidence: editContext.editIntent.confidence,
            outcome: 'success'
          };
          
          global.conversationState.context.edits.push(editRecord);
          
          // Track major changes
          if (editContext.editIntent.type === 'ADD_FEATURE' || files.length > 3) {
            global.conversationState.context.projectEvolution.majorChanges.push({
              timestamp: Date.now(),
              description: editContext.editIntent.description,
              filesAffected: editContext.primaryFiles
            });
          }
          
          global.conversationState.lastUpdated = Date.now();
        }
        
      } catch (error) {
        console.error('[Route] Processing error:', error);
        await sendProgress({ 
          type: 'error', 
          error: error instanceof Error ? error.message : 'Unknown error occurred'
        });
      } finally {
        await writer.close();
      }
    })();
    
    // Return streaming response with proper headers
    return new Response(stream.readable, {
      headers: {
        'Content-Type': 'text/event-stream',
        'Cache-Control': 'no-cache, no-transform',
        'Connection': 'keep-alive',
        'Transfer-Encoding': 'chunked',
        'X-Accel-Buffering': 'no', // Disable nginx buffering
        'Access-Control-Allow-Origin': '*',
        'Access-Control-Allow-Methods': 'POST, OPTIONS',
        'Access-Control-Allow-Headers': 'Content-Type, Authorization',
      },
    });
    
  } catch (error) {
    console.error('[Route] Fatal error:', error);
    return NextResponse.json({ 
      success: false, 
      error: error instanceof Error ? error.message : 'Internal server error'
    }, { status: 500 });
  }
}

// Handle OPTIONS for CORS
export async function OPTIONS(request: NextRequest) {
  return new NextResponse(null, {
    status: 200,
    headers: {
      'Access-Control-Allow-Origin': '*',
      'Access-Control-Allow-Methods': 'POST, OPTIONS',
      'Access-Control-Allow-Headers': 'Content-Type, Authorization',
    },
  });
}
