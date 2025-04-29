import os
import json

def lambda_handler(event, context):
    print(f"Received event: {json.dumps(event)}") # Log the event to see its structure

    # --- Get ARN --- 
    # Try methodArn first (REST API), then routeArn (HTTP API)
    method_arn = event.get('methodArn') 
    if not method_arn:
        print("Could not find 'methodArn' in the event. Trying 'routeArn'.")
        method_arn = event.get('routeArn')
        if not method_arn:
             print("Could not find 'methodArn' or 'routeArn'. Cannot generate policy.")
             # Return an unauthorized response for HTTP API Lambda authorizers instead of raising Exception
             # Raising an exception results in a 500 error for the client
             return {"isAuthorized": False} 
             # For REST API: raise Exception('Unauthorized') # Or return deny policy
    print(f"Using ARN: {method_arn}")

    # --- Get Token --- 
    # For HTTP API REQUEST authorizer (Payload 2.0), the identity source is an array
    raw_auth_header = None
    identity_source = event.get('identitySource')
    if identity_source and isinstance(identity_source, list) and len(identity_source) > 0:
        raw_auth_header = identity_source[0]
        print(f"Found identitySource value: {raw_auth_header}")
    # Check headers directly for Payload 1.0 or other cases
    elif event.get('headers'):
         # Header names might be lowercased by API Gateway
         auth_header_key = next((k for k in event['headers'] if k.lower() == 'authorization'), None)
         if auth_header_key:
             raw_auth_header = event['headers'][auth_header_key]
             print(f"Found Authorization header value: {raw_auth_header}")
         
    # Fallback check for authorizationToken (REST API Lambda Authorizer - TOKEN type)
    elif event.get('authorizationToken'):
         raw_auth_header = event.get('authorizationToken')
         print(f"Found authorizationToken value: {raw_auth_header}")
    else:
         print("Could not find token in identitySource, headers, or authorizationToken field.")

    # Extract token assuming 'Bearer <token>' format
    token = None
    if raw_auth_header:
        parts = raw_auth_header.split()
        if len(parts) == 2 and parts[0].lower() == 'bearer':
            token = parts[1]
            print("Successfully extracted Bearer token.")
        else:
             print("Authorization header format is not 'Bearer <token>'.")
             # Treat non-bearer token as invalid for this example
             pass # token remains None
    else:
        print("No raw authorization header value found.")
    
    # Check if token was extracted
    if not token:
        print("Token not found or invalid format.")
        # Return unauthorized for HTTP API simple response
        return {"isAuthorized": False}
        # For REST API: raise Exception('Unauthorized') # Or return deny policy

    # --- Placeholder for actual token validation --- 
    # Replace this with your actual token validation logic (e.g., JWT verification, DB lookup)
    print(f"Validating token (placeholder): {token}")
    is_valid_token = True # Replace with actual validation result

    if is_valid_token:
        print("Token is valid (placeholder). Authorizing request.")
        # For HTTP API simple response, just return True
        return {"isAuthorized": True} 
        # --- For REST API IAM Policy response (Example) ---
        # principal_id = "user|a1b2c3d4" # Unique identifier for the user
        # policy = AuthPolicy(principal_id, context.aws_request_id.replace('-', ''))
        # policy.restApiId = api_gateway_arn_tmp[0]
        # policy.region = api_gateway_arn_tmp[1]
        # policy.stage = api_gateway_arn_tmp[2]
        # policy.allowAllMethods() # Or specify allowed methods/resources
        # auth_response = policy.build()
        # Add context if needed:
        # auth_response['context'] = {
        #     'stringKey': 'stringval',
        #     'numberKey': 123,
        #     'booleanKey': True
        # }
        # return auth_response
    else:
        print("Token is invalid (placeholder). Denying request.")
        # Return unauthorized for HTTP API simple response
        return {"isAuthorized": False}
        # For REST API: raise Exception('Unauthorized') # Or return deny policy


# --- Example AuthPolicy class for REST API IAM Policy response ---
# (Include this class if you need to return IAM policies for REST APIs)
# class AuthPolicy(object):
#     # ... (Implementation of AuthPolicy class) ...
#     pass 