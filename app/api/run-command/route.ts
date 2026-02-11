import { NextRequest, NextResponse } from 'next/server';

// Interface for Sandbox type to avoid 'any'
interface Sandbox {
  runCommand: (options: { cmd: string; args: string[] }) => Promise<{
    stdout: () => Promise<string>;
    stderr: () => Promise<string>;
    exitCode: number;
  }>;
}

declare global {
  var activeSandbox: Sandbox | undefined;
}

/**
 * This route executes terminal commands within the E2B sandbox environment.
 * It is essential for installing packages or running scripts in the preview.
 */
export async function POST(request: NextRequest) {
  try {
    const { command } = await request.json();
    
    if (!command) {
      return NextResponse.json({ 
        success: false, 
        error: 'Command is required' 
      }, { status: 400 });
    }
    
    // Check if the sandbox is initialized
    if (!global.activeSandbox) {
      console.error('[run-command] Sandbox session not found');
      return NextResponse.json({ 
        success: false, 
        error: 'No active sandbox session found. Please refresh or restart the preview.' 
      }, { status: 400 });
    }
    
    console.log(`[run-command] Executing: ${command}`);
    
    // Split command into base command and arguments
    const [cmd, ...args] = command.trim().split(/\s+/);
    
    // Execute command using the E2B Sandbox
    const result = await global.activeSandbox.runCommand({
      cmd,
      args
    });
    
    // Wait for the outputs to resolve
    const stdout = await result.stdout();
    const stderr = await result.stderr();
    
    // Format the output for the terminal UI
    const output = [
      stdout.trim() ? stdout : '',
      stderr.trim() ? `ERROR:\n${stderr}` : '',
      `\nProcess finished with exit code: ${result.exitCode}`
    ].filter(Boolean).join('\n');
    
    return NextResponse.json({
      success: true,
      output,
      exitCode: result.exitCode,
      message: result.exitCode === 0 ? 'Success' : 'Command failed'
    });
    
  } catch (error) {
    console.error('[run-command] Error:', error);
    return NextResponse.json({ 
      success: false, 
      error: error instanceof Error ? error.message : 'Internal Server Error' 
    }, { status: 500 });
  }
}
