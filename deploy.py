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
            print(f"Error checking function status: {str(e)}")
            time.sleep(2)
    
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

def deploy_lambda_container(ecr_image_uri, function_name, role_arn, bedrock_role_arn, region="us-east-1", memory_size=1024, timeout=90, api_gateway=False, api_name=None, stage_name="prod"):
    """
    Deploy a container from ECR as a Lambda function with optional API Gateway
    
    Args:
        ecr_image_uri (str): URI of the ECR image to deploy
        function_name (str): Name of the Lambda function
        role_arn (str): ARN of the Lambda execution role
        bedrock_role_arn (str): ARN of the role to use when invoking Bedrock models
        region (str): AWS region to deploy the Lambda function
        memory_size (int): Memory size in MB for the Lambda function
        timeout (int): Timeout in seconds for the Lambda function
        api_gateway (bool): Whether to create an API Gateway for the Lambda
        api_name (str): Name for the API Gateway (defaults to function-name-api)
        stage_name (str): API Gateway stage name
    """
    print("=" * 80)
    print(f"Deploying container {ecr_image_uri} as Lambda function {function_name} in region {region}...")
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
            print(f"Successfully deployed Lambda function: {function_name}")
            function_arn = function_info['Configuration']['FunctionArn']
            print(f"Function ARN: {function_arn}")
            
            if api_gateway:
                # Setup API Gateway instead of Function URL
                return deploy_api_gateway(function_name, function_arn, region, api_name, stage_name)
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
            
def deploy_api_gateway(function_name, function_arn, region, api_name=None, stage_name="prod"):
    """
    Deploy an API Gateway v2 HTTP API with Lambda integration and API key authentication
    
    Args:
        function_name (str): The Lambda function name
        function_arn (str): The Lambda function ARN
        region (str): AWS region
        api_name (str): Name for the API Gateway
        stage_name (str): API Gateway stage name
    
    Returns:
        bool: True if successful, False otherwise
    """
    if api_name is None:
        api_name = f"{function_name}-api"
    
    print("=" * 80)
    print(f"Deploying API Gateway ({api_name}) for Lambda function: {function_name}")
    print("=" * 80)
    
    # Initialize clients
    apigateway_client = boto3.client('apigatewayv2', region_name=region)
    apigateway_v1_client = boto3.client('apigateway', region_name=region)
    lambda_client = boto3.client('lambda', region_name=region)
    
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
                        'AllowMethods': ['GET', 'POST', 'PUT', 'DELETE', 'OPTIONS', 'HEAD', 'PATCH'],
                        'AllowHeaders': ['Content-Type', 'X-Amz-Date', 'Authorization', 'X-Api-Key'],
                        'MaxAge': 86400
                    }
                )
                api_id = response['ApiId']
                print(f"Created new API Gateway: {api_id}")
            except Exception as e:
                print(f"Error creating API Gateway: {str(e)}")
                return False
        
        # Step 2: Create or update the API key
        api_key_id = None
        api_key_value = None
        
        try:
            # Look for existing API key - use the v1 client
            response = apigateway_v1_client.get_api_keys()
            for key in response.get('items', []):
                if key.get('name') == f"{api_name}-key":
                    api_key_id = key['id']
                    print(f"Found existing API key: {api_key_id}")
                    break
                    
            if not api_key_id:
                # Create a new API key - use the v1 client
                api_key_value = str(uuid.uuid4())
                response = apigateway_v1_client.create_api_key(
                    name=f"{api_name}-key",
                    value=api_key_value,
                    enabled=True
                )
                api_key_id = response['id']
                print(f"Created API key: {api_key_id}")
        except Exception as e:
            print(f"Error managing API key: {str(e)}")
            return False
        
        # Step 3: Create or update integration with Lambda
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
            
        # Step 4: Create routes for the API
        route_keys = ['GET /', 'GET /docs', 'GET /{proxy+}', 'POST /{proxy+}']
        
        for route_key in route_keys:
            try:
                # Check if route exists
                route_exists = False
                try:
                    response = apigateway_client.get_routes(ApiId=api_id)
                    for route in response.get('Items', []):
                        if route['RouteKey'] == route_key:
                            route_exists = True
                            print(f"Route already exists: {route_key}")
                            break
                except Exception:
                    pass
                
                if not route_exists:
                    response = apigateway_client.create_route(
                        ApiId=api_id,
                        RouteKey=route_key,
                        Target=f'integrations/{integration_id}',
                        AuthorizationType='NONE'  # We'll use API key instead
                    )
                    print(f"Created route: {route_key}")
            except Exception as e:
                print(f"Error creating route {route_key}: {str(e)}")
                # Continue with other routes
        
        # Step 5: Add Lambda permission to allow API Gateway to invoke it
        try:
            # Get the AWS account ID
            sts_client = boto3.client('sts', region_name=region)
            account_id = sts_client.get_caller_identity()['Account']
            
            # Create the source ARN with the actual account ID instead of wildcard
            source_arn = f"arn:aws:execute-api:{region}:{account_id}:{api_id}/*/*"
            
            try:
                # Check if permission exists
                policy = lambda_client.get_policy(FunctionName=function_name)
                policy_json = json.loads(policy['Policy'])
                
                permission_exists = False
                for statement in policy_json.get('Statement', []):
                    if (statement.get('Principal', {}).get('Service') == 'apigateway.amazonaws.com' and 
                        f":{api_id}/" in statement.get('Condition', {}).get('ArnLike', {}).get('AWS:SourceArn', '')):
                        permission_exists = True
                        break
                        
                if not permission_exists:
                    raise lambda_client.exceptions.ResourceNotFoundException('Permission not found')
                    
                print("API Gateway permission already exists for Lambda")
                
            except (lambda_client.exceptions.ResourceNotFoundException, KeyError, json.JSONDecodeError):
                # Add permission
                lambda_client.add_permission(
                    FunctionName=function_name,
                    StatementId=f'apigateway-invoke-{int(time.time())}',
                    Action='lambda:InvokeFunction',
                    Principal='apigateway.amazonaws.com',
                    SourceArn=source_arn
                )
                print("Added permission for API Gateway to invoke Lambda")
        except Exception as e:
            print(f"Error setting Lambda permission: {str(e)}")
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
            
        # Step 7: Create usage plan and connect API key
        try:
            # Create or get usage plan
            usage_plan_id = None
            
            try:
                response = apigateway_v1_client.get_usage_plans()
                for plan in response.get('items', []):
                    if plan.get('name') == f"{api_name}-usage-plan":
                        usage_plan_id = plan['id']
                        print(f"Found existing usage plan: {usage_plan_id}")
                        break
            except Exception as e:
                print(f"Error checking existing usage plans: {str(e)}")
                
            if not usage_plan_id:
                response = apigateway_v1_client.create_usage_plan(
                    name=f"{api_name}-usage-plan",
                    description=f"Usage plan for {api_name}",
                    quota={
                        'limit': 1000,
                        'period': 'MONTH'
                    },
                    throttle={
                        'burstLimit': 10,
                        'rateLimit': 5
                    }
                )
                usage_plan_id = response['id']
                print(f"Created usage plan: {usage_plan_id}")
                
            # Associate stage with usage plan
            try:
                apigateway_v1_client.update_usage_plan(
                    usagePlanId=usage_plan_id,
                    patchOperations=[
                        {
                            'op': 'add',
                            'path': '/apiStages',
                            'value': f"{api_id}:{stage_name}"
                        }
                    ]
                )
                print(f"Associated stage {stage_name} with usage plan")
            except Exception as e:
                print(f"Error associating stage with usage plan: {str(e)}")
                
            # Associate API key with usage plan
            try:
                apigateway_v1_client.create_usage_plan_key(
                    usagePlanId=usage_plan_id,
                    keyId=api_key_id,
                    keyType='API_KEY'
                )
                print(f"Associated API key with usage plan")
            except apigateway_v1_client.exceptions.ConflictException:
                print(f"API key already associated with usage plan")
            except Exception as e:
                print(f"Error associating API key with usage plan: {str(e)}")
                
        except Exception as e:
            print(f"Error setting up usage plan: {str(e)}")
            return False
            
        # Print the API URL and key information
        api_url = f"https://{api_id}.execute-api.{region}.amazonaws.com/{stage_name}"
        print("\n" + "=" * 80)
        print(f"API Gateway successfully deployed!")
        print(f"API URL: {api_url}")
        
        if api_key_value:
            print(f"API Key: {api_key_value}")
            print("\nTo use this API with the key:")
            print(f"curl -H 'x-api-key: {api_key_value}' {api_url}")
        else:
            print("\nTo use this API, you need the API key. You can retrieve it from the AWS console.")
            print(f"curl -H 'x-api-key: YOUR_API_KEY' {api_url}")
            
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
    
    args = parser.parse_args()
    
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
        args.stage_name
    )
    
    if not success:
        sys.exit(1)

if __name__ == '__main__':
    main()