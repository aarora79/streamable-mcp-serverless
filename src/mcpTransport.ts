/**
 * MCP Transport Layer
 * 
 * This file provides transport layer utilities for the MCP client, including:
 * - HTTP/HTTPS request handling
 * - Streamable-HTTP format processing
 * - MCP protocol messaging
 * 
 * It abstracts away the complexity of the MCP transport protocol
 * and provides a reliable communication layer with error handling.
 */
import * as http from 'http';
import * as https from 'https';
import { URL } from 'url';

/**
 * Response object returned by makeRequest
 */
export interface RequestResponse {
  statusCode: number;
  headers: Record<string, string>;
  body: string;
}

/**
 * MCP Request type for more strongly typed requests
 */
export interface McpRequest {
  jsonrpc: string;
  method: string;
  params: Record<string, any>;
  id: string;
}

/**
 * Make an HTTP/HTTPS request with comprehensive error handling and debug logging
 * 
 * @param method - HTTP method (GET, POST, etc.)
 * @param url - The URL to request
 * @param headers - HTTP headers to include
 * @param body - Optional request body
 * @param debug - Whether to enable debug logging
 * @returns Promise resolving to response with status code, headers, and body
 */
export async function makeRequest(
  method: string,
  url: string,
  headers: Record<string, string>,
  body?: any,
  debug: boolean = false
): Promise<RequestResponse> {
  return new Promise((resolve, reject) => {
    // Parse the URL to determine whether to use HTTP or HTTPS
    const parsedUrl = new URL(url);
    const httpModule = parsedUrl.protocol === 'https:' ? https : http;
    
    // Always ensure we have the proper content type and accept headers
    headers = {
      'Content-Type': 'application/json',
      'Accept': 'application/json, text/event-stream',
      ...headers  // This allows overriding the defaults if provided
    };
    
    // Add protocol version header for MCP
    headers['MCP-Protocol-Version'] = '2025-03-26';
    
    // Prepare request options
    const options: http.RequestOptions = {
      method,
      headers,
      timeout: 30000, // 30 second timeout
    };
    
    if (debug) {
      console.log('\n-------- REQUEST --------');
      console.log(`${method} ${url}`);
      console.log('Headers:', JSON.stringify(headers, null, 2));
      if (body) {
        console.log('Body:', typeof body === 'string' ? body : JSON.stringify(body, null, 2));
      }
      console.log('--------------------------\n');
    }
    
    // Create the request
    const req = httpModule.request(url, options, (res) => {
      let responseBody = '';
      
      // Log the response status and headers if in debug mode
      if (debug) {
        console.log('\n-------- RESPONSE --------');
        console.log(`Status: ${res.statusCode} ${res.statusMessage}`);
        console.log('Headers:', JSON.stringify(res.headers, null, 2));
      }
      
      // Collect the response body
      res.on('data', (chunk) => {
        responseBody += chunk;
        if (debug) {
          console.log(`Received chunk: ${chunk.length} bytes`);
        }
      });
      
      // Process the complete response
      res.on('end', () => {
        if (debug) {
          try {
            // Try to parse as JSON for prettier logging
            const parsed = JSON.parse(responseBody);
            console.log('Body (JSON):', JSON.stringify(parsed, null, 2));
          } catch {
            // If not JSON, log as text with length
            console.log(`Body (Text - ${responseBody.length} bytes):`);
            if (responseBody.length < 1000) {
              console.log(responseBody);
            } else {
              console.log(responseBody.substring(0, 1000) + '... [truncated]');
            }
          }
          console.log('---------------------------\n');
        }
        
        // Check for error status codes
        if (res.statusCode && (res.statusCode < 200 || res.statusCode >= 300)) {
          const error: any = new Error(`HTTP ${res.statusCode}: ${res.statusMessage}`);
          error.statusCode = res.statusCode;
          error.headers = res.headers;
          error.body = responseBody;
          
          // Special handling for common error codes
          switch (res.statusCode) {
            case 401:
              // For 401 errors, extract resource metadata from WWW-Authenticate header
              if (res.headers['www-authenticate']) {
                const wwwAuth = res.headers['www-authenticate'] as string;
                error.authHeader = wwwAuth;
                
                // Extract the resource metadata URI
                const metadataMatch = wwwAuth.match(/resource_metadata_uri="([^"]+)"/);
                if (metadataMatch && metadataMatch[1]) {
                  error.resourceMetadataUri = metadataMatch[1];
                  console.log('\nAuthentication required:');
                  console.log(`WWW-Authenticate: ${wwwAuth}`);
                  console.log(`Resource metadata available at: ${metadataMatch[1]}`);
                  console.log('Please run "auth login" to authenticate');
                }
              }
              break;
              
            case 403:
              console.log('\nAuthorization failed: Insufficient permissions');
              try {
                const errorBody = JSON.parse(responseBody);
                if (errorBody?.error?.message) {
                  console.log(`Error details: ${errorBody.error.message}`);
                }
              } catch {}
              break;
              
            case 400:
              console.log('\nBad request: The server could not understand the request');
              try {
                const errorBody = JSON.parse(responseBody);
                if (errorBody?.error?.message) {
                  console.log(`Error details: ${errorBody.error.message}`);
                }
              } catch {}
              break;
              
            case 429:
              console.log('\nToo many requests: Rate limit exceeded');
              // Check for Retry-After header
              if (res.headers['retry-after']) {
                console.log(`Please retry after ${res.headers['retry-after']} seconds`);
              }
              break;
              
            case 500:
            case 502:
            case 503:
            case 504:
              console.log('\nServer error: The server encountered an error processing the request');
              break;
          }
          
          reject(error);
          return;
        }
        
        // Extract all headers
        const responseHeaders: Record<string, string> = {};
        Object.keys(res.headers).forEach(key => {
          const value = res.headers[key];
          if (value !== undefined) {
            responseHeaders[key] = Array.isArray(value) ? value[0] : value;
          }
        });
        
        // Resolve with the complete response
        resolve({
          statusCode: res.statusCode || 200,
          headers: responseHeaders,
          body: responseBody
        });
      });
    });
    
    // Handle request errors
    req.on('error', (error: NodeJS.ErrnoException) => {
      console.error(`Network error: ${error.message}`);
      
      // Special handling for common network errors
      if (error.code === 'ECONNREFUSED') {
        console.log('Could not connect to the server. Please check:');
        console.log('1. Is the server running?');
        console.log('2. Is the URL correct?');
        console.log('3. Is there a firewall blocking the connection?');
      } else if (error.code === 'ENOTFOUND') {
        console.log('Could not resolve the hostname. Please check:');
        console.log('1. Is the URL correct?');
        console.log('2. Is your internet connection working?');
      } else if (error.code === 'ETIMEDOUT') {
        console.log('The connection timed out. Please check:');
        console.log('1. Is the server running?');
        console.log('2. Is the network slow or overloaded?');
      }
      
      reject(error);
    });
    
    // Send the request body if provided
    if (body) {
      const bodyData = typeof body === 'string' ? body : JSON.stringify(body);
      req.write(bodyData);
    }
    
    // End the request
    req.end();
  });
}

/**
 * Determine if content is in MCP Streamable-HTTP format
 * 
 * @param content - Content to check for streaming format
 * @returns boolean indicating if content appears to be in streaming format
 */
export function isStreamingFormat(content: string): boolean {
  // Check for MCP Streamable-HTTP format indicators
  return content.trim().startsWith('event:') || 
         content.includes('\nevent:') || 
         content.includes('\ndata:');
}

/**
 * Parse Streamable-HTTP formatted messages
 * Extracts data from MCP's streaming format, handling both single and multi-line events
 * 
 * @param streamContent - Raw streaming content from server
 * @returns Array of parsed JSON objects extracted from data fields
 */
export function parseStreamingMessages(streamContent: string): any[] {
  const results: any[] = [];
  
  // Split the content into individual event blocks
  const eventBlocks = streamContent.split(/\n\n+/g).filter(block => block.trim());
  
  for (const block of eventBlocks) {
    const lines = block.split('\n');
    let dataContent = '';
    let eventType = '';
    let eventId = '';
    
    for (const line of lines) {
      if (line.startsWith('data:')) {
        dataContent = line.substring(5).trim();
      } else if (line.startsWith('event:')) {
        eventType = line.substring(6).trim();
      } else if (line.startsWith('id:')) {
        eventId = line.substring(3).trim();
      }
    }
    
    if (dataContent) {
      try {
        const parsedData = JSON.parse(dataContent);
        results.push(parsedData);
      } catch (e) {
        console.warn(`Could not parse SSE data as JSON: ${dataContent}`);
        // Still add the raw data if we can't parse it
        results.push({ rawData: dataContent });
      }
    }
  }
  
  return results;
}

/**
 * Creates an MCP initialize request object
 */
export function createInitializeRequest(clientName: string, clientVersion: string): McpRequest {
  return {
    jsonrpc: '2.0',
    method: 'initialize',
    params: {
      clientInfo: { 
        name: clientName,
        version: clientVersion
      },
      protocolVersion: '2025-03-26',
      capabilities: {}
    },
    id: 'init-1'
  };
}

/**
 * Creates an MCP tools/list request object
 */
export function createListToolsRequest(): McpRequest {
  return {
    jsonrpc: '2.0',
    method: 'tools/list',
    params: {},
    id: 'tools-1'
  };
}

/**
 * Creates an MCP tools/call request object
 */
export function createToolCallRequest(toolName: string, args: Record<string, any> = {}): McpRequest {
  return {
    jsonrpc: '2.0',
    method: 'tools/call',
    params: {
      name: toolName,
      arguments: args
    },
    id: `tool-${Date.now()}`
  };
}

/**
 * Creates an MCP resources/list request object
 */
export function createListResourcesRequest(): McpRequest {
  return {
    jsonrpc: '2.0',
    method: 'resources/list',
    params: {},
    id: 'resources-1'
  };
}