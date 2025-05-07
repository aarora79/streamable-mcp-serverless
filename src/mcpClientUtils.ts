/**
 * MCP Client Utilities
 * 
 * This file provides utility functions for the MCP client, including:
 * - OAuth authentication helpers (PKCE, token management)
 * - Secure token storage and retrieval
 * - Input/output utilities
 * 
 * These utilities abstract away the complexity of authentication,
 * security, and user interaction for the main client code.
 */

import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';
import { createHash, randomBytes } from 'crypto';
import { createInterface } from 'node:readline';
import { exec } from 'child_process';

// Path to store tokens and PKCE parameters
export const configDir = path.join(os.homedir(), '.mcp-client');
export const tokenStore = path.join(configDir, 'tokens.json');
export const pkceStore = path.join(configDir, 'pkce.json');

// Make sure the config directory exists
if (!fs.existsSync(configDir)) {
  fs.mkdirSync(configDir, { recursive: true });
}

/**
 * Token-related types
 */

export interface TokenData {
  access_token: string;
  token_type: string;
  expires_in: number;
  refresh_token?: string;
  id_token?: string;
  iat?: number;
  [key: string]: any;
}

export interface PKCEParams {
  codeVerifier: string;
  codeChallenge: string;
  state: string;
  redirectUri: string;
  timestamp?: number;
}

/**
 * Helper function to prompt for user input
 */
export function promptForInput(question: string, readline: ReturnType<typeof createInterface>): Promise<string> {
  return new Promise((resolve) => {
    readline.question(question, (answer) => {
      resolve(answer);
    });
  });
}

/**
 * Generate a cryptographically secure random string of specified length
 * Used for PKCE code verifier and state parameter
 */
export function generateRandomString(length: number = 64): string {
  return randomBytes(length).toString('base64url').substring(0, length);
}

/**
 * Generates a code challenge using SHA-256 hash as required by PKCE
 */
export function generateCodeChallenge(codeVerifier: string): string {
  return createHash('sha256')
    .update(codeVerifier)
    .digest('base64url')
    .replace(/\+/g, '-')
    .replace(/\//g, '_')
    .replace(/=/g, '');
}

/**
 * Store PKCE parameters for use in authorization code exchange
 */
export function storePKCEParams(params: PKCEParams): void {
  try {
    // Add timestamp for expiration
    const pkceData = {
      ...params,
      timestamp: Date.now()
    };
    
    fs.writeFileSync(pkceStore, JSON.stringify(pkceData, null, 2));
  } catch (error) {
    console.error('Error storing PKCE parameters:', error);
  }
}

/**
 * Get stored PKCE parameters
 */
export function getPKCEParams(): PKCEParams | null {
  try {
    if (fs.existsSync(pkceStore)) {
      const data = fs.readFileSync(pkceStore, 'utf8');
      const pkceData = JSON.parse(data) as PKCEParams;
      
      // Check if PKCE data is expired (10 minutes)
      const now = Date.now();
      if (pkceData.timestamp && now - pkceData.timestamp > 10 * 60 * 1000) {
        // PKCE data expired, delete it
        fs.unlinkSync(pkceStore);
        return null;
      }
      
      return pkceData;
    }
  } catch (error) {
    console.error('Error reading PKCE parameters:', error);
  }
  return null;
}

/**
 * Clear stored PKCE parameters
 */
export function clearPKCEParams(): void {
  try {
    if (fs.existsSync(pkceStore)) {
      fs.unlinkSync(pkceStore);
    }
  } catch (error) {
    console.error('Error clearing PKCE parameters:', error);
  }
}

/**
 * Store a token in the token store
 */
export function storeToken(token: TokenData): void {
  try {
    // Add current timestamp if not present
    if (!token.iat) {
      token.iat = Math.floor(Date.now() / 1000);
    }
    
    fs.writeFileSync(tokenStore, JSON.stringify(token, null, 2));
  } catch (error) {
    console.error('Error storing token:', error);
  }
}

/**
 * Get a stored token from the token store
 */
export function getStoredToken(): TokenData | null {
  try {
    if (fs.existsSync(tokenStore)) {
      const data = fs.readFileSync(tokenStore, 'utf8');
      return JSON.parse(data);
    }
  } catch (error) {
    console.error('Error reading token:', error);
  }
  return null;
}

/**
 * Check if a token is expired
 */
export function isTokenExpired(token: TokenData): boolean {
  // If there's no expiration or timestamp, consider it expired
  if (!token.expires_in || !token.iat) {
    return true;
  }
  
  // Check if the token has expired (with 60-second buffer)
  const expirationTime = (token.iat + token.expires_in - 60);
  const currentTime = Math.floor(Date.now() / 1000);
  
  return currentTime > expirationTime;
}

/**
 * Execute a command as a child process
 * 
 * This is a promisified version of child_process.exec for use in async/await code.
 * Currently not used in the client code (which uses execSync directly),
 * but kept for potential future use in asynchronous command execution.
 * 
 * @param command - The shell command to execute
 * @returns A promise that resolves with the command output or rejects with error
 */
export function executeCommand(command: string): Promise<string> {
  return new Promise((resolve, reject) => {
    exec(command, (error, stdout, stderr) => {
      if (error) {
        reject({ error, stderr });
        return;
      }
      resolve(stdout.trim());
    });
  });
}

/**
 * Opens the default browser with the provided URL
 */
export function openBrowser(url: string): void {
  const command = process.platform === 'win32' ? 'start' :
                 process.platform === 'darwin' ? 'open' : 'xdg-open';
  
  console.log(`Opening browser to: ${url}`);
  exec(`${command} "${url}"`);
}

/**
 * Parse a URL query string into key-value pairs
 */
export function parseQueryString(queryString: string): Record<string, string> {
  const params: Record<string, string> = {};
  const searchParams = new URLSearchParams(queryString);
  
  for (const [key, value] of searchParams.entries()) {
    params[key] = value;
  }
  
  return params;
}

/**
 * Escape special characters to prevent command injection
 */
export function escapeShellArg(arg: string): string {
  return arg.replace(/['"\\]/g, '\\$&');
}