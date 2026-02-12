// ============================================================================
// PRODUCTION-READY FILE APPLY ROUTE
// File: app/api/apply-ai-code-stream/route.ts
// ============================================================================
//
// Purpose: Apply AI-generated code changes to the project file system
// 
// Features:
// - Secure path validation (prevents path traversal attacks)
// - Protected files (.env, .git, node_modules, etc.)
// - Automatic directory creation
// - File overwrite capability
// - Streaming progress updates
// - Zod validation
// - Comprehensive error handling
//
// Security:
// - Path traversal prevention
// - Sensitive file protection
// - Input validation
// - Relative path enforcement
//
// No external dependencies beyond Next.js, zod, and Node.js built-ins
//
// ============================================================================

import { NextRequest, NextResponse } from 'next/server';
import { z } from 'zod';
import { promises as fs } from 'fs';
import path from 'path';

// Force dynamic route
export const dynamic = 'force-dynamic';
export const maxDuration = 300;

// ============================================================================
// VALIDATION SCHEMAS
// ============================================================================

const FileSchema = z.object({
  path: z.string()
    .min(1, 'File path cannot be empty')
    .max(500, 'File path too long')
    .refine(
      (p) => !p.includes('..'),
      'Path traversal detected: ".." not allowed'
    )
    .refine(
      (p) => !path.isAbsolute(p),
      'Absolute paths not allowed'
    )
    .refine(
      (p) => {
        const normalized = path.normalize(p);
        return normalized === p || normalized === `./${p}` || normalized === p.replace(/^\.\//, '');
      },
      'Invalid path format'
    ),
  content: z.string()
});

const ApplyCodeRequestSchema = z.object({
  files: z.array(FileSchema)
    .min(1, 'At least one file is required')
    .max(100, 'Too many files in single request'),
  generatedCode: z.string().optional(), // Optional: full AI response for parsing
  packages: z.array(z.string()).optional(), // Optional: packages to track
});

type ApplyCodeRequest = z.infer<typeof ApplyCodeRequestSchema>;
type FileToApply = z.infer<typeof FileSchema>;

// ============================================================================
// SECURITY CONFIGURATION
// ============================================================================

const SECURITY_CONFIG = {
  // Protected file patterns (cannot be modified)
  protectedFiles: [
    '.env',
    '.env.local',
    '.env.development',
    '.env.production',
    '.env.test',
    '.git',
    '.gitignore',
    'package-lock.json',
    'yarn.lock',
    'pnpm-lock.yaml',
  ],

  // Protected directories (cannot write into)
  protectedDirectories: [
    '.git',
    'node_modules',
    '.next',
    'dist',
    'build',
    '.vercel',
    '.cache',
  ],

  // Allowed file extensions
  allowedExtensions: [
    '.js', '.jsx', '.ts', '.tsx',
    '.json', '.html', '.css', '.scss', '.sass',
    '.md', '.mdx', '.txt',
    '.svg', '.png', '.jpg', '.jpeg', '.gif', '.webp',
    '.env.example', '.gitignore.example',
  ],

  // Project root (where files can be written)
  // In production, this should be configured properly
  projectRoot: process.cwd(),
};

// ============================================================================
// SECURITY UTILITIES
// ============================================================================

/**
 * Validates that a file path is safe to write to
 */
function isPathSafe(filePath: string): { safe: boolean; reason?: string } {
  // Normalize the path
  const normalized = path.normalize(filePath);

  // Check for path traversal
  if (normalized.includes('..')) {
    return { safe: false, reason: 'Path traversal detected' };
  }

  // Check for absolute paths
  if (path.isAbsolute(normalized)) {
    return { safe: false, reason: 'Absolute paths not allowed' };
  }

  // Check if path tries to escape project root
  const resolvedPath = path.resolve(SECURITY_CONFIG.projectRoot, normalized);
  if (!resolvedPath.startsWith(SECURITY_CONFIG.projectRoot)) {
    return { safe: false, reason: 'Path escapes project root' };
  }

  // Check protected files
  const fileName = path.basename(normalized);
  if (SECURITY_CONFIG.protectedFiles.includes(fileName)) {
    return { safe: false, reason: `Protected file: ${fileName}` };
  }

  // Check protected directories
  const pathSegments = normalized.split(path.sep);
  for (const segment of pathSegments) {
    if (SECURITY_CONFIG.protectedDirectories.includes(segment)) {
      return { safe: false, reason: `Protected directory: ${segment}` };
    }
  }

  // Check file extension
  const ext = path.extname(normalized);
  const hasValidExtension = SECURITY_CONFIG.allowedExtensions.some(allowed => 
    normalized.endsWith(allowed)
  );
  
  if (!hasValidExtension && ext) {
    return { safe: false, reason: `File extension not allowed: ${ext}` };
  }

  return { safe: true };
}

/**
 * Sanitize file content (optional - can be enabled for additional security)
 */
function sanitizeContent(content: string, filePath: string): string {
  // For now, we trust the AI-generated content
  // In production, you might want to add additional sanitization:
  // - Remove suspicious code patterns
  // - Validate syntax
  // - Check for malicious patterns
  
  return content;
}

/**
 * Normalize file path for consistent handling
 */
function normalizeFilePath(filePath: string): string {
  // Remove leading slashes
  let normalized = filePath.replace(/^\/+/, '');
  
  // Ensure proper directory structure
  // If path doesn't start with src/, public/, or common config files, add src/
  const configFiles = [
    'package.json',
    'tsconfig.json',
    'next.config.js',
    'next.config.mjs',
    'tailwind.config.js',
    'tailwind.config.ts',
    'postcss.config.js',
    'README.md',
  ];

  const fileName = path.basename(normalized);
  const startsWithValidDir = 
    normalized.startsWith('src/') ||
    normalized.startsWith('public/') ||
    normalized.startsWith('app/') ||
    normalized.startsWith('pages/') ||
    normalized.startsWith('components/') ||
    normalized.startsWith('lib/') ||
    normalized.startsWith('styles/') ||
    normalized.startsWith('utils/') ||
    configFiles.includes(fileName);

  if (!startsWithValidDir && !configFiles.includes(fileName)) {
    normalized = `src/${normalized}`;
  }

  return normalized;
}

// ============================================================================
// FILE OPERATIONS
// ============================================================================

/**
 * Ensure directory exists, create if needed
 */
async function ensureDirectory(filePath: string): Promise<void> {
  const dir = path.dirname(filePath);
  const absoluteDir = path.resolve(SECURITY_CONFIG.projectRoot, dir);
  
  try {
    await fs.access(absoluteDir);
  } catch {
    // Directory doesn't exist, create it
    await fs.mkdir(absoluteDir, { recursive: true });
  }
}

/**
 * Check if file exists
 */
async function fileExists(filePath: string): Promise<boolean> {
  const absolutePath = path.resolve(SECURITY_CONFIG.projectRoot, filePath);
  try {
    await fs.access(absolutePath);
    return true;
  } catch {
    return false;
  }
}

/**
 * Write file to disk
 */
async function writeFile(filePath: string, content: string): Promise<void> {
  const absolutePath = path.resolve(SECURITY_CONFIG.projectRoot, filePath);
  await fs.writeFile(absolutePath, content, 'utf-8');
}

/**
 * Read file from disk
 */
async function readFile(filePath: string): Promise<string> {
  const absolutePath = path.resolve(SECURITY_CONFIG.projectRoot, filePath);
  return await fs.readFile(absolutePath, 'utf-8');
}

// ============================================================================
// PARSING UTILITIES
// ============================================================================

/**
 * Parse AI-generated code to extract files
 * Handles various formats: <file>, markdown code blocks, etc.
 */
function parseAIGeneratedCode(generatedCode: string): FileToApply[] {
  const files: FileToApply[] = [];
  const fileMap = new Map<string, string>();

  // Parse <file path="...">...</file> format
  const fileTagRegex = /<file\s+path="([^"]+)">([\s\S]*?)<\/file>/g;
  let match;

  while ((match = fileTagRegex.exec(generatedCode)) !== null) {
    const filePath = match[1];
    const content = match[2].trim();
    
    // Keep the longest version if duplicate
    if (!fileMap.has(filePath) || content.length > (fileMap.get(filePath)?.length || 0)) {
      fileMap.set(filePath, content);
    }
  }

  // Parse markdown code blocks with file paths
  // ```typescript path="src/app/page.tsx"
  const markdownRegex = /```(?:\w+)?\s*(?:path="([^"]+)")?\n([\s\S]*?)```/g;
  while ((match = markdownRegex.exec(generatedCode)) !== null) {
    if (match[1]) { // Only if path is specified
      const filePath = match[1];
      const content = match[2].trim();
      
      if (!fileMap.has(filePath) || content.length > (fileMap.get(filePath)?.length || 0)) {
        fileMap.set(filePath, content);
      }
    }
  }

  // Convert map to array
  for (const [path, content] of fileMap.entries()) {
    files.push({ path, content });
  }

  return files;
}

/**
 * Extract package names from import statements
 */
function extractPackages(files: FileToApply[]): string[] {
  const packages = new Set<string>();
  const importRegex = /(?:import|require)\s*\(?['"]([^'"]+)['"]\)?/g;

  for (const file of files) {
    let match;
    while ((match = importRegex.exec(file.content)) !== null) {
      const importPath = match[1];
      
      // Skip relative imports, built-ins, and local imports
      if (
        importPath.startsWith('.') ||
        importPath.startsWith('/') ||
        importPath.startsWith('@/') ||
        ['react', 'react-dom', 'next'].includes(importPath)
      ) {
        continue;
      }

      // Extract package name (handle scoped packages)
      const packageName = importPath.startsWith('@')
        ? importPath.split('/').slice(0, 2).join('/')
        : importPath.split('/')[0];

      packages.add(packageName);
    }
  }

  return Array.from(packages);
}

// ============================================================================
// STREAMING UTILITIES
// ============================================================================

interface ProgressMessage {
  type: 'status' | 'file-progress' | 'file-complete' | 'file-error' | 'complete' | 'error';
  message?: string;
  fileName?: string;
  action?: string;
  current?: number;
  total?: number;
  error?: string;
  results?: ApplyResults;
}

interface ApplyResults {
  filesCreated: string[];
  filesUpdated: string[];
  filesSkipped: string[];
  errors: string[];
  packages: string[];
}

/**
 * Create SSE message format
 */
function createSSEMessage(data: ProgressMessage): string {
  return `data: ${JSON.stringify(data)}\n\n`;
}

// ============================================================================
// MAIN ROUTE HANDLER
// ============================================================================

export async function POST(request: NextRequest) {
  const encoder = new TextEncoder();
  const stream = new TransformStream();
  const writer = stream.writable.getWriter();

  // Helper to send progress updates
  const sendProgress = async (data: ProgressMessage) => {
    try {
      await writer.write(encoder.encode(createSSEMessage(data)));
    } catch (error) {
      console.error('[Apply Code] Stream write error:', error);
    }
  };

  // Start background processing
  (async () => {
    try {
      // Parse request body
      let body: any;
      try {
        body = await request.json();
      } catch (parseError) {
        await sendProgress({
          type: 'error',
          error: 'Invalid JSON in request body'
        });
        await writer.close();
        return;
      }

      // If generatedCode is provided, parse it to extract files
      if (body.generatedCode && !body.files) {
        body.files = parseAIGeneratedCode(body.generatedCode);
      }

      // Validate request
      let validatedData: ApplyCodeRequest;
      try {
        validatedData = ApplyCodeRequestSchema.parse(body);
      } catch (validationError) {
        if (validationError instanceof z.ZodError) {
          await sendProgress({
            type: 'error',
            error: `Validation failed: ${validationError.errors.map(e => e.message).join(', ')}`
          });
        } else {
          await sendProgress({
            type: 'error',
            error: 'Request validation failed'
          });
        }
        await writer.close();
        return;
      }

      await sendProgress({
        type: 'status',
        message: `Processing ${validatedData.files.length} files...`
      });

      // Initialize results
      const results: ApplyResults = {
        filesCreated: [],
        filesUpdated: [],
        filesSkipped: [],
        errors: [],
        packages: body.packages || extractPackages(validatedData.files),
      };

      // Process each file
      for (let i = 0; i < validatedData.files.length; i++) {
        const file = validatedData.files[i];
        const currentIndex = i + 1;

        try {
          // Normalize file path
          const normalizedPath = normalizeFilePath(file.path);

          await sendProgress({
            type: 'file-progress',
            current: currentIndex,
            total: validatedData.files.length,
            fileName: normalizedPath,
            action: 'validating'
          });

          // Validate path safety
          const pathCheck = isPathSafe(normalizedPath);
          if (!pathCheck.safe) {
            results.errors.push(`${normalizedPath}: ${pathCheck.reason}`);
            await sendProgress({
              type: 'file-error',
              fileName: normalizedPath,
              error: pathCheck.reason || 'Path validation failed'
            });
            continue;
          }

          // Check if file exists (for tracking creates vs updates)
          const exists = await fileExists(normalizedPath);

          await sendProgress({
            type: 'file-progress',
            current: currentIndex,
            total: validatedData.files.length,
            fileName: normalizedPath,
            action: exists ? 'updating' : 'creating'
          });

          // Sanitize content (optional)
          const sanitizedContent = sanitizeContent(file.content, normalizedPath);

          // Ensure directory exists
          await ensureDirectory(normalizedPath);

          // Write file
          await writeFile(normalizedPath, sanitizedContent);

          // Track result
          if (exists) {
            results.filesUpdated.push(normalizedPath);
          } else {
            results.filesCreated.push(normalizedPath);
          }

          await sendProgress({
            type: 'file-complete',
            fileName: normalizedPath,
            action: exists ? 'updated' : 'created'
          });

        } catch (error) {
          const errorMessage = error instanceof Error ? error.message : 'Unknown error';
          results.errors.push(`${file.path}: ${errorMessage}`);
          
          await sendProgress({
            type: 'file-error',
            fileName: file.path,
            error: errorMessage
          });
        }
      }

      // Send completion
      const totalSuccess = results.filesCreated.length + results.filesUpdated.length;
      await sendProgress({
        type: 'complete',
        message: `Applied ${totalSuccess} file(s) successfully${results.errors.length > 0 ? `, ${results.errors.length} error(s)` : ''}`,
        results
      });

    } catch (error) {
      console.error('[Apply Code] Fatal error:', error);
      await sendProgress({
        type: 'error',
        error: error instanceof Error ? error.message : 'Internal server error'
      });
    } finally {
      await writer.close();
    }
  })();

  // Return streaming response
  return new Response(stream.readable, {
    headers: {
      'Content-Type': 'text/event-stream',
      'Cache-Control': 'no-cache, no-transform',
      'Connection': 'keep-alive',
      'X-Accel-Buffering': 'no',
      'Access-Control-Allow-Origin': '*',
      'Access-Control-Allow-Methods': 'POST, OPTIONS',
      'Access-Control-Allow-Headers': 'Content-Type',
    },
  });
}

// Handle OPTIONS for CORS
export async function OPTIONS(request: NextRequest) {
  return new NextResponse(null, {
    status: 200,
    headers: {
      'Access-Control-Allow-Origin': '*',
      'Access-Control-Allow-Methods': 'POST, OPTIONS',
      'Access-Control-Allow-Headers': 'Content-Type',
    },
  });
}

// ============================================================================
// UTILITY EXPORTS (for testing or external use)
// ============================================================================

export const utils = {
  isPathSafe,
  normalizeFilePath,
  parseAIGeneratedCode,
  extractPackages,
  sanitizeContent,
};
