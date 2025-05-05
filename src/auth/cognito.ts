import type { JWTVerifyResult } from 'jose';
import { Request } from 'express';

import jwksClient from 'jwks-rsa';
import * as https from 'https';
import { promisify } from 'util';
import { logger, authLogger } from '../logging';

/**
 * Configuration for AWS Cognito integration
 */
export interface CognitoConfig {
  /** AWS Cognito Region */
  region: string;
  /** AWS Cognito User Pool ID */
  userPoolId: string;
  /** Client IDs allowed to access this server */
  allowedClientIds: string[];
  /** Resource server identifier (e.g., API identifier in Cognito) */
  resourceId?: string;
  /** Required scopes (if any) */
  requiredScopes?: string[];
}

/**
 * Creates the JWKS URL for a given Cognito user pool
 */
function getJwksUrl(region: string, userPoolId: string): string {
  return `https://cognito-idp.${region}.amazonaws.com/${userPoolId}/.well-known/jwks.json`;
}

interface JWK {
  alg: string;
  e: string;
  kid: string;
  kty: string;
  n: string;
  use: string;
}

interface JWKS {
  keys: JWK[];
}

/**
 * Class for handling Cognito JWT verification
 */
export class CognitoAuthorizer {
  private jwksUrl: string;
  private jwksClient: any;
  private config: CognitoConfig;
  private issuer: string;
  private isLambda: boolean;
  private jwksCache: JWKS | null = null;
  private jwksCacheTime = 0;
  private readonly jwksCacheMaxAge = 3600000; // 1 hour in milliseconds

  /**
   * Creates a new instance of CognitoAuthorizer
   */
  constructor(config: CognitoConfig) {
    this.config = config;
    this.jwksUrl = getJwksUrl(config.region, config.userPoolId);
    this.issuer = `https://cognito-idp.${config.region}.amazonaws.com/${config.userPoolId}`;
    this.isLambda = !!process.env.LAMBDA_TASK_ROOT;
    
    // Use jwks-rsa client which is CommonJS compatible
    this.jwksClient = jwksClient({
      jwksUri: this.jwksUrl,
      cache: true,
      cacheMaxEntries: 5,
      cacheMaxAge: 600000 // 10 minutes
    });
    
    console.log(`Initialized Cognito Authorizer with JWKS URL: ${this.jwksUrl}`);
  }

  /**
   * Extracts the authorization token from the request headers
   */
  extractToken(req: Request): string | null {
    const authHeader = req.headers.authorization;
    if (!authHeader || !authHeader.startsWith('Bearer ')) {
      return null;
    }
    
    return authHeader.substring(7);
  }

  /**
   * Fetch the JSON Web Key Set (JWKS) from the Cognito endpoint
   * Uses a memory cache to avoid frequent network requests
   * 
   * @returns Promise resolving to the JWKS
   * @throws Error if fetching the JWKS fails
   */
  private async fetchJWKS(): Promise<JWKS> {
    try {
      // Use cached JWKS if available and not expired
      const now = Date.now();
      if (this.jwksCache && now - this.jwksCacheTime < this.jwksCacheMaxAge) {
        return this.jwksCache;
      }

      authLogger.debug('Fetching JWKS from Cognito', { url: this.jwksUrl });
      
      // Fetch the JWKS with a Promise-based approach
      const jwksData = await new Promise<JWKS>((resolve, reject) => {
        https.get(this.jwksUrl, (res) => {
          if (res.statusCode !== 200) {
            reject(new Error(`Failed to fetch JWKS: HTTP ${res.statusCode}`));
            return;
          }
          
          let data = '';
          res.on('data', (chunk) => {
            data += chunk;
          });
          
          res.on('end', () => {
            try {
              const jwks = JSON.parse(data) as JWKS;
              resolve(jwks);
            } catch (e) {
              reject(new Error(`Failed to parse JWKS: ${e instanceof Error ? e.message : String(e)}`));
            }
          });
        }).on('error', (e) => {
          reject(new Error(`Failed to fetch JWKS: ${e.message}`));
        });
      });
      
      // Update the cache
      this.jwksCache = jwksData;
      this.jwksCacheTime = now;
      
      authLogger.debug('Successfully fetched JWKS', { 
        keyCount: jwksData.keys.length,
        firstKeyId: jwksData.keys[0]?.kid
      });
      
      return jwksData;
    } catch (error) {
      authLogger.error('Error fetching JWKS', { 
        error: error instanceof Error ? error.message : String(error),
        url: this.jwksUrl
      });
      throw error;
    }
  }
  
  /**
   * Verify the signature of a JWT token using the RSA public key from JWKS
   * 
   * @param token - The JWT token to verify
   * @param header - The parsed JWT header containing the key ID (kid)
   * @param signature - The signature part of the JWT
   * @returns Promise resolving to boolean indicating if signature is valid
   * @throws Error if verification fails
   */
  private async verifySignature(token: string, header: any, signature: Buffer): Promise<boolean> {
    try {
      // Get the signing key from JWKS using the key ID in the token header
      const kid = header.kid;
      if (!kid) {
        throw new Error('Token header missing key ID (kid)');
      }
      
      // Fetch JWKS and find the matching key
      const jwks = await this.fetchJWKS();
      const key = jwks.keys.find(k => k.kid === kid);
      
      if (!key) {
        throw new Error(`Unable to find key with ID: ${kid}`);
      }
      
      // If the key is not an RSA key or not for signature verification
      if (key.kty !== 'RSA' || key.use !== 'sig') {
        throw new Error(`Invalid key type: ${key.kty} or use: ${key.use}`);
      }
      
      // Use the jwks-rsa client to get the signing key
      const getSigningKey = promisify(this.jwksClient.getSigningKey).bind(this.jwksClient);
      const signingKey = await getSigningKey(kid);
      const publicKey = signingKey.getPublicKey();
      
      // Verify the token with the public key
      // Using Node's built-in crypto for verification
      const crypto = require('crypto');
      const verifier = crypto.createVerify('RSA-SHA256');
      
      // The content to verify is the header and payload parts of the JWT
      const parts = token.split('.');
      const signedContent = parts[0] + '.' + parts[1];
      verifier.update(signedContent);
      
      // Verify the signature
      return verifier.verify(
        publicKey, 
        signature,
        'base64url'
      );
    } catch (error) {
      authLogger.error('Signature verification failed', { 
        error: error instanceof Error ? error.message : String(error)
      });
      throw error;
    }
  }
  
  /**
   * Verifies a JWT token against the Cognito JWKS
   * 
   * This method validates the token format, expiration, signature,
   * and checks additional claims like token_use, client_id, and required scopes.
   * 
   * @param token - The JWT token to verify
   * @returns A promise resolving to the verification result with payload and header
   * @throws Error if the token is invalid, expired, or missing required claims
   */
  async verifyToken(token: string): Promise<any> {
    try {
      authLogger.debug('Starting JWT token verification');
      
      // Basic token format validation
      const tokenParts = token.split('.');
      if (tokenParts.length !== 3) {
        authLogger.warn('Invalid token format (not three parts)');
        throw new Error('Invalid token format');
      }
      
      // Decode header
      let header: any;
      try {
        const headerJson = Buffer.from(tokenParts[0], 'base64url').toString('utf8');
        header = JSON.parse(headerJson);
      } catch (e) {
        authLogger.warn('Failed to parse token header');
        throw new Error('Invalid token header');
      }
      
      // Verify token algorithm
      if (header.alg !== 'RS256') {
        authLogger.warn(`Unsupported token algorithm: ${header.alg}`);
        throw new Error(`Unsupported token algorithm: ${header.alg}`);
      }
      
      // Decode payload
      let payload: any;
      try {
        const payloadJson = Buffer.from(tokenParts[1], 'base64url').toString('utf8');
        payload = JSON.parse(payloadJson);
      } catch (e) {
        authLogger.warn('Failed to parse token payload');
        throw new Error('Invalid token payload');
      }
      
      // Decode signature
      let signature: Buffer;
      try {
        signature = Buffer.from(tokenParts[2], 'base64url');
      } catch (e) {
        authLogger.warn('Failed to decode token signature');
        throw new Error('Invalid token signature');
      }
      
      // Log token info (redacted for security)
      authLogger.debug('Token info', {
        iss: payload.iss,
        sub: typeof payload.sub === 'string' ? payload.sub.substring(0, 8) + '...' : undefined,
        client_id: payload.client_id,
        token_use: payload.token_use,
        exp: payload.exp,
        iat: payload.iat,
        username: typeof payload.username === 'string' ? payload.username.substring(0, 3) + '...' : undefined
      });
      
      // Verify expiration
      const nowInSeconds = Math.floor(Date.now() / 1000);
      if (!payload.exp) {
        authLogger.warn('Token missing expiration claim');
        throw new Error('Token missing expiration time');
      }
      
      if (payload.exp < nowInSeconds) {
        const expiredAt = new Date(payload.exp * 1000).toISOString();
        const currentTime = new Date().toISOString();
        authLogger.warn(`Token expired at ${expiredAt}, current time is ${currentTime}`);
        throw new Error(`Token expired at ${expiredAt}`);
      }
      
      // Verify not before (nbf) if present
      if (payload.nbf && payload.nbf > nowInSeconds) {
        const notBefore = new Date(payload.nbf * 1000).toISOString();
        const currentTime = new Date().toISOString();
        authLogger.warn(`Token not valid until ${notBefore}, current time is ${currentTime}`);
        throw new Error(`Token not valid until ${notBefore}`);
      }
      
      // Verify issuer if configured
      if (this.config.userPoolId) {
        const expectedIssuer = `https://cognito-idp.${this.config.region}.amazonaws.com/${this.config.userPoolId}`;
        if (payload.iss !== expectedIssuer) {
          authLogger.warn(`Invalid token issuer: ${payload.iss}, expected: ${expectedIssuer}`);
          throw new Error(`Invalid token issuer: ${payload.iss}`);
        }
      }
      
      // FULL SIGNATURE VERIFICATION WITH JWKS
      authLogger.debug('Verifying token signature with JWKS');
      const isSignatureValid = await this.verifySignature(token, header, signature);
      
      if (!isSignatureValid) {
        authLogger.warn('Invalid token signature');
        throw new Error('Invalid token signature');
      }
      
      // Create a result similar to jose's jwtVerify
      const result = {
        payload: payload,
        protectedHeader: header
      };
      
      // Validate additional claims
      authLogger.debug('Validating additional token claims');
      
      // Check for token_use (must be 'access')
      if (payload.token_use !== 'access') {
        authLogger.warn(`Invalid token use: ${payload.token_use} (expected 'access')`);
        throw new Error(`Invalid token use: ${payload.token_use}`);
      }
      
      // Check client ID is in allowed list
      if (payload.client_id && !this.config.allowedClientIds.includes(payload.client_id as string)) {
        authLogger.warn(`Unauthorized client ID: ${payload.client_id}`);
        throw new Error(`Unauthorized client ID: ${payload.client_id}`);
      }
      
      // Check required scopes
      if (this.config.requiredScopes && this.config.requiredScopes.length > 0) {
        const tokenScopes = typeof payload.scope === 'string' 
          ? payload.scope.split(' ') 
          : [];
        
        authLogger.debug('Checking token scopes', {
          tokenScopes,
          requiredScopes: this.config.requiredScopes
        });
        
        const hasAllRequiredScopes = this.config.requiredScopes.every(
          scope => tokenScopes.includes(scope)
        );
        
        if (!hasAllRequiredScopes) {
          authLogger.warn('Token missing required scopes');
          throw new Error('Token missing required scopes');
        }
      }
      
      authLogger.debug('Token verification completed successfully');
      return result;
    } catch (error) {
      authLogger.error('Token verification failed', { error });
      throw error;
    }
  }

  /**
   * Authorized middleware factory for Express
   * 
   * Creates an Express middleware function that validates JWT tokens
   * from the Authorization header and attaches the verified claims to the request.
   * 
   * @returns Express middleware function for authentication
   */
  createAuthMiddleware() {
    return async (req: Request, res: any, next: any) => {
      try {
        authLogger.debug({
          message: 'Processing authentication for request',
          path: req.path,
          method: req.method,
          hasAuthHeader: !!req.headers.authorization
        });
        
        const token = this.extractToken(req);
        if (!token) {
          authLogger.debug('No token found in authorization header');
          return this.handleUnauthorized(req, res, 'Bearer token missing');
        }
        
        authLogger.debug('Token extracted, attempting verification');
        const verifyResult = await this.verifyToken(token);
        
        authLogger.info({
          message: 'Token verified successfully',
          subject: verifyResult.payload.sub,
          username: verifyResult.payload.username,
          clientId: verifyResult.payload.client_id,
          tokenUse: verifyResult.payload.token_use
        });
        
        // Attach the verified claims to the request for later use
        (req as any).user = verifyResult.payload;
        
        // Attach helper method to check scopes
        (req as any).hasScope = (scope: string): boolean => {
          const tokenScopes = typeof verifyResult.payload.scope === 'string' 
            ? verifyResult.payload.scope.split(' ') 
            : [];
            
          return tokenScopes.includes(scope);
        };
        
        next();
      } catch (error) {
        authLogger.error({
          message: 'Authentication failed',
          error
        });
        
        return this.handleUnauthorized(req, res, error);
      }
    };
  }

  /**
   * Handle unauthorized access according to the MCP Auth specification
   * 
   * This method generates a proper WWW-Authenticate header as required by the MCP Auth spec,
   * including the resource metadata URI and optional error information.
   * 
   * @param req - The Express request object
   * @param res - The Express response object
   * @param error - Optional error message or object to include in the response
   * @returns The response object with appropriate status and headers
   */
  handleUnauthorized(req: Request, res: any, error?: string | Error) {
    // Get the protocol and host from request headers or config
    const defaultProtocol = this.isLambda ? 'https' : 'http';
    const protocol = req.headers['x-forwarded-proto'] || defaultProtocol;
    const host = req.headers.host || req.hostname;
    
    // Get the stage from the request path or environment
    let stage = '';
    
    // If running in Lambda with API Gateway, we need the stage name
    if (this.isLambda) {
      // Extract from original URL if available
      const url = req.originalUrl || req.url || '';
      
      // Check if URL starts with a stage path like /prod/
      if (url.startsWith('/prod/')) {
        stage = '/prod';
      } else {
        // Default to /prod for Lambda environments
        stage = '/prod';
      }
    }
    
    // Construct the resource metadata URL with stage if needed
    const resourceMetadataUrl = `${protocol}://${host}${stage}/.well-known/oauth-protected-resource`;
    
    // Build the WWW-Authenticate header according to RFC7235 and OAuth 2.0 specs
    let wwwAuthHeader = `Bearer realm="${this.issuer}", resource_metadata_uri="${resourceMetadataUrl}"`;
    
    // Add error details if provided
    if (error) {
      const errorMsg = error instanceof Error ? error.message : error;
      wwwAuthHeader += `, error="invalid_token", error_description="${errorMsg}"`;
    }
    
    // Log the response for debugging
    authLogger.debug({
      message: 'Sending unauthorized response',
      resourceMetadataUrl,
      error: error instanceof Error ? error.message : error,
      headers: {
        'WWW-Authenticate': wwwAuthHeader
      }
    });
    
    // Set WWW-Authenticate header as required by MCP Auth
    res.setHeader('WWW-Authenticate', wwwAuthHeader);
    
    // Add CORS headers to ensure the client can read the response
    res.setHeader('Access-Control-Allow-Origin', '*');
    res.setHeader('Access-Control-Allow-Headers', 'Authorization, Content-Type');
    res.setHeader('Access-Control-Expose-Headers', 'WWW-Authenticate');
    
    // Return a JSON-RPC 2.0 error response
    return res.status(401).json({
      jsonrpc: '2.0',
      error: {
        code: -32001,
        message: error instanceof Error ? 
          `Unauthorized: ${error.message}` : 
          'Unauthorized: Bearer token required',
      },
      id: null,
    });
  }
}

/**
 * Creates a configured Cognito authorizer based on environment variables
 */
export function createCognitoAuthorizer(): CognitoAuthorizer {
  const region = process.env.COGNITO_REGION || 'us-east-1'; 
  const userPoolId = process.env.COGNITO_USER_POOL_ID || 'us-east-1_IgrnjnCts';
  
  // Parse allowed client IDs
  const clientIds = (process.env.COGNITO_ALLOWED_CLIENT_IDS || 
    '7dmhq1mos3d41k85u10inppvvi,3o7qjhi1d6nap68pdnrobgdurh').split(',');
  
  // Optional scopes
  const scopes = process.env.COGNITO_REQUIRED_SCOPES?.split(',') || [];
  
  return new CognitoAuthorizer({
    region,
    userPoolId,
    allowedClientIds: clientIds,
    requiredScopes: scopes,
    resourceId: process.env.COGNITO_RESOURCE_ID,
  });
}