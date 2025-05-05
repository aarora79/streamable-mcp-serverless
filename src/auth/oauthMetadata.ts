/**
 * Implementation of OAuth 2.0 Protected Resource Metadata (RFC9728)
 * https://datatracker.ietf.org/doc/html/rfc9728
 * 
 * This implementation provides the discovery mechanism for OAuth 2.0 clients
 * to locate the appropriate authorization server for a protected resource.
 */

import { Request, Response } from 'express';
import { logger, authLogger } from '../logging';

/**
 * OAuth 2.0 Protected Resource Metadata configuration
 */
export interface ResourceMetadataConfig {
  /** Resource identifier */
  resourceId: string;
  /** List of authorization servers */
  authorizationServers: AuthorizationServer[];
  /** Additional metadata properties */
  additionalMetadata?: Record<string, any>;
}

/**
 * Authorization server configuration
 */
export interface AuthorizationServer {
  /** The authorization server URL (issuer) */
  url: string;
  /** Authorization server metadata URL (optional, will be derived if not provided) */
  metadataUrl?: string;
  /** Authorization scopes required for this resource (optional) */
  scopes?: string[];
}

/**
 * Creates a response handler for the /.well-known/oauth-protected-resource endpoint
 * according to RFC9728 (OAuth 2.0 Protected Resource Metadata)
 */
export function createResourceMetadataHandler(config: ResourceMetadataConfig) {
  return (req: Request, res: Response) => {
    try {
      authLogger.debug({ 
        message: 'Resource metadata request received', 
        path: req.path, 
        method: req.method,
        ip: req.ip
      });
      
      // Build the OAuth 2.0 Protected Resource Metadata response
      const metadata = {
        resource: config.resourceId,
        authorization_servers: config.authorizationServers.map(server => {
          // If metadataUrl is not provided, construct it from the server URL
          const metadataUrl = server.metadataUrl || 
            `${server.url}/.well-known/oauth-authorization-server`;
          
          const serverEntry: Record<string, any> = {
            issuer: server.url,
            authorization_server_metadata_url: metadataUrl
          };
          
          // Include scopes if provided
          if (server.scopes && server.scopes.length > 0) {
            serverEntry.scopes_supported = server.scopes;
          }
          
          return serverEntry;
        }),
        ...config.additionalMetadata
      };
      
      // Set CORS headers to ensure the metadata is accessible from any origin
      res.header('Access-Control-Allow-Origin', '*');
      res.header('Access-Control-Allow-Methods', 'GET, OPTIONS');
      res.header('Access-Control-Allow-Headers', 'Content-Type, Authorization');
      res.header('Access-Control-Max-Age', '86400'); // 24 hours
      
      // Set cache-control to enable caching (recommended by RFC9728)
      res.header('Cache-Control', 'public, max-age=3600');
      
      // Set content type to application/json
      res.header('Content-Type', 'application/json');
      
      authLogger.debug({ 
        message: 'Returning resource metadata', 
        resourceId: config.resourceId,
        authServers: config.authorizationServers.length
      });
      
      // Return the metadata as JSON
      res.json(metadata);
    } catch (error) {
      authLogger.error({ 
        message: 'Error generating OAuth resource metadata', 
        error 
      });
      
      // Return a properly formatted OAuth error response
      res.status(500).json({
        error: 'server_error',
        error_description: 'An error occurred while generating the OAuth resource metadata'
      });
    }
  };
}

/**
 * Creates default resource metadata configuration from environment variables
 */
export function getDefaultResourceMetadataConfig(): ResourceMetadataConfig {
  const region = process.env.COGNITO_REGION || 'us-east-1';
  const userPoolId = process.env.COGNITO_USER_POOL_ID || 'us-east-1_IgrnjnCts';
  // Construct the Cognito domain following the format: 
  // https://{domain-prefix}.auth.{region}.amazoncognito.com
  // For user pool IDs like 'us-east-1_IgrnjnCts', the domain prefix should be 'us-east-1-igrnjncts'
  let userPoolDomain = process.env.COGNITO_DOMAIN;
  
  if (!userPoolDomain) {
    // If domain isn't set, construct it from user pool ID
    const parts = userPoolId.split('_');
    if (parts.length === 2) {
      const regionPrefix = parts[0];
      const idPart = parts[1].toLowerCase();
      userPoolDomain = `${regionPrefix}-${idPart}.auth.${region}.amazoncognito.com`;
    } else {
      // Fallback if format is unexpected
      userPoolDomain = `${userPoolId.toLowerCase().replace('_', '-')}.auth.${region}.amazoncognito.com`;
    }
  } else if (!userPoolDomain.includes('.auth.') && !userPoolDomain.includes('.amazoncognito.com')) {
    // If domain is provided but doesn't include the full domain suffix, add it
    // This handles cases where just the prefix is provided (e.g., "us-east-1-igrnjncts")
    userPoolDomain = `${userPoolDomain}.auth.${region}.amazoncognito.com`;
  }
  
  // Log the constructed domain for debugging
  logger.debug(`Using Cognito domain: ${userPoolDomain}`);
  
  // Get the resource ID (API identifier)
  const resourceId = process.env.COGNITO_RESOURCE_ID || 'mcp-server-api';
  
  // Build the authorization server URL
  const authServerUrl = `https://${userPoolDomain}`;
  
  // Get supported scopes from environment variables or use defaults
  const scopes = process.env.COGNITO_SUPPORTED_SCOPES ? 
    process.env.COGNITO_SUPPORTED_SCOPES.split(',') : 
    ['openid', 'profile', 'email'];
  
  // Log the configuration
  logger.info('Creating default OAuth 2.0 Protected Resource Metadata configuration', {
    resourceId,
    authServerUrl,
    region,
    userPoolId
  });
  
  // For Cognito, we need to provide both the domain URL and the service URL
  // The OIDC discovery endpoint is available at the service URL, not the domain URL
  const serviceUrl = `https://cognito-idp.${region}.amazonaws.com/${userPoolId}`;
  
  return {
    resourceId,
    authorizationServers: [
      {
        url: authServerUrl,
        // Use Cognito-specific metadata URL format for OpenID Connect discovery
        metadataUrl: `${serviceUrl}/.well-known/openid-configuration`,
        scopes
      }
    ],
    additionalMetadata: {
      protocol_version: "2025-03-26",
      description: "MCP Server Protected Resource",
      api_documentation: "https://modelcontextprotocol.io/specification/draft/basic/authorization"
    }
  };
}