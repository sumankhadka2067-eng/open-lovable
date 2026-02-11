import { NextResponse } from 'next/server';

/**
 * Interface to safely handle the global sandbox state.
 */
declare global {
  var activeSandbox: any;
  var activeSandboxProvider: any; // Used by some versions of the template
  var sandboxData: any;
  var existingFiles: Set<string> | undefined;
}

/**
 * This route terminates the current sandbox session.
 * It is used when a user starts a new project or manually resets the environment.
 */
export async function POST() {
  try {
    console.log('[kill-sandbox] Initiating cleanup...');

    let sandboxKilled = false;

    // 1. Terminate the Sandbox Session (E2B)
    // Checking both activeSandbox and activeSandboxProvider for compatibility
    const sessionToKill = global.activeSandbox || global.activeSandboxProvider;

    if (sessionToKill) {
      try {
        // E2B sessions use .kill() or .terminate() depending on the SDK version
        if (typeof sessionToKill.kill === 'function') {
          await sessionToKill.kill();
        } else if (typeof sessionToKill.terminate === 'function') {
          await sessionToKill.terminate();
        }
        
        sandboxKilled = true;
        console.log('[kill-sandbox] Active session terminated.');
      } catch (e) {
        console.error('[kill-sandbox] Error during termination:', e);
      }
      
      // Reset global pointers
      global.activeSandbox = null;
      global.activeSandboxProvider = null;
      global.sandboxData = null;
    }
    
    // 2. Clear File Tracking
    if (global.existingFiles) {
      global.existingFiles.clear();
      console.log('[kill-sandbox] File tracking cleared.');
    }
    
    return NextResponse.json({
      success: true,
      sandboxKilled,
      message: sandboxKilled 
        ? 'Environment cleaned up successfully' 
        : 'No active environment found to clean'
    });
    
  } catch (error) {
    console.error('[kill-sandbox] Critical Error:', error);
    return NextResponse.json(
      { 
        success: false, 
        error: error instanceof Error ? error.message : 'Unknown error during cleanup'
      }, 
      { status: 500 }
    );
  }
}
