#!/usr/bin/env python3
import argparse
import boto3
import time
import sys
import subprocess
import os
import random
import json
import uuid
import zipfile
import io

def wait_for_function_update_completion(lambda_client, function_name):
    """
    Wait for a Lambda function to complete any in-progress updates.
    
    Args:
        lambda_client: The boto3 Lambda client
        function_name: The name of the Lambda function
    """
    max_attempts = 30
    for attempt in range(max_attempts):
        try:
            # Get the current state of the function
            response = lambda_client.get_function(FunctionName=function_name)
            last_update_status = response['Configuration'].get('LastUpdateStatus')
            
            # If LastUpdateStatus is not present or is "Successful", the update is complete
            if not last_update_status or last_update_status == 'Successful':
                print(f"Function update completed successfully")
                return True
            
            # If the update failed, report the error
            if last_update_status == 'Failed':
                failure_reason = response['Configuration'].get('LastUpdateStatusReason', 'Unknown error')
                print(f"Function update failed: {failure_reason}")
                return False
            
            # Still in progress, wait and retry
            print(f"Function update status: {last_update_status}. Waiting...")
            time.sleep(2)
            
        except Exception as e:
            # Specific check for ThrottlingException to avoid unnecessary retries
            if hasattr(e, 'response') and e.response.get('Error', {}).get('Code') == 'ThrottlingException':
                print(f"Throttling exception encountered: {str(e)}. Waiting before retry...")
                time.sleep(5 + random.random()) # Wait a bit longer for throttling
            elif isinstance(e, lambda_client.exceptions.ResourceNotFoundException):
                 print(f"Function {function_name} not found during status check.")
                 return False # Function doesn't exist, can't complete update
            else:
                print(f"Error checking function status: {str(e)}")
                time.sleep(2) # General retry delay
    
    print(f"Timed out waiting for function update to complete")
    return False


def build_and_push_container():
    """
    Calls the build_and_push.sh script to build and push a Docker container to ECR.
    
    Returns:
        str: The ECR image URI if successful, None otherwise
    """
    print("=" * 80)
    print("No image URI provided. Building and pushing container to ECR...")
    print("=" * 80)
    
    try:
        # Ensure the script is executable
        script_path = "./build_and_push.sh"
        if not os.path.isfile(script_path):
            raise FileNotFoundError(f"Script {script_path} not found. Please make sure it exists in the current directory.")
        
        # Execute the build_and_push.sh script
        result = subprocess.run(
            [script_path], 
            stdout=subprocess.PIPE, 
            stderr=subprocess.PIPE,
            text=True,
            check=True
        )
        
        # Extract the ECR image URI from the script output
        # Assuming the script outputs the ECR URI as the last line or in a specific format
        output_lines = result.stdout.strip().split('\n')
        ecr_uri = output_lines[-1].strip()
        
        # Validate the URI (basic check)
        if not (ecr_uri.startswith("https://") or
                ".dkr.ecr." in ecr_uri or
                ".amazonaws.com/" in ecr_uri):
            print(f"Warning: The returned URI '{ecr_uri}' doesn't look like a valid ECR URI.")
            print("Full script output:")
            print(result.stdout)
            return None
        
        print(f"Successfully built and pushed container to: {ecr_uri}")
        return ecr_uri
        
    except subprocess.CalledProcessError as e:
        print(f"Error executing build_and_push.sh: {e}")
        print(f"Script output: {e.stdout}")
        print(f"Script error: {e.stderr}")
        return None
    except Exception as e:
        print(f"Error during build and push process: {str(e)}")
        return None

def deploy_authorizer_lambda(function_name, role_arn, region, runtime='python3.11', memory_size=128, timeout=30):
    """
    Deploy the Python authorizer Lambda function from src/auth/auth.py.
    
    Args:
        function_name (str): Name for the authorizer Lambda function.
        role_arn (str): ARN of the execution role (used for both Lambdas).
        region (str): AWS region.
        runtime (str): Python runtime version.
        memory_size (int): Memory in MB.
        timeout (int): Timeout in seconds.

    Returns:
        str: The ARN of the deployed authorizer Lambda function, or None on failure.
    """
    print("=" * 80)
    print(f"Deploying Authorizer Lambda function: {function_name}...")
    print("=" * 80)

    lambda_client = boto3.client('lambda', region_name=region)
    authorizer_code_path = 'src/auth/auth.py'
    handler_name = 'auth.lambda_handler' # Assuming filename is auth.py and handler is lambda_handler

    if not os.path.exists(authorizer_code_path):
        print(f"Error: Authorizer code file not found at {authorizer_code_path}")
        return None

    try:
        # Create zip file in memory
        zip_buffer = io.BytesIO()
        with zipfile.ZipFile(zip_buffer, 'w', zipfile.ZIP_DEFLATED) as zipf:
            # Add the auth.py file to the root of the zip archive
            zipf.write(authorizer_code_path, arcname=os.path.basename(authorizer_code_path))
        zip_content = zip_buffer.getvalue()

        function_exists = False
        function_arn = None
        try:
            response = lambda_client.get_function(FunctionName=function_name)
            function_exists = True
            function_arn = response['Configuration']['FunctionArn']
            print(f"Authorizer function {function_name} already exists. Updating...")
        except lambda_client.exceptions.ResourceNotFoundException:
            print(f"Authorizer function {function_name} does not exist. Creating...")

        if function_exists:
            # Update function code
            print("Updating authorizer function code...")
            response = lambda_client.update_function_code(
                FunctionName=function_name,
                ZipFile=zip_content,
                Publish=True
            )
            function_arn = response['FunctionArn'] # Update ARN potentially if versioning
            print("Waiting for authorizer code update to complete...")
            wait_for_function_update_completion(lambda_client, function_name)
            
            # Update function configuration
            print("Updating authorizer function configuration...")
            lambda_client.update_function_configuration(
                FunctionName=function_name,
                Role=role_arn,
                Handler=handler_name,
                Runtime=runtime,
                Timeout=timeout,
                MemorySize=memory_size
            )
            print("Waiting for authorizer configuration update to complete...")
            wait_for_function_update_completion(lambda_client, function_name)
            print(f"Authorizer function {function_name} updated successfully.")

        else:
            # Create new function
            print("Creating new authorizer function...")
            response = lambda_client.create_function(
                FunctionName=function_name,
                Runtime=runtime,
                Role=role_arn,
                Handler=handler_name,
                Code={'ZipFile': zip_content},
                Timeout=timeout,
                MemorySize=memory_size,
                Publish=True
            )
            function_arn = response['FunctionArn']
            print(f"Authorizer function {function_name} created successfully.")

        # Wait for the function to become active after create/update
        print("Waiting for authorizer function to become Active...")
        waiter = lambda_client.get_waiter('function_active_v2')
        waiter.wait(FunctionName=function_name)
        print(f"Authorizer function {function_name} is Active. ARN: {function_arn}")
        return function_arn

    except Exception as e:
        print(f"Error deploying authorizer Lambda function {function_name}: {str(e)}")
        return None
    finally:
        print("Authorizer Lambda deployment process completed.")

def deploy_lambda_container(ecr_image_uri, function_name, role_arn, bedrock_role_arn, region="us-east-1", memory_size=1024, timeout=90, api_gateway=False, api_name=None, stage_name="prod", enable_authorizer=False, authorizer_function_name=None):
    """
    Deploy a container from ECR as a Lambda function with optional API Gateway and optional Authorizer Lambda.
    
    Args:
        ecr_image_uri (str): URI of the ECR image to deploy
        function_name (str): Name of the main Lambda function
        role_arn (str): ARN of the Lambda execution role (used for both main and optionally authorizer)
        bedrock_role_arn (str): ARN of the role to use when invoking Bedrock models
        region (str): AWS region to deploy the Lambda function
        memory_size (int): Memory size in MB for the main Lambda function
        timeout (int): Timeout in seconds for the main Lambda function
        api_gateway (bool): Whether to create an API Gateway for the Lambda
        api_name (str): Name for the API Gateway (defaults to function-name-api)
        stage_name (str): API Gateway stage name
        enable_authorizer (bool): Whether to deploy and enable the Lambda authorizer.
        authorizer_function_name (str, optional): Name for the authorizer Lambda function (required if enable_authorizer is True)
    """
    print("=" * 80)
    print(f"Deploying Main Container Lambda function {function_name} in region {region}...")
    print("=" * 80)
    
    # Initialize the Lambda client with specified region
    lambda_client = boto3.client('lambda', region_name=region)
    
    try:
        # Check if function already exists
        try:
            lambda_client.get_function(FunctionName=function_name)
            function_exists = True
            print(f"Function {function_name} already exists. Updating...")
        except lambda_client.exceptions.ResourceNotFoundException:
            function_exists = False
            print(f"Function {function_name} does not exist. Creating new function...")
        
        # Create or update Lambda function
        if function_exists:
            # Update function code with retry logic
            max_code_retries = 5
            for attempt in range(max_code_retries):
                try:
                    response = lambda_client.update_function_code(
                        FunctionName=function_name,
                        ImageUri=ecr_image_uri,
                        Publish=True
                    )
                    print(f"Function code update initiated successfully")
                    break
                except lambda_client.exceptions.ResourceConflictException as e:
                    if attempt < max_code_retries - 1:
                        wait_time = (2 ** attempt) + (random.random() * 0.5)  # Exponential backoff with jitter
                        print(f"Update already in progress. Waiting {wait_time:.2f} seconds before retrying...")
                        time.sleep(wait_time)
                    else:
                        raise e
            
            # Wait for function code update to complete before updating configuration
            print("Waiting for function code update to complete...")
            wait_for_function_update_completion(lambda_client, function_name)
            
            # Update configuration with retry logic
            max_config_retries = 5
            for attempt in range(max_config_retries):
                try:
                    lambda_client.update_function_configuration(
                        FunctionName=function_name,
                        Timeout=timeout,
                        MemorySize=memory_size
                    )
                    print(f"Function configuration updated successfully")
                    break
                except lambda_client.exceptions.ResourceConflictException as e:
                    if attempt < max_config_retries - 1:
                        wait_time = (2 ** attempt) + (random.random() * 0.5)  # Exponential backoff with jitter
                        print(f"Update already in progress. Waiting {wait_time:.2f} seconds before retrying...")
                        time.sleep(wait_time)
                    else:
                        raise e
        else:
            # Create new function
            env = {
                'Variables': {}
            }
            if bedrock_role_arn is not None:
                env = {
                    'Variables': {
                        'BEDROCK_ROLE_ARN': bedrock_role_arn
                    }
                }
            response = lambda_client.create_function(
                FunctionName=function_name,
                PackageType='Image',
                Code={
                    'ImageUri': ecr_image_uri
                },
                Role=role_arn,
                Timeout=timeout,
                MemorySize=memory_size,
                Environment=env
            )
        
        # Wait for function to be active
        print("Waiting for Lambda function to be ready...")
        function_state = ""
        max_attempts = 10
        attempts = 0
        
        while function_state != "Active" and attempts < max_attempts:
            time.sleep(5)
            attempts += 1
            function_info = lambda_client.get_function(FunctionName=function_name)
            function_state = function_info['Configuration']['State']
            print(f"Current state: {function_state}")
        
        if function_state == "Active":
            print(f"Successfully deployed main Lambda function: {function_name}")
            function_arn = function_info['Configuration']['FunctionArn']
            print(f"Main Function ARN: {function_arn}")
            
            if api_gateway:
                authorizer_lambda_arn_to_pass = None
                # If authorizer is enabled, deploy it first
                if enable_authorizer:
                    # Validate authorizer name is provided if authorizer is enabled
                    if not authorizer_function_name:
                        print("Error: --authorizer-function-name is required when --enable-authorizer is specified.")
                        return False
                    
                    print("Authorizer enabled. Deploying authorizer Lambda...")
                    authorizer_lambda_arn_to_pass = deploy_authorizer_lambda(authorizer_function_name, role_arn, region)
                    if not authorizer_lambda_arn_to_pass:
                        print("Error: Failed to deploy the authorizer Lambda function. Aborting API Gateway deployment.")
                        return False
                else:
                    print("Authorizer not enabled. Skipping authorizer deployment.")

                # Setup API Gateway, passing authorizer ARN only if it was deployed
                return deploy_api_gateway(function_name, function_arn, region, authorizer_lambda_arn=authorizer_lambda_arn_to_pass, api_name=api_name, stage_name=stage_name)
            else:
                print("No API Gateway requested. Lambda deployment complete.")
                return True
        else:
            print(f"Function deployment did not reach Active state in time. Last state: {function_state}")
            return False
            
    except Exception as e:
        print(f"Error deploying Lambda function: {str(e)}")
        return False
    finally:
        print("Lambda deployment process completed.")
            
def deploy_api_gateway(function_name, function_arn, region, authorizer_lambda_arn=None, api_name=None, stage_name="prod"):
    """
    Deploy an API Gateway v2 HTTP API with Lambda integration and optional Lambda authorizer.
    
    Args:
        function_name (str): The backend Lambda function name
        function_arn (str): The backend Lambda function ARN
        region (str): AWS region
        authorizer_lambda_arn (str, optional): ARN of the Lambda authorizer function. If provided, enables authorization.
        api_name (str): Name for the API Gateway
        stage_name (str): API Gateway stage name
    
    Returns:
        bool: True if successful, False otherwise
    """
    if api_name is None:
        api_name = f"{function_name}-api"
    
    enable_authorization = bool(authorizer_lambda_arn) # Determine if auth is enabled
    auth_status_message = "with" if enable_authorization else "without"
    print("=" * 80)
    print(f"Deploying API Gateway ({api_name}) {auth_status_message} Lambda Authorizer for: {function_name}")
    print("=" * 80)
    
    # Initialize clients
    apigateway_client = boto3.client('apigatewayv2', region_name=region)
    lambda_client = boto3.client('lambda', region_name=region)
    sts_client = boto3.client('sts', region_name=region)
    account_id = sts_client.get_caller_identity()['Account']
    
    try:
        # Step 1: Create or get existing API
        api_id = None
        
        # Check if API already exists with this name
        try:
            response = apigateway_client.get_apis()
            for api in response.get('Items', []):
                if api['Name'] == api_name:
                    api_id = api['ApiId']
                    print(f"Found existing API Gateway: {api_id}")
                    break
        except Exception as e:
            print(f"Error checking existing APIs: {str(e)}")
        
        # Create new API if needed
        if not api_id:
            try:
                # Create HTTP API
                response = apigateway_client.create_api(
                    Name=api_name,
                    ProtocolType='HTTP',
                    CorsConfiguration={
                        'AllowOrigins': ['*'],
                        'AllowMethods': ['*'],
                        'AllowHeaders': ['*'],
                        'MaxAge': 86400
                    }
                )
                api_id = response['ApiId']
                print(f"Created new API Gateway: {api_id}")
            except Exception as e:
                print(f"Error creating API Gateway: {str(e)}")
                return False
        
        # Step 2: Create or update the Lambda Authorizer (only if enabled)
        authorizer_id = None
        if enable_authorization:
            authorizer_name = 'auth-lambda' # Hardcoded name for the authorizer resource in API Gateway
            authorizer_uri = f"arn:aws:apigateway:{region}:lambda:path/2015-03-31/functions/{authorizer_lambda_arn}/invocations"
            print(f"Enabling authorization using authorizer Lambda: {authorizer_lambda_arn}")

            try:
                # Check if authorizer already exists
                response = apigateway_client.get_authorizers(ApiId=api_id)
                for auth in response.get('Items', []):
                    if auth['Name'] == authorizer_name:
                        authorizer_id = auth['AuthorizerId']
                        print(f"Found existing authorizer: {authorizer_id}")
                        # Update the existing authorizer (ensure settings match)
                        apigateway_client.update_authorizer(
                            ApiId=api_id,
                            AuthorizerId=authorizer_id,
                            Name=authorizer_name,
                            AuthorizerType='REQUEST',
                            AuthorizerUri=authorizer_uri,
                            IdentitySource=['$request.header.Authorization'],
                            AuthorizerPayloadFormatVersion='2.0',
                            EnableSimpleResponses=True, 
                            AuthorizerResultTtlInSeconds=300 # Cache for 5 mins
                        )
                        print(f"Updated existing authorizer {authorizer_id}")
                        break

                if not authorizer_id:
                    # Create new authorizer
                    response = apigateway_client.create_authorizer(
                        ApiId=api_id,
                        Name=authorizer_name,
                        AuthorizerType='REQUEST',
                        AuthorizerUri=authorizer_uri,
                        IdentitySource=['$request.header.Authorization'],
                        AuthorizerPayloadFormatVersion='2.0',
                        EnableSimpleResponses=True, 
                        AuthorizerResultTtlInSeconds=300 # Cache for 5 mins
                    )
                    authorizer_id = response['AuthorizerId']
                    print(f"Created new Lambda authorizer: {authorizer_id}")

            except Exception as e:
                print(f"Error creating/updating Lambda authorizer: {str(e)}")
                return False

            # Step 2b: Add permission for API Gateway to invoke the *authorizer* Lambda
            try:
                authorizer_source_arn = f"arn:aws:execute-api:{region}:{account_id}:{api_id}/authorizers/{authorizer_id}"
                statement_id_auth = f'apigateway-invoke-authorizer-{api_id}'

                try:
                    # Remove potentially existing permission first
                    lambda_client.remove_permission(
                        FunctionName=authorizer_lambda_arn,
                        StatementId=statement_id_auth,
                    )
                    print(f"Removed existing invoke permission for authorizer {authorizer_lambda_arn} (StatementId: {statement_id_auth})")
                except lambda_client.exceptions.ResourceNotFoundException:
                    print(f"No existing invoke permission found for authorizer {authorizer_lambda_arn} (StatementId: {statement_id_auth}), proceeding to add.")
                except Exception as e:
                    print(f"Warning: Could not remove potentially existing permission for authorizer {authorizer_lambda_arn} (StatementId: {statement_id_auth}): {e}")
                
                lambda_client.add_permission(
                    FunctionName=authorizer_lambda_arn,
                    StatementId=statement_id_auth,
                    Action='lambda:InvokeFunction',
                    Principal='apigateway.amazonaws.com',
                    SourceArn=authorizer_source_arn
                )
                print(f"Added invoke permission for API Gateway to authorizer Lambda: {authorizer_lambda_arn}")
            except Exception as e:
                print(f"Error setting invoke permission for authorizer Lambda: {str(e)}")
                return False
        else:
            print("Authorization not enabled. Skipping authorizer setup.")

        # Step 3: Create or update integration with backend Lambda
        integration_id = None
        
        try:
            # Check for existing integrations
            response = apigateway_client.get_integrations(ApiId=api_id)
            for integration in response.get('Items', []):
                if integration.get('IntegrationUri') == function_arn:
                    integration_id = integration['IntegrationId']
                    print(f"Found existing Lambda integration: {integration_id}")
                    break
                    
            if not integration_id:
                # Create new integration
                response = apigateway_client.create_integration(
                    ApiId=api_id,
                    IntegrationType='AWS_PROXY',
                    IntegrationMethod='POST',
                    PayloadFormatVersion='2.0',
                    IntegrationUri=function_arn,
                    TimeoutInMillis=30000
                )
                integration_id = response['IntegrationId']
                print(f"Created new Lambda integration: {integration_id}")
        except Exception as e:
            print(f"Error setting up Lambda integration: {str(e)}")
            return False
            
        # Step 4: Create or update routes for the API, applying authorization if enabled
        # Define the specific routes to configure
        route_keys_to_ensure = {
            'GET /': {},
            'GET /docs': {},
            'GET /{proxy+}': {},
            'POST /{proxy+}': {}
            # '$default': {} # Removed default route
        }
        
        # Determine authorization settings for routes
        auth_config = {
            'AuthorizationType': 'CUSTOM' if enable_authorization else 'NONE'
        }
        if enable_authorization:
            auth_config['AuthorizerId'] = authorizer_id

        # Get existing routes
        existing_routes = {}
        try:
            paginator = apigateway_client.get_paginator('get_routes')
            for page in paginator.paginate(ApiId=api_id):
                for route in page.get('Items', []):
                    existing_routes[route['RouteKey']] = route['RouteId']
        except Exception as e:
            print(f"Warning: Could not retrieve existing routes: {str(e)}")

        for route_key, config in route_keys_to_ensure.items():
            try:
                target = f'integrations/{integration_id}'
                if route_key in existing_routes:
                    route_id = existing_routes[route_key]
                    print(f"Updating existing route: {route_key} (ID: {route_id})")
                    apigateway_client.update_route(
                        ApiId=api_id,
                        RouteId=route_id,
                        RouteKey=route_key,
                        Target=target,
                        **auth_config # Apply CUSTOM/NONE + AuthorizerId if applicable
                    )
                else:
                     print(f"Creating route: {route_key}")
                     response = apigateway_client.create_route(
                         ApiId=api_id,
                         RouteKey=route_key,
                         Target=target,
                        **auth_config # Apply CUSTOM/NONE + AuthorizerId if applicable
                     )
                     print(f"Created route: {route_key} (ID: {response['RouteId']})")
            except Exception as e:
                print(f"Error creating/updating route {route_key}: {str(e)}")

        # Step 5: Add Lambda permission for the *backend* function (ensure it exists)
        try:
            # Source ARN needs to cover all defined routes/methods
            # Using a wildcard for the method and path within the stage is generally sufficient
            # for AWS_PROXY integrations, as the specific route determines invocation.
            source_arn = f"arn:aws:execute-api:{region}:{account_id}:{api_id}/*/*"
            statement_id_backend = f'apigateway-invoke-backend-{api_id}' # Unique ID for backend

            try:
                 # Remove potentially existing permission first to avoid conflicts
                 lambda_client.remove_permission(
                     FunctionName=function_name,
                     StatementId=statement_id_backend,
                 )
                 print(f"Removed existing invoke permission for backend {function_name} (StatementId: {statement_id_backend})")
            except lambda_client.exceptions.ResourceNotFoundException:
                 print(f"No existing invoke permission found for backend {function_name} (StatementId: {statement_id_backend}), proceeding to add.")
            except Exception as e:
                 print(f"Warning: Could not remove potentially existing permission for backend {function_name} (StatementId: {statement_id_backend}): {e}")

            # Add the permission
            lambda_client.add_permission(
                FunctionName=function_name,
                StatementId=statement_id_backend,
                Action='lambda:InvokeFunction',
                Principal='apigateway.amazonaws.com',
                SourceArn=source_arn
            )
            print(f"Added/Updated permission for API Gateway to invoke backend Lambda: {function_name}")
        except Exception as e:
            print(f"Error setting backend Lambda permission: {str(e)}")
            return False
            
        # Step 6: Deploy the API to a stage
        try:
            # Check if stage exists
            stage_exists = False
            try:
                apigateway_client.get_stage(ApiId=api_id, StageName=stage_name)
                stage_exists = True
                print(f"Stage {stage_name} already exists")
            except apigateway_client.exceptions.NotFoundException:
                pass
                
            if not stage_exists:
                response = apigateway_client.create_stage(
                    ApiId=api_id,
                    StageName=stage_name,
                    AutoDeploy=True
                )
                print(f"Created stage: {stage_name}")
        except Exception as e:
            print(f"Error creating API stage: {str(e)}")
            return False
            
        # Print the API URL
        api_url = f"https://{api_id}.execute-api.{region}.amazonaws.com/{stage_name}"
        print("\n" + "=" * 80)
        print(f"API Gateway {auth_status_message} Lambda Authorizer successfully deployed!")
        print(f"API URL: {api_url}")
        if enable_authorization:
            print(f"Authorizer Lambda ARN: {authorizer_lambda_arn}")
        print(f"Backend Lambda ARN: {function_arn}")
        if enable_authorization:
            print(f"\nEnsure requests include the 'Authorization' header for the authorizer.")
            print(f"Example using curl (replace YOUR_TOKEN):")
            print(f"curl -H 'Authorization: Bearer YOUR_TOKEN' {api_url}/some/path")
        else:
            print("\nAuthorization is not enabled for this API.")
        print("=" * 80)
            
        return True
        
    except Exception as e:
        print(f"Error deploying API Gateway: {str(e)}")
        return False

def main():
    parser = argparse.ArgumentParser(description='Deploy a container from ECR as a Lambda function')
    parser.add_argument('--image-uri', required=False, help='ECR image URI to deploy (if not provided, will build and push container)')
    parser.add_argument('--function-name', required=True, help='Name for the Lambda function')
    parser.add_argument('--role-arn', required=True, help='ARN of the Lambda execution role')
    parser.add_argument('--bedrock-role-arn', required=False, help='ARN of the role to use when invoking Bedrock models')
    parser.add_argument('--region', default='us-east-1', help='AWS region to deploy the Lambda function (default: us-east-1)')
    parser.add_argument('--memory', type=int, default=2048, help='Memory size in MB (default: 2048)')
    parser.add_argument('--timeout', type=int, default=300, help='Timeout in seconds (default: 300)')
    parser.add_argument('--api-gateway', action='store_true', help='Create an API Gateway with API key authentication')
    parser.add_argument('--api-name', help='Name for the API Gateway (defaults to function-name-api)')
    parser.add_argument('--stage-name', default='prod', help='API Gateway stage name (default: prod)')
    parser.add_argument('--enable-authorizer', action='store_true', help='Deploy and enable the Lambda authorizer from src/auth/auth.py')
    parser.add_argument('--authorizer-function-name', help='Name for the Lambda authorizer function (required if --enable-authorizer is set)')
    
    args = parser.parse_args()
    
    # Validate authorizer name only if authorizer is enabled
    if args.enable_authorizer and not args.authorizer_function_name:
        parser.error("--authorizer-function-name is required when --enable-authorizer is specified.")
    
    # Determine if we need to build and push a container or use the provided URI
    ecr_image_uri = args.image_uri
    if not ecr_image_uri:
        ecr_image_uri = build_and_push_container()
        if not ecr_image_uri:
            print("Failed to build and push container. Exiting.")
            sys.exit(1)
    else:
        print("=" * 80)
        print(f"Using provided image URI: {ecr_image_uri}")
        print("=" * 80)
    
    # Deploy the Lambda function with the image URI
    success = deploy_lambda_container(
        ecr_image_uri, 
        args.function_name, 
        args.role_arn,
        args.bedrock_role_arn,
        args.region,
        args.memory,
        args.timeout,
        args.api_gateway,
        args.api_name,
        args.stage_name,
        args.enable_authorizer,
        args.authorizer_function_name
    )
    
    if not success:
        sys.exit(1)

if __name__ == '__main__':
    main()