/**
 * Lambda Authorizer Integration
 * 
 * This file provides integration with the Lambda authorizer approach.
 * It creates a middleware that bypasses authorization checks in the Express app
 * since API Gateway with Lambda authorizer will handle authorization before
 * the request reaches the Lambda function.
 */
import { Request, Response, NextFunction } from 'express';
import { logger, authLogger } from '../logging';

/**
 * Configuration for Lambda authorizer integration
 */
export interface LambdaAuthConfig {
  /** Whether Lambda authorizer is enabled */
  enabled: boolean;
}

/**
 * Class for handling Lambda authorizer integration
 */
export class LambdaAuthorizer {
  private config: LambdaAuthConfig;
  private isLambda: boolean;

  /**
   * Creates a new instance of LambdaAuthorizer
   */
  constructor(config: LambdaAuthConfig) {
    this.config = config;
    this.isLambda = !!process.env.LAMBDA_TASK_ROOT;
    
    console.log(`Initialized Lambda Authorizer with enabled=${config.enabled}`);
  }

  /**
   * Creates a middleware that bypasses authorization checks
   * since API Gateway with Lambda authorizer will handle authorization
   * before the request reaches the Lambda function.
   */
  createAuthMiddleware() {
    return async (req: Request, res: Response, next: NextFunction) => {
      try {
        authLogger.debug({
          message: 'Lambda authorizer middleware processing request',
          path: req.path,
          method: req.method,
          hasAuthHeader: !!req.headers.authorization
        });
        
        // In Lambda environment, API Gateway with Lambda authorizer
        // will handle authorization before the request reaches this function
        if (this.isLambda) {
          authLogger.debug('Running in Lambda environment - authorization handled by API Gateway');
          next();
          return;
        }
        
        // In development environment, we can do basic validation
        // or just pass through for testing purposes
        const token = this.extractToken(req);
        if (!token) {
          authLogger.debug('No token found in authorization header');
          return this.handleUnauthorized(req, res, 'Bearer token missing');
        }
        
        // For development, we accept any token
        // In production, the Lambda authorizer will handle validation
        authLogger.info({
          message: 'Development mode: Accepting token without validation',
          token: token.substring(0, 8) + '...'
        });
        
        next();
      } catch (error) {
        authLogger.error({
          message: 'Error in Lambda authorizer middleware',
          error
        });
        
        return this.handleUnauthorized(req, res, error);
      }
    };
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
   * Handle unauthorized access
   */
  handleUnauthorized(req: Request, res: Response, error?: string | Error) {
    const errorMsg = error instanceof Error ? error.message : error;
    
    authLogger.debug({
      message: 'Sending unauthorized response',
      error: errorMsg
    });
    
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
 * Creates a configured Lambda authorizer
 */
export function createLambdaAuthorizer(): LambdaAuthorizer {
  return new LambdaAuthorizer({
    enabled: true
  });
}
