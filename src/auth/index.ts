/**
 * Authorization Module Index
 * 
 * This file exports the authorization methods supported by the MCP server.
 * It provides a factory function to create the appropriate authorizer based on configuration.
 */

import { CognitoAuthorizer, createCognitoAuthorizer } from './cognito';
import { LambdaAuthorizer, createLambdaAuthorizer } from './lambdaAuth';

/**
 * Creates an authorizer based on the specified type
 * 
 * @param type The type of authorizer to create ('oauth' or 'lambda')
 * @returns The appropriate authorizer instance
 */
export function createAuthorizer(type: 'oauth' | 'lambda') {
  if (type === 'oauth') {
    return createCognitoAuthorizer();
  } else {
    return createLambdaAuthorizer();
  }
}

export { CognitoAuthorizer, LambdaAuthorizer };
