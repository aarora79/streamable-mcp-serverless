/**
 * Improved MCP Client Implementation
 * 
 * This is an enhanced version of the direct client that implements:
 * - Better error handling
 * - More robust OAuth flows
 * - Improved debug logging
 * - Explicit header management for each request
 */
import { createInterface } from 'node:readline';
import { URL } from 'url';
import { 
  makeRequest, 
  isStreamingFormat, 
  parseStreamingMessages
} from './mcpTransport';
import {
  generateRandomString,
  generateCodeChallenge,
  storePKCEParams,
  getPKCEParams,
  clearPKCEParams,
  storeToken,
  getStoredToken,
  isTokenExpired,
  promptForInput,
  escapeShellArg,
  openBrowser
} from './mcpClientUtils';

// Debug mode can be enabled via environment variable
const DEBUG = process.env.MCP_CLIENT_DEBUG === 'true';

// Create readline interface for user input
const readline = createInterface({
  input: process.stdin,
  output: process.stdout
});

// Global state for the client
let sessionId: string | null = null;
let accessToken: string | null = process.env.ACCESS_TOKEN || null;
let authMethod = process.env.AUTH_METHOD || 'auto'; // 'oauth', 'lambda', or 'auto'

// Default to localhost:3000/mcp for local development
// If MCP_SERVER_URL is provided, ensure it doesn't duplicate "/mcp"
let serverUrl = process.env.MCP_SERVER_URL || 'http://localhost:3000/mcp';

// If we're using the Lambda endpoint, make sure it's correctly formed
if (serverUrl.includes('execute-api') && serverUrl.includes('/prod') && !serverUrl.endsWith('/mcp')) {
  serverUrl = `${serverUrl}/mcp`;
}

// Remove any trailing slash
serverUrl = serverUrl.replace(/\/$/, '');

// Default OAuth2 configuration
const DEFAULT_OAUTH_CONFIG = {
  clientId: process.env.OAUTH_CLIENT_ID,
  redirectUri: process.env.OAUTH_REDIRECT_URI || 'http://localhost:8000/callback',
};

// Storage paths are defined in mcpClientUtils.ts

// Helper functions moved to mcpClientUtils.ts

/**
 * Helper function to promisify readline.question for easier use with async/await
 * Makes use of the exported promptForInput from mcpClientUtils.ts
 */
async function promptUser(question: string): Promise<string> {
  return promptForInput(question, readline);
}

/**
 * Main entry point for the client
 */
async function main(): Promise<void> {
  console.log('MCP Interactive Client');
  console.log('==============================================');
  
  // Check if we have a stored token that's not expired
  const storedToken = getStoredToken();
  if (storedToken && !isTokenExpired(storedToken)) {
    console.log('Found valid stored token. Using it for authentication.');
    accessToken = storedToken.access_token;
  }
  
  // Log authentication status
  if (accessToken) {
    console.log('Authentication: ✅ Initialized with token');
    
    // Only connect immediately if we have a token
    try {
      await connect();
    } catch (error) {
      console.error('Failed to connect with provided token. You can try reconnecting manually.');
      console.log('Type "auth login" to authenticate or "reconnect" to try again.');
    }
  } else {
    console.log('Authentication: ❌ No token found, you may need to run "auth login"');
    console.log('Type "auth login" to authenticate with OAuth 2.1');
  }

  // Print help and start the command loop
  printHelp();
  commandLoop();
}

/**
 * Print help information
 */
function printHelp(): void {
  console.log('\nAvailable commands:');
  console.log('  connect [url]              - Connect to MCP server (default: http://localhost:3000/prod/mcp)');
  console.log('  disconnect                 - Disconnect from server');
  console.log('  terminate-session          - Terminate the current session');
  console.log('  reconnect                  - Reconnect to the server');
  console.log('  list-tools                 - List available tools');
  console.log('  call-tool <n> [args]    - Call a tool with optional JSON arguments');
  console.log('  greet [name]               - Call the greet tool');
  console.log('  multi-greet [name]         - Call the multi-greet tool with notifications');
  console.log('  list-resources             - List available resources');
  console.log('  bedrock-report [region] [log_group] [days] [account_id] - Get Bedrock daily usage report');
  console.log('  auth login                - Authenticate with the MCP server using OAuth 2.1');
  console.log('  auth logout               - Clear the stored token');
  console.log('  auth status               - Show the current authentication status');
  console.log('  auth refresh              - Force refresh the access token');
  console.log('  set-auth-method <method>   - Set authorization method (oauth, lambda, or auto)');
  console.log('  debug [on|off]            - Enable or disable debug logging');
  console.log('  help                       - Show this help');
  console.log('  quit                       - Exit the program');
}

/**
 * Main command loop for the interactive client
 */
function commandLoop(): void {
  // Only ask questions if readline interface is still open
  if (!readline.closed) {
    readline.question('\n> ', async (input) => {
      const args = input.trim().split(/\s+/);
      const command = args[0]?.toLowerCase();

      try {
        switch (command) {
          case 'connect':
            try {
              await connect(args[1]);
            } catch (error) {
              // Connection error already logged in connect() function
              // Just continue the command loop
            }
            break;

          case 'disconnect':
            await disconnect();
            break;

          case 'terminate-session':
            await terminateSession();
            break;

          case 'reconnect':
            await reconnect();
            break;

          case 'list-tools':
            await listTools();
            break;

          case 'call-tool':
            if (args.length < 2) {
              console.log('Usage: call-tool <n> [args]');
            } else {
              const toolName = args[1];
              let toolArgs = {};
              if (args.length > 2) {
                try {
                  toolArgs = JSON.parse(args.slice(2).join(' '));
                } catch {
                  console.log('Invalid JSON arguments. Using empty args.');
                }
              }
              await callTool(toolName, toolArgs);
            }
            break;

          case 'greet':
            await callGreetTool(args[1] || 'MCP User');
            break;

          case 'multi-greet':
            await callMultiGreetTool(args[1] || 'MCP User');
            break;

          case 'list-resources':
            await listResources();
            break;

          case 'set-auth-method':
            if (args.length < 2 || !['oauth', 'lambda', 'auto'].includes(args[1])) {
              console.log('Usage: set-auth-method <oauth|lambda|auto>');
            } else {
              authMethod = args[1];
              console.log(`Auth method set to: ${authMethod}`);
            }
            break;

          case 'auth':
            const subCommand = args[1]?.toLowerCase();
            switch (subCommand) {
              case 'login':
                await loginWithOAuth();
                break;
              case 'logout':
                await logoutFromOAuth();
                break;
              case 'status':
                showAuthStatus();
                break;
              case 'refresh':
                await refreshAccessToken();
                break;
              default:
                console.log('Unknown auth subcommand. Use login, logout, status, or refresh.');
            }
            break;
            
          case 'debug':
            const debugSetting = args[1]?.toLowerCase();
            if (debugSetting === 'on') {
              process.env.MCP_CLIENT_DEBUG = 'true';
              console.log('Debug mode enabled');
            } else if (debugSetting === 'off') {
              process.env.MCP_CLIENT_DEBUG = 'false';
              console.log('Debug mode disabled');
            } else {
              console.log(`Debug mode: ${process.env.MCP_CLIENT_DEBUG === 'true' ? 'on' : 'off'}`);
            }
            break;

          case 'bedrock-report': {
            let region = 'us-east-1';
            let logGroupName = '/aws/bedrock/modelinvocations';
            let days = 1;
            let awsAccountId: string | undefined = undefined;
            let useDefaults = true;

            if (args.length > 1) {
              if (args.length < 4) {
                console.log('Usage: bedrock-report [region log_group_name days [aws_account_id]]');
                console.log('(Provide all 3 required args or none to use defaults)');
                break;
              }
              useDefaults = false;
              region = args[1];
              logGroupName = args[2];
              const parsedDays = parseInt(args[3], 10);
              awsAccountId = args[4];

              if (isNaN(parsedDays) || parsedDays <= 0) {
                console.log('Invalid number of days. Must be a positive integer.');
                break;
              }
              days = parsedDays;
            }

            if (useDefaults) {
              console.log(`Running bedrock-report with defaults: region=${region}, log_group=${logGroupName}, days=${days}`);
            } else {
              console.log(`Running bedrock-report with args: region=${region}, log_group=${logGroupName}, days=${days}${awsAccountId ? ", account=" + awsAccountId : ""}`);
            }

            const toolArgs: Record<string, unknown> = {
              region: region,
              log_group_name: logGroupName,
              days: days,
            };
            if (awsAccountId) {
              toolArgs.aws_account_id = awsAccountId;
            }

            await callTool('get_bedrock_usage_report', toolArgs);
            break;
          }

          case 'help':
            printHelp();
            break;

          case 'quit':
          case 'exit':
            await cleanup();
            return;

          default:
            if (command) {
              console.log(`Unknown command: ${command}`);
            }
            break;
        }
      } catch (error) {
        console.error(`Error executing command: ${error}`);
      }

      // Continue the command loop
      commandLoop();
    });
  } else {
    console.warn("Readline interface was closed. Cannot continue command loop.");
  }
}

// The parseStreamingMessages and isStreamingFormat functions are now imported from httpClient.ts

/**
 * Connect to the MCP server and initialize a session
 */
async function connect(url?: string): Promise<void> {
  if (sessionId) {
    console.log('Already connected. Disconnect first.');
    return;
  }

  if (url) {
    serverUrl = url;
  }

  console.log(`Connecting to ${serverUrl}...`);

  // If using OAuth and the token might be expired, try to refresh it first
  if (authMethod === 'oauth' || authMethod === 'auto') {
    await refreshTokenIfNeeded();
  }

  // Prepare initialize request
  const initializeRequest = {
    jsonrpc: '2.0',
    method: 'initialize',
    params: {
      clientInfo: { 
        name: 'understand-bedrock-spend-mcp-client',
        version: '1.0.0'
      },
      protocolVersion: '2025-03-26',
      capabilities: {}
    },
    id: 'init-1'
  };

  try {
    // Make the initialize request
    console.log('Making initialize request...');
    
    // Create headers with authentication if token is available
    const headers: Record<string, string> = {
      'Content-Type': 'application/json',
      'Accept': 'application/json, text/event-stream'
    };
    
    // Add authorization header based on auth method
    if (authMethod === 'oauth' || authMethod === 'auto') {
      // Add OAuth token if available
      if (accessToken) {
        headers['Authorization'] = `Bearer ${accessToken}`;
        console.log('Added OAuth Authorization header:', `Bearer ${accessToken.substring(0, 10)}...`);
      }
    } else if (authMethod === 'lambda') {
      // For Lambda authorizer, use a simple Bearer token
      // The original Lambda authorizer accepts any properly formatted Bearer token
      headers['Authorization'] = `Bearer token-for-lambda-authorizer`;
      console.log('Added Lambda Authorization header with placeholder token');
    }
    
    // Make the request
    const response = await makeRequest('POST', serverUrl, headers, initializeRequest, DEBUG);
    
    // Check for session ID
    if (response.headers && response.headers['mcp-session-id']) {
      sessionId = response.headers['mcp-session-id'];
      console.log('Session established with ID:', sessionId);
    } else {
      throw new Error('No session ID returned from server');
    }
    
    // Parse the response body - handle both direct JSON and streaming formats
    if (isStreamingFormat(response.body)) {
      // For MCP Streamable-HTTP format, parse the embedded JSON data
      console.log('Received Streamable-HTTP formatted response');
      const parsedMessages = parseStreamingMessages(response.body);
      
      if (parsedMessages.length > 0) {
        const firstMessage = parsedMessages[0];
        console.log('Server info:', firstMessage.result?.serverInfo);
        console.log('Protocol version:', firstMessage.result?.protocolVersion);
      }
    } else {
      // For direct JSON format
      try {
        const responseData = JSON.parse(response.body);
        console.log('Server info:', responseData.result?.serverInfo);
        console.log('Protocol version:', responseData.result?.protocolVersion);
      } catch (e) {
        console.warn('Could not parse response JSON:', e);
      }
    }
    
    console.log('✅ Successfully connected to MCP server');
  } catch (error: any) {
    console.error('Connection failed:', error.message);
    
    // Check for 401 status and WWW-Authenticate header
    if (error.statusCode === 401) {
      console.log('\x1b[31mAuthentication required.\x1b[0m');
      
      // If using auto mode, try switching to Lambda auth
      if (authMethod === 'auto') {
        console.log('Trying Lambda authorization method...');
        authMethod = 'lambda';
        try {
          await connect(serverUrl);
          return;
        } catch (lambdaError) {
          console.error('Lambda authorization also failed:', lambdaError.message);
          authMethod = 'auto'; // Reset to auto for next attempt
        }
      }
      
      // Check for resource metadata URI for OAuth
      if (error.headers && error.headers['www-authenticate']) {
        const wwwAuthHeader = error.headers['www-authenticate'];
        const match = wwwAuthHeader.match(/resource_metadata_uri="([^"]+)"/);
        if (match && match[1]) {
          console.log(`\nResource metadata available at: ${match[1]}`);
          console.log('You can authenticate with: auth login');
        }
      }
    }
    
    throw error;
  }
}

/**
 * Disconnect from the MCP server
 */
async function disconnect(): Promise<void> {
  if (!sessionId) {
    console.log('Not connected.');
    return;
  }

  try {
    console.log('Disconnecting from MCP server...');
    sessionId = null;
    console.log('Disconnected from MCP server');
  } catch (error) {
    console.error('Error disconnecting:', error);
  }
}

/**
 * Terminate the current MCP session
 */
async function terminateSession(): Promise<void> {
  if (!sessionId) {
    console.log('Not connected.');
    return;
  }

  try {
    console.log('Terminating session with ID:', sessionId);
    
    // Create headers with session ID and authentication
    const headers: Record<string, string> = {
      'mcp-session-id': sessionId
    };
    
    // Add authorization header based on auth method
    if (authMethod === 'oauth' || authMethod === 'auto') {
      // Add OAuth token if available
      if (accessToken) {
        headers['Authorization'] = `Bearer ${accessToken}`;
      }
    } else if (authMethod === 'lambda') {
      // For Lambda authorizer, use a simple Bearer token
      headers['Authorization'] = `Bearer token-for-lambda-authorizer`;
    }
    
    // Make DELETE request to terminate the session
    await makeRequest('DELETE', serverUrl, headers, undefined, DEBUG);
    
    console.log('Session terminated successfully');
    sessionId = null;
  } catch (error) {
    console.error('Error terminating session:', error);
  }
}

/**
 * Reconnect to the MCP server
 */
async function reconnect(): Promise<void> {
  if (sessionId) {
    await disconnect();
  }
  await connect();
}

/**
 * List available tools from the MCP server
 */
async function listTools(): Promise<void> {
  if (!sessionId) {
    console.log('Not connected to server.');
    return;
  }

  try {
    // Prepare list tools request
    const request = {
      jsonrpc: '2.0',
      method: 'tools/list',
      params: {},
      id: 'tools-1'
    };
    
    // Create headers with session ID and authentication
    const headers: Record<string, string> = {
      'Content-Type': 'application/json',
      'Accept': 'application/json, text/event-stream',
      'mcp-session-id': sessionId
    };
    
    // Add authorization header based on auth method
    if (authMethod === 'oauth' || authMethod === 'auto') {
      // Add OAuth token if available
      if (accessToken) {
        headers['Authorization'] = `Bearer ${accessToken}`;
      }
    } else if (authMethod === 'lambda') {
      // For Lambda authorizer, use a simple Bearer token
      headers['Authorization'] = `Bearer token-for-lambda-authorizer`;
    }
    
    // Make the request
    const response = await makeRequest('POST', serverUrl, headers, request, DEBUG);
    
    // Handle both direct JSON and streaming formats
    let toolsList: any[] = [];
    
    if (isStreamingFormat(response.body)) {
      // For MCP Streamable-HTTP format, parse the embedded JSON data
      const parsedMessages = parseStreamingMessages(response.body);
      
      if (parsedMessages.length > 0) {
        // Use the first parsed message that has a result property
        const resultMessage = parsedMessages.find(msg => msg.result);
        if (resultMessage?.result?.tools) {
          toolsList = resultMessage.result.tools;
        }
      }
    } else {
      // For direct JSON format
      try {
        const responseData = JSON.parse(response.body);
        if (responseData.result && responseData.result.tools) {
          toolsList = responseData.result.tools;
        }
      } catch (e) {
        console.warn('Could not parse tools response as JSON:', e);
      }
    }
    
    // Display tools
    console.log('Available tools:');
    if (toolsList.length === 0) {
      console.log('  No tools available');
    } else {
      for (const tool of toolsList) {
        console.log(`  - ${tool.name}: ${tool.description}`);
      }
    }
  } catch (error) {
    console.log(`Error listing tools: ${error}`);
  }
}

/**
 * Call a tool on the MCP server
 */
async function callTool(name: string, args: Record<string, unknown>): Promise<void> {
  if (!sessionId) {
    console.log('Not connected to server.');
    return;
  }

  try {
    // Prepare tool call request
    const request = {
      jsonrpc: '2.0',
      method: 'tools/call',
      params: {
        name,
        arguments: args
      },
      id: `tool-${Date.now()}`
    };
    
    console.log(`Calling tool '${name}' with args:`, args);
    
    // Create headers with session ID and authentication
    const headers: Record<string, string> = {
      'Content-Type': 'application/json',
      'Accept': 'application/json, text/event-stream',
      'mcp-session-id': sessionId
    };
    
    // Add authorization header based on auth method
    if (authMethod === 'oauth' || authMethod === 'auto') {
      // Add OAuth token if available
      if (accessToken) {
        headers['Authorization'] = `Bearer ${accessToken}`;
      }
    } else if (authMethod === 'lambda') {
      // For Lambda authorizer, use a simple Bearer token
      headers['Authorization'] = `Bearer token-for-lambda-authorizer`;
    }
    
    // Make the request
    const response = await makeRequest('POST', serverUrl, headers, request, DEBUG);
    
    // Handle both direct JSON and streaming formats
    let toolContent: any[] = [];
    
    if (isStreamingFormat(response.body)) {
      // For MCP Streamable-HTTP format, parse the embedded JSON data
      console.log('Received Streamable-HTTP formatted tool response');
      const parsedMessages = parseStreamingMessages(response.body);
      
      if (parsedMessages.length > 0) {
        // Use the first parsed message that has a result property
        const resultMessage = parsedMessages.find(msg => msg.result);
        if (resultMessage?.result?.content) {
          toolContent = resultMessage.result.content;
        }
      }
    } else {
      // For direct JSON format
      try {
        const responseData = JSON.parse(response.body);
        if (responseData.result && responseData.result.content) {
          toolContent = responseData.result.content;
        }
      } catch (e) {
        console.warn('Could not parse tool response as JSON:', e);
      }
    }
    
    // Display tool results
    if (toolContent.length > 0) {
      console.log('Tool result:');
      for (const item of toolContent) {
        if (item.type === 'text') {
          console.log(`  ${item.text}`);
        } else {
          console.log(`  ${item.type} content:`, item);
        }
      }
    } else {
      console.log('No result content returned from server');
    }
  } catch (error) {
    console.log(`Error calling tool ${name}: ${error}`);
  }
}

/**
 * Call the greet tool
 */
async function callGreetTool(name: string): Promise<void> {
  await callTool('greet', { name });
}

/**
 * Call the multi-greet tool
 */
async function callMultiGreetTool(name: string): Promise<void> {
  console.log('Calling multi-greet tool with notifications...');
  await callTool('multi-greet', { name });
}

/**
 * List available resources from the MCP server
 */
async function listResources(): Promise<void> {
  if (!sessionId) {
    console.log('Not connected to server.');
    return;
  }

  try {
    // Prepare list resources request
    const request = {
      jsonrpc: '2.0',
      method: 'resources/list',
      params: {},
      id: 'resources-1'
    };
    
    // Create headers with session ID and authentication
    const headers: Record<string, string> = {
      'Content-Type': 'application/json',
      'Accept': 'application/json, text/event-stream',
      'mcp-session-id': sessionId
    };
    
    // Add authorization header based on auth method
    if (authMethod === 'oauth' || authMethod === 'auto') {
      // Add OAuth token if available
      if (accessToken) {
        headers['Authorization'] = `Bearer ${accessToken}`;
      }
    } else if (authMethod === 'lambda') {
      // For Lambda authorizer, use a simple Bearer token
      headers['Authorization'] = `Bearer token-for-lambda-authorizer`;
    }
    
    // Make the request
    const response = await makeRequest('POST', serverUrl, headers, request, DEBUG);
    
    // Handle both direct JSON and streaming formats
    let resourcesList: any[] = [];
    
    if (isStreamingFormat(response.body)) {
      // For MCP Streamable-HTTP format, parse the embedded JSON data
      console.log('Received Streamable-HTTP formatted resources response');
      const parsedMessages = parseStreamingMessages(response.body);
      
      if (parsedMessages.length > 0) {
        // Use the first parsed message that has a result property
        const resultMessage = parsedMessages.find(msg => msg.result);
        if (resultMessage?.result?.resources) {
          resourcesList = resultMessage.result.resources;
        }
      }
    } else {
      // For direct JSON format
      try {
        const responseData = JSON.parse(response.body);
        if (responseData.result && responseData.result.resources) {
          resourcesList = responseData.result.resources;
        }
      } catch (e) {
        console.warn('Could not parse resources response as JSON:', e);
      }
    }
    
    // Display resources
    console.log('Available resources:');
    if (resourcesList.length === 0) {
      console.log('  No resources available');
    } else {
      for (const resource of resourcesList) {
        console.log(`  - ${resource.name}: ${resource.uri}`);
      }
    }
  } catch (error) {
    console.log(`Resources not supported by this server (${error})`);
  }
}

/**
 * Authenticate with the OAuth server using PKCE for enhanced security
 * with fallback to direct authentication when discovery fails
 */

async function loginWithOAuth() {
  try {
    console.log('Starting OAuth authentication flow...');
    
    // Extract the server base URL from the MCP server URL
    const mcpUrl = new URL(serverUrl);
    const baseUrl = `${mcpUrl.protocol}//${mcpUrl.hostname}${mcpUrl.port ? ':' + mcpUrl.port : ''}`;
    
    // Handle base path for Lambda deployments
    let basePath = '';
    if (mcpUrl.pathname.includes('/prod')) {
      basePath = '/prod';
    }
    
    // Generate PKCE parameters in case we need them
    const codeVerifier = generateRandomString(64);
    const codeChallenge = generateCodeChallenge(codeVerifier);
    const state = generateRandomString(32);
    const redirectUri = DEFAULT_OAUTH_CONFIG.redirectUri;
    
    // Whether the auth server supports PKCE
    let supportsCodeChallenge = false;
    
    // Try OAuth discovery first, but continue even if it fails
    try {
      // Build the resource metadata URL with correct base path
      const resourceMetadataUrl = `${baseUrl}${basePath}/.well-known/oauth-protected-resource`;
      console.log(`Discovering OAuth configuration from: ${resourceMetadataUrl}`);
      
      try {
        // First, get the raw resource metadata
        console.log('Fetching resource metadata...');
        const metadataResponse = await makeRequest('GET', resourceMetadataUrl, {}, undefined, DEBUG);
        
        if (metadataResponse.statusCode === 200) {
          // Parse the resource metadata
          const resourceMetadata = JSON.parse(metadataResponse.body);
          
          // Check if auth server URLs are available
          if (resourceMetadata.authorization_servers && 
              resourceMetadata.authorization_servers.length > 0) {
            
            // Get the authorization server metadata URL
            const authServer = resourceMetadata.authorization_servers[0];
            const authServerMetadataUrl = authServer.authorization_server_metadata_url;
            
            try {
              // Fetch authorization server metadata
              console.log(`Fetching authorization server metadata from: ${authServerMetadataUrl}`);
              
              // Variable to store the response
              let authServerMetadataResponse;
              
              try {
                // First try the standard URL format
                authServerMetadataResponse = await makeRequest('GET', authServerMetadataUrl, {}, undefined, DEBUG);
                
                if (authServerMetadataResponse.statusCode !== 200) {
                  throw new Error(`HTTP ${authServerMetadataResponse.statusCode}: ${authServerMetadataResponse.body}`);
                }
              } catch (error) {
                // If the direct URL fails and we're using Cognito, try the Cognito-specific URL format
                if (authServerMetadataUrl.includes('amazoncognito.com')) {
                  console.log('Standard discovery endpoint failed, trying Cognito-specific endpoint format...');
                  
                  // Get Cognito region and user pool ID from environment or extract from URL
                  const region = process.env.COGNITO_REGION || 'us-east-1';
                  const userPoolId = process.env.COGNITO_USER_POOL_ID || (() => {
                    // Try to extract from the URL if possible
                    const matches = authServerMetadataUrl.match(/\/\/([^.]+)\.auth\.([^.]+)\.amazoncognito\.com/);
                    if (matches && matches.length >= 3) {
                      const domainPrefix = matches[1]; // e.g., "us-east-1-igrnjncts"
                      const region = matches[2]; // e.g., "us-east-1"
                      
                      // Try to reconstruct the user pool ID from the domain prefix
                      // This is just a best effort, may not work in all cases
                      const parts = domainPrefix.split('-');
                      if (parts.length >= 2) {
                        const regionPart = parts.slice(0, parts.length - 1).join('-');
                        const idPart = parts[parts.length - 1].toUpperCase();
                        return `${regionPart}_${idPart}`;
                      }
                    }
                    return null;
                  })();
                  
                  if (userPoolId) {
                    // Construct the Cognito-specific discovery URL
                    const cognitoMetadataUrl = `https://cognito-idp.${region}.amazonaws.com/${userPoolId}/.well-known/openid-configuration`;
                    console.log(`Trying Cognito-specific metadata URL: ${cognitoMetadataUrl}`);
                    
                    authServerMetadataResponse = await makeRequest('GET', cognitoMetadataUrl, {}, undefined, DEBUG);
                    if (authServerMetadataResponse.statusCode !== 200) {
                      // If this also fails, re-throw with a clear error message
                      throw new Error(`Failed to fetch metadata from Cognito-specific endpoint: HTTP ${authServerMetadataResponse.statusCode}`);
                    }
                  } else {
                    // If we couldn't determine the user pool ID, re-throw the original error
                    throw error;
                  }
                } else {
                  // Re-throw the original error if we're not using Cognito
                  throw error;
                }
              }
              
              // Now we should have a valid response in authServerMetadataResponse
              if (authServerMetadataResponse.statusCode === 200) {
                // Parse the authorization server metadata
                const authServerMetadata = JSON.parse(authServerMetadataResponse.body);
                
                // Check if authorization server supports PKCE
                supportsCodeChallenge = Array.isArray(authServerMetadata.code_challenge_methods_supported) && 
                                      authServerMetadata.code_challenge_methods_supported.includes('S256');
                
                if (supportsCodeChallenge) {
                  console.log('Authorization server supports PKCE - will enhance security with PKCE');
                  
                  // Store PKCE parameters for later use
                  storePKCEParams({
                    codeVerifier,
                    codeChallenge,
                    state,
                    redirectUri
                  });
                }
              } else {
                throw new Error(`HTTP ${authServerMetadataResponse.statusCode}: ${authServerMetadataResponse.body}`);
              }
            } catch (metadataError) {
              console.log(`Error fetching authorization server metadata: ${metadataError.message}`);
              console.log('Continuing with login process without PKCE...');
              // We still proceed, just without PKCE enhancement
            }
          } else {
            console.log('No authorization servers found in resource metadata');
          }
        } else {
          throw new Error(`HTTP ${metadataResponse.statusCode}: ${metadataResponse.body}`);
        }
      } catch (resourceError) {
        console.log(`Error fetching resource metadata: ${resourceError.message}`);
        console.log('Continuing with login process...');
      }
    } catch (discoveryError) {
      console.log(`OAuth discovery failed: ${discoveryError.message}`);
      console.log('Falling back to direct authentication...');
    }
    
    // Proceed with CLI-based authentication regardless of discovery outcome
    console.log('Using CLI-based authentication with username/password...');
    
    // Prompt for username and password
    const username = await promptUser('Enter username: ');
    const password = await promptUser('Enter password: ');
    
    console.log('Authenticating with Cognito...');
    
    try {
      // Use the AWS CLI for Cognito authentication
      const { execSync } = require('child_process');
      
      // Get client ID from environment or use default
      const clientId = process.env.OAUTH_CLIENT_ID || DEFAULT_OAUTH_CONFIG.clientId;
      
      // Escape special characters to prevent command injection
      const escapedUsername = escapeShellArg(username);
      const escapedPassword = escapeShellArg(password);
      
      // Build the AWS CLI command for Cognito authentication
      let authParameters = `USERNAME="${escapedUsername}",PASSWORD="${escapedPassword}"`;
      
      if (supportsCodeChallenge) {
        authParameters += `,CODE_CHALLENGE="${codeChallenge}",CODE_CHALLENGE_METHOD="S256"`;
      }
      
      const cognitoCommand = `aws cognito-idp initiate-auth \
        --auth-flow USER_PASSWORD_AUTH \
        --client-id ${clientId} \
        --auth-parameters ${authParameters} \
        --query 'AuthenticationResult.AccessToken' \
        --output text`;
      
      console.log('Executing authentication command...');
      
      // Execute the command and capture the output
      const token = execSync(cognitoCommand, { 
        encoding: 'utf8',
        stdio: ['pipe', 'pipe', 'pipe'] // stdin, stdout, stderr
      }).trim();
      
      console.log('Received authentication response');
      
      // Validate the token
      if (!token || token.includes('error') || token.length < 20) {
        throw new Error('Failed to obtain valid token from authentication service');
      }
      
      // Store the token
      accessToken = token;
      console.log('Successfully authenticated!');
      
      // Get refresh token if available
      let refreshToken = '';
      try {
        // Try to get the refresh token from the Cognito response
        const refreshCommand = `aws cognito-idp initiate-auth \
          --auth-flow USER_PASSWORD_AUTH \
          --client-id ${clientId} \
          --auth-parameters ${authParameters} \
          --query 'AuthenticationResult.RefreshToken' \
          --output text`;
          
        const fullResponse = execSync(refreshCommand, {
          encoding: 'utf8',
          stdio: ['pipe', 'pipe', 'pipe']
        }).trim();
        
        if (fullResponse && fullResponse.length > 20) {
          refreshToken = fullResponse;
          console.log('Successfully obtained refresh token');
        }
      } catch (refreshError) {
        // It's okay if we can't get a refresh token
        console.log('Could not obtain refresh token - token refresh will not be available');
      }
      
      // Store the token with current timestamp for expiration checking
      try {
        const tokenData: any = {
          access_token: token,
          token_type: 'Bearer',
          expires_in: 3600, // Default 1 hour expiration for tokens
          iat: Math.floor(Date.now() / 1000) // Current time in seconds
        };
        
        // Add refresh token if available
        if (refreshToken) {
          tokenData.refresh_token = refreshToken;
        }
        
        // Store PKCE code verifier for potential future use
        tokenData.code_verifier = codeVerifier;
        
        storeToken(tokenData);
      } catch (storeError) {
        console.error('Error storing token:', storeError);
      }
      
      // Clear PKCE params if we stored them
      if (supportsCodeChallenge) {
        clearPKCEParams();
      }
      
      // Auto-connect after successful login
      console.log('Connecting to server with the new token...');
      try {
        await connect();
        console.log('✅ Connected successfully with authentication!');
      } catch (connectError) {
        console.error('Failed to auto-connect after login:', connectError.message);
        console.log('You can try connecting manually with the "connect" command');
      }
      
    } catch (cliError) {
      // More detailed error handling that includes the stderr output
      console.error('Authentication error:', cliError.message);
      
      let errorMessage = 'Authentication failed. Please try again';
      
      if (cliError.stderr) {
        const errorOutput = typeof cliError.stderr === 'string' ? 
          cliError.stderr : cliError.stderr.toString();
        
        // Provide more helpful error messages for common errors
        if (errorOutput.includes('NotAuthorizedException')) {
          errorMessage = 'Authentication failed: Incorrect username or password';
        } else if (errorOutput.includes('UserNotFoundException')) {
          errorMessage = 'Authentication failed: User does not exist';
        } else if (errorOutput.includes('aws: command not found')) {
          errorMessage = 'AWS CLI not found. Please install the AWS CLI and configure it';
        } else {
          // Log the error for debugging if debug mode is enabled
          if (DEBUG) {
            console.error('Full error output:', errorOutput);
          }
          errorMessage = 'Authentication failed. Please check your credentials and try again';
        }
      }
      
      throw new Error(errorMessage);
    }
  } catch (error) {
    console.error('Authentication failed:', error instanceof Error ? error.message : String(error));
    accessToken = null;
    clearPKCEParams(); // Clean up PKCE params on error
  }
}
async function refreshAccessToken(): Promise<boolean> {
  const storedToken = getStoredToken();
  if (!storedToken || !storedToken.refresh_token) {
    console.log('No refresh token available. Please login again.');
    return false;
  }
  
  try {
    console.log('Refreshing access token using refresh token...');
    
    // Extract the server base URL from the MCP server URL
    const mcpUrl = new URL(serverUrl);
    const baseUrl = `${mcpUrl.protocol}//${mcpUrl.hostname}${mcpUrl.port ? ':' + mcpUrl.port : ''}`;
    
    // Handle base path for Lambda deployments
    let basePath = '';
    if (mcpUrl.pathname.includes('/prod')) {
      basePath = '/prod';
    }
    
    // Construct the token endpoint URL from the resource metadata
    const resourceMetadataUrl = `${baseUrl}${basePath}/.well-known/oauth-protected-resource`;
    console.log(`Fetching OAuth configuration from: ${resourceMetadataUrl}`);
    
    // Try to get token endpoint via discovery, but use fallback if not available
    let tokenEndpoint: string;
    
    try {
      // Get resource metadata to find token endpoint
      const metadataResponse = await makeRequest('GET', resourceMetadataUrl, {}, undefined, DEBUG);
      if (metadataResponse.statusCode !== 200) {
        throw new Error(`Failed to fetch resource metadata: ${metadataResponse.statusCode}`);
      }
      
      // Parse metadata to get authorization server info
      const resourceMetadata = JSON.parse(metadataResponse.body);
      if (!resourceMetadata.authorization_servers || 
          resourceMetadata.authorization_servers.length === 0) {
        throw new Error('No authorization servers found in resource metadata');
      }
      
      // Get the authorization server metadata URL
      const authServer = resourceMetadata.authorization_servers[0];
      const authServerMetadataUrl = authServer.authorization_server_metadata_url;
      
      console.log(`Fetching authorization server metadata from: ${authServerMetadataUrl}`);
      
      // Variable to store the response
      let authServerMetadataResponse;
      
      try {
        // First try the standard URL format
        authServerMetadataResponse = await makeRequest('GET', authServerMetadataUrl, {}, undefined, DEBUG);
        
        if (authServerMetadataResponse.statusCode !== 200) {
          throw new Error(`HTTP ${authServerMetadataResponse.statusCode}: ${authServerMetadataResponse.body}`);
        }
      } catch (error) {
        // If the direct URL fails and we're using Cognito, try the Cognito-specific URL format
        if (authServerMetadataUrl.includes('amazoncognito.com')) {
          console.log('Standard discovery endpoint failed, trying Cognito-specific endpoint format...');
          
          // Get Cognito region and user pool ID from environment or extract from URL
          const region = process.env.COGNITO_REGION || 'us-east-1';
          const userPoolId = process.env.COGNITO_USER_POOL_ID || (() => {
            // Try to extract from the URL if possible
            const matches = authServerMetadataUrl.match(/\/\/([^.]+)\.auth\.([^.]+)\.amazoncognito\.com/);
            if (matches && matches.length >= 3) {
              const domainPrefix = matches[1]; // e.g., "us-east-1-igrnjncts"
              const region = matches[2]; // e.g., "us-east-1"
              
              // Try to reconstruct the user pool ID from the domain prefix
              // This is just a best effort, may not work in all cases
              const parts = domainPrefix.split('-');
              if (parts.length >= 2) {
                const regionPart = parts.slice(0, parts.length - 1).join('-');
                const idPart = parts[parts.length - 1].toUpperCase();
                return `${regionPart}_${idPart}`;
              }
            }
            return null;
          })();
          
          if (userPoolId) {
            // Construct the Cognito-specific discovery URL
            const cognitoMetadataUrl = `https://cognito-idp.${region}.amazonaws.com/${userPoolId}/.well-known/openid-configuration`;
            console.log(`Trying Cognito-specific metadata URL: ${cognitoMetadataUrl}`);
            
            authServerMetadataResponse = await makeRequest('GET', cognitoMetadataUrl, {}, undefined, DEBUG);
            if (authServerMetadataResponse.statusCode !== 200) {
              // If this also fails, re-throw with a clear error message
              throw new Error(`Failed to fetch metadata from Cognito-specific endpoint: HTTP ${authServerMetadataResponse.statusCode}`);
            }
          } else {
            // If we couldn't determine the user pool ID, re-throw the original error
            throw error;
          }
        } else {
          // Re-throw the original error if we're not using Cognito
          throw error;
        }
      }
      
      // Parse to get token endpoint
      const authServerMetadata = JSON.parse(authServerMetadataResponse.body);
      tokenEndpoint = authServerMetadata.token_endpoint;
      
      if (!tokenEndpoint) {
        throw new Error('Token endpoint not found in authorization server metadata');
      }
      
      console.log(`Using discovered token endpoint: ${tokenEndpoint}`);
    } catch (discoveryError) {
      console.log(`Discovery failed: ${discoveryError.message}`);
      console.log('Using fallback token endpoint...');
      
      // Construct fallback token endpoint based on Cognito pattern
      // Extract region from the MCP URL or use default
      const region = process.env.COGNITO_REGION || 'us-east-1';
      
      // Check if we have an explicit Cognito domain from environment variables
      let cognitoDomain = process.env.COGNITO_DOMAIN;
      
      if (cognitoDomain) {
        // If domain is provided but doesn't include the full domain suffix, add it
        if (!cognitoDomain.includes('.auth.') && !cognitoDomain.includes('.amazoncognito.com')) {
          cognitoDomain = `${cognitoDomain}.auth.${region}.amazoncognito.com`;
        }
        
        console.log(`Using configured Cognito domain: ${cognitoDomain}`);
        tokenEndpoint = `https://${cognitoDomain}/oauth2/token`;
      } else {
        // Fall back to constructing domain from user pool ID
        const userPoolId = process.env.COGNITO_USER_POOL_ID;
        
        // Parse the user pool ID to construct the domain
        const parts = userPoolId.split('_');
        let domainPrefix: string;
        
        if (parts.length === 2) {
          domainPrefix = `${parts[0]}-${parts[1].toLowerCase()}`;
        } else {
          domainPrefix = userPoolId.toLowerCase().replace('_', '-');
        }
        
        tokenEndpoint = `https://${domainPrefix}.auth.${region}.amazoncognito.com/oauth2/token`;
      }
      console.log(`Using fallback token endpoint: ${tokenEndpoint}`);
    }
    
    if (!tokenEndpoint) {
      throw new Error('Token endpoint not found in authorization server metadata');
    }
    
    console.log(`Using token endpoint: ${tokenEndpoint}`);
    
    // Get client ID from environment or use default
    const clientId = process.env.OAUTH_CLIENT_ID || DEFAULT_OAUTH_CONFIG.clientId;
    
    // Build the refresh token request
    const requestBody = new URLSearchParams();
    requestBody.append('grant_type', 'refresh_token');
    requestBody.append('refresh_token', storedToken.refresh_token);
    requestBody.append('client_id', clientId);
    
    // Make the token request
    const tokenResponse = await makeRequest(
      'POST', 
      tokenEndpoint, 
      {
        'Content-Type': 'application/x-www-form-urlencoded'
      }, 
      requestBody.toString(),
      DEBUG
    );
    
    if (tokenResponse.statusCode !== 200) {
      // If token refresh failed, we might need to re-authenticate
      if (tokenResponse.statusCode === 400 || tokenResponse.statusCode === 401) {
        console.log('Refresh token expired or invalid. Please login again.');
        // Clear the invalid token using the utility function
        storeToken({
          access_token: '',
          token_type: '',
          expires_in: 0,
          iat: 0
        });
      }
      throw new Error(`Token refresh failed: ${tokenResponse.statusCode}`);
    }
    
    // Parse the token response
    const tokenData = JSON.parse(tokenResponse.body);
    
    // If refresh token is not returned, keep the old one (some providers don't return a new refresh token)
    if (!tokenData.refresh_token && storedToken.refresh_token) {
      console.log('No new refresh token provided, keeping existing one');
      tokenData.refresh_token = storedToken.refresh_token;
    } else if (tokenData.refresh_token) {
      console.log('Received new refresh token - implementing token rotation');
    }
    
    // Update the stored token with the new values
    const newToken = {
      access_token: tokenData.access_token,
      token_type: tokenData.token_type || 'Bearer',
      expires_in: tokenData.expires_in || 3600,
      refresh_token: tokenData.refresh_token,
      iat: Math.floor(Date.now() / 1000) // Current time in seconds
    };
    
    // Store the new token
    accessToken = newToken.access_token;
    storeToken(newToken);
    
    console.log('Access token refreshed successfully');
    return true;
  } catch (error) {
    console.error('Failed to refresh token:', error instanceof Error ? error.message : String(error));
    
    // If the error indicates we need to re-authenticate, try that as a fallback
    if (error instanceof Error && 
        (error.message.includes('expired') || 
         error.message.includes('invalid') || 
         error.message.includes('401') || 
         error.message.includes('400'))) {
      console.log('Attempting to re-authenticate...');
      try {
        await loginWithOAuth();
        return true;
      } catch (loginError) {
        console.error('Re-authentication failed:', loginError instanceof Error ? loginError.message : String(loginError));
      }
    }
    
    return false;
  }
}

/**
 * Check if the token is expired and refresh if needed
 */
async function refreshTokenIfNeeded(): Promise<boolean> {
  const storedToken = getStoredToken();
  if (!storedToken) {
    return false;
  }
  
  if (isTokenExpired(storedToken)) {
    console.log('Token is expired, attempting to refresh...');
    return await refreshAccessToken();
  }
  
  return false;
}

/**
 * Log out by clearing the stored token
 */
async function logoutFromOAuth(): Promise<void> {
  try {
    // Clear token store using the utility function
    storeToken({
      access_token: '',
      token_type: '',
      expires_in: 0,
      iat: 0
    });
    
    accessToken = null;
    console.log('Logged out successfully');
    
    // If we're connected, reconnect without the token
    if (sessionId) {
      console.log('Reconnecting without token...');
      await reconnect();
    }
  } catch (error) {
    console.error('Error logging out:', error);
  }
}

/**
 * Show the current authentication status
 */
function showAuthStatus(): void {
  if (accessToken) {
    console.log('Authentication status: \x1b[32mAuthenticated\x1b[0m');
    
    // Check expiration
    const storedToken = getStoredToken();
    if (storedToken) {
      if (isTokenExpired(storedToken)) {
        console.log('Token is expired. Refresh is needed.');
      } else {
        // Calculate expiration time
        const expiresAt = (storedToken.iat || 0) + (storedToken.expires_in || 3600);
        const now = Math.floor(Date.now() / 1000);
        const remainingSeconds = expiresAt - now;
        
        if (remainingSeconds > 0) {
          const remainingMinutes = Math.floor(remainingSeconds / 60);
          console.log(`Token expires in ${remainingMinutes} minutes`);
        }
      }
    }
  } else {
    console.log('Authentication status: \x1b[31mNot authenticated\x1b[0m');
  }
}

/**
 * Clean up resources before exiting
 */
async function cleanup(): Promise<void> {
  try {
    // Only try to terminate the session if we're connected
    if (sessionId) {
      try {
        await terminateSession();
      } catch (error) {
        console.error('Error terminating session:', error);
      }
    }
    
    readline.close();
    console.log('\nGoodbye!');
    process.exit(0);
  } catch (error) {
    console.error('Error during cleanup:', error);
    process.exit(1);
  }
}

// Token management functions moved to mcpClientUtils.ts

// Network and transport functions now imported from mcpTransport.ts

// Handle SIGINT (Ctrl+C)
process.on('SIGINT', async () => {
  console.log('\nReceived SIGINT. Cleaning up...');
  await cleanup();
});

// Start the client
main().catch((error: unknown) => {
  console.error('Error running MCP client:', error);
  process.exit(1);
});