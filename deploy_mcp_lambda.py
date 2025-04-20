import subprocess
import json
import boto3
import time
import os
import sys

# --- Configuration ---
AWS_REGION = "us-east-1"  # Or your desired region
REPO_NAME = "mcp-lambda-server"
IMAGE_TAG = "latest"
FUNCTION_NAME = "mcp-server-function"
ROLE_NAME = "mcp-lambda-execution-role"
API_NAME = "mcp-http-api"
TRUST_POLICY_FILE = "trust-policy.json"

# Policies to attach to the Lambda role
IAM_POLICY_ARNS = [
    "arn:aws:iam::aws:policy/CloudWatchFullAccessV2",
    "arn:aws:iam::aws:policy/AmazonS3FullAccess",
    # "arn:aws:iam::aws:policy/Billing", # Uncomment or change if Cost Explorer access is needed
]
# --- End Configuration ---

# Initialize Boto3 clients
try:
    sts_client = boto3.client("sts", region_name=AWS_REGION)
    ecr_client = boto3.client("ecr", region_name=AWS_REGION)
    iam_client = boto3.client("iam", region_name=AWS_REGION)
    lambda_client = boto3.client("lambda", region_name=AWS_REGION)
except Exception as e:
    print(f"Error initializing Boto3 clients: {e}")
    print("Please ensure AWS credentials and region are configured correctly.")
    sys.exit(1)

# Get AWS Account ID
try:
    AWS_ACCOUNT_ID = sts_client.get_caller_identity()["Account"]
    print(f"Using AWS Account ID: {AWS_ACCOUNT_ID}")
except Exception as e:
    print(f"Error getting AWS Account ID: {e}")
    sys.exit(1)

# Construct ECR image URI
IMAGE_URI = f"{AWS_ACCOUNT_ID}.dkr.ecr.{AWS_REGION}.amazonaws.com/{REPO_NAME}:{IMAGE_TAG}"

def run_command(command, shell=False, check=True, env=None):
    """Helper function to run shell commands."""
    print(f"\nRunning command: {' '.join(command) if isinstance(command, list) else command}")
    try:
        process = subprocess.run(
            command,
            shell=shell,
            check=check,
            capture_output=True,
            text=True,
            env=env or os.environ.copy(),
        )
        print("Command successful.")
        print("Output:\n", process.stdout)
        if process.stderr:
            print("Stderr:\n", process.stderr)
        return process.stdout.strip()
    except subprocess.CalledProcessError as e:
        print(f"Error running command: {' '.join(command) if isinstance(command, list) else command}")
        print(f"Return code: {e.returncode}")
        print(f"Output:\n{e.stdout}")
        print(f"Error output:\n{e.stderr}")
        raise  # Re-raise the exception to stop the script

def build_and_tag_image():
    """Builds the Docker image for linux/amd64 and tags it for ECR."""
    print("\n--- Building Docker Image for linux/amd64 ---")
    # Add --platform flag here
    run_command(["docker", "build", "--platform", "linux/amd64", "-t", f"{REPO_NAME}:{IMAGE_TAG}", "."])
    print("\n--- Tagging Docker Image ---")
    run_command(["docker", "tag", f"{REPO_NAME}:{IMAGE_TAG}", IMAGE_URI])
    print(f"Image tagged as: {IMAGE_URI}")

def create_ecr_repo():
    """Creates the ECR repository if it doesn't exist."""
    print(f"\n--- Ensuring ECR Repository '{REPO_NAME}' Exists ---")
    try:
        response = ecr_client.create_repository(
            repositoryName=REPO_NAME,
            imageScanningConfiguration={'scanOnPush': True},
            imageTagMutability='MUTABLE'
        )
        print(f"Repository '{REPO_NAME}' created: {response['repository']['repositoryUri']}")
    except ecr_client.exceptions.RepositoryAlreadyExistsException:
        print(f"Repository '{REPO_NAME}' already exists.")
    except Exception as e:
        print(f"Error creating ECR repository: {e}")
        raise

def authenticate_ecr():
    """Authenticates Docker with ECR."""
    print("\n--- Authenticating Docker with ECR ---")
    try:
        # Get password using AWS CLI via subprocess (boto3 doesn't directly provide this)
        password_command = [
            "aws", "ecr", "get-login-password", "--region", AWS_REGION
        ]
        password = run_command(password_command)

        # Login using Docker CLI via subprocess
        login_command = [
            "docker", "login", "--username", "AWS", "--password-stdin",
            f"{AWS_ACCOUNT_ID}.dkr.ecr.{AWS_REGION}.amazonaws.com"
        ]
        print(f"Running command: {' '.join(login_command[:-1])} --password-stdin ...")
        process = subprocess.run(
            login_command,
            input=password,
            check=True,
            capture_output=True,
            text=True
        )
        print("Docker ECR login successful.")
        print("Output:\n", process.stdout)
        if process.stderr:
            print("Stderr:\n", process.stderr)

    except Exception as e:
        print(f"Error authenticating with ECR: {e}")
        raise

def push_image():
    """Pushes the Docker image to ECR."""
    print("\n--- Pushing Image to ECR ---")
    run_command(["docker", "push", IMAGE_URI])
    print("Image push complete.")

def create_iam_role():
    """Creates the Lambda execution IAM role and attaches policies."""
    print(f"\n--- Ensuring IAM Role '{ROLE_NAME}' Exists ---")
    role_arn = f"arn:aws:iam::{AWS_ACCOUNT_ID}:role/{ROLE_NAME}"

    # Create trust policy file if it doesn't exist
    if not os.path.exists(TRUST_POLICY_FILE):
        print(f"Creating trust policy file: {TRUST_POLICY_FILE}")
        trust_policy = {
            "Version": "2012-10-17",
            "Statement": [
                {
                    "Effect": "Allow",
                    "Principal": {"Service": "lambda.amazonaws.com"},
                    "Action": "sts:AssumeRole"
                }
            ]
        }
        with open(TRUST_POLICY_FILE, 'w') as f:
            json.dump(trust_policy, f, indent=2)

    try:
        with open(TRUST_POLICY_FILE, 'r') as f:
            trust_policy_document = f.read()

        response = iam_client.create_role(
            RoleName=ROLE_NAME,
            AssumeRolePolicyDocument=trust_policy_document,
            Description="Execution role for MCP Lambda function"
        )
        role_arn = response['Role']['Arn']
        print(f"IAM Role '{ROLE_NAME}' created with ARN: {role_arn}")
        print("Waiting briefly for role to propagate...")
        time.sleep(10) # Allow time for role propagation

    except iam_client.exceptions.EntityAlreadyExistsException:
        print(f"IAM Role '{ROLE_NAME}' already exists.")
        # Ensure we have the correct ARN
        response = iam_client.get_role(RoleName=ROLE_NAME)
        role_arn = response['Role']['Arn']
        print(f"Using existing role ARN: {role_arn}")

    except Exception as e:
        print(f"Error creating or getting IAM role: {e}")
        raise

    print("\n--- Attaching Policies to Role ---")
    attached_policies = [p['PolicyArn'] for p in iam_client.list_attached_role_policies(RoleName=ROLE_NAME)['AttachedPolicies']]
    print(f"Currently attached policies: {attached_policies}")

    for policy_arn in IAM_POLICY_ARNS:
        if policy_arn not in attached_policies:
            try:
                print(f"Attaching policy: {policy_arn}")
                iam_client.attach_role_policy(
                    RoleName=ROLE_NAME,
                    PolicyArn=policy_arn
                )
                print(f"Policy '{policy_arn}' attached.")
            except Exception as e:
                print(f"Error attaching policy {policy_arn}: {e}")
                # Continue trying to attach other policies
        else:
             print(f"Policy '{policy_arn}' already attached.")

    return role_arn

def create_update_lambda_function(role_arn):
    """Creates or updates the Lambda function."""
    print(f"\n--- Ensuring Lambda Function '{FUNCTION_NAME}' Exists/Is Updated ---")
    try:
        # Check if function exists
        lambda_client.get_function(FunctionName=FUNCTION_NAME)
        print(f"Function '{FUNCTION_NAME}' exists. Updating...")

        response = lambda_client.update_function_code(
            FunctionName=FUNCTION_NAME,
            ImageUri=IMAGE_URI,
            Publish=True # Publish a new version
        )
        print("Function code updated.")
        # Potential: Update configuration if needed (role, timeout etc)
        # lambda_client.update_function_configuration(...)

    except lambda_client.exceptions.ResourceNotFoundException:
        print(f"Function '{FUNCTION_NAME}' not found. Creating...")
        response = lambda_client.create_function(
            FunctionName=FUNCTION_NAME,
            Role=role_arn,
            Code={'ImageUri': IMAGE_URI},
            PackageType='Image',
            Timeout=60,  # seconds
            MemorySize=512, # MB
            Publish=True # Publish the first version
        )
        print("Function created.")

    except Exception as e:
        print(f"Error creating or updating Lambda function: {e}")
        raise

    function_arn = response['FunctionArn']
    print(f"Function ARN: {function_arn}")

    print("Waiting for function update/creation to complete...")
    waiter = lambda_client.get_waiter('function_updated_v2')
    if 'Configuration' in response: # Update response structure
       waiter = lambda_client.get_waiter('function_updated_v2')
       waiter.wait(FunctionName=FUNCTION_NAME)
    else: # Create response structure
       waiter = lambda_client.get_waiter('function_active_v2')
       waiter.wait(FunctionName=FUNCTION_NAME)

    print(f"Lambda function '{FUNCTION_NAME}' is active/updated.")
    return function_arn

def create_lambda_function_url(function_name):
    """Creates or updates the Lambda Function URL."""
    print(f"\n--- Ensuring Lambda Function URL for '{function_name}' Exists ---")
    try:
        # Check if URL config already exists
        response = lambda_client.get_function_url_config(FunctionName=function_name)
        function_url = response['FunctionUrl']
        print(f"Function URL already exists: {function_url}")
        # Optional: Update if needed (e.g., change auth type, CORS)
        # print("Updating Function URL configuration...")
        # lambda_client.update_function_url_config(
        #     FunctionName=function_name,
        #     AuthType='NONE',
        #     InvokeMode='RESPONSE_STREAM' # Enable streaming
        #     # Add CORS config if needed:
        #     # Cors={ ... }
        # )
        print("(Skipping update for existing URL in this script)")

    except lambda_client.exceptions.ResourceNotFoundException:
        print(f"Function URL not found for '{function_name}'. Creating...")
        response = lambda_client.create_function_url_config(
            FunctionName=function_name,
            AuthType='NONE', # Make it publicly accessible
            InvokeMode='RESPONSE_STREAM' # Enable streaming
            # Add CORS config if needed:
            # Cors={
            #     'AllowOrigins': ['*'], # Be more specific in production
            #     'AllowMethods': ['POST', 'GET', 'DELETE', 'OPTIONS'],
            #     'AllowHeaders': ['content-type', 'accept', 'mcp-session-id'],
            #     'MaxAge': 86400,
            #     'AllowCredentials': True
            # }
        )
        function_url = response['FunctionUrl']
        print(f"Function URL created: {function_url}")

    except Exception as e:
        print(f"Error creating or getting Lambda Function URL: {e}")
        raise

    return function_url

# --- Main Deployment Script ---
if __name__ == "__main__":
    try:
        print("Starting MCP Lambda Deployment...")

        # 1. Build and Tag
        build_and_tag_image()

        # 2. Create ECR Repo
        create_ecr_repo()

        # 3. Authenticate Docker
        authenticate_ecr()

        # 4. Push Image
        push_image()

        # 5. Create IAM Role
        role_arn = create_iam_role()

        # 6. Create/Update Lambda Function
        function_arn = create_update_lambda_function(role_arn)

        # 7. Create/Update Lambda Function URL
        function_url = create_lambda_function_url(FUNCTION_NAME)

        print("\n--- Deployment Summary ---")
        print(f"ECR Image: {IMAGE_URI}")
        print(f"IAM Role: {role_arn}")
        print(f"Lambda Function: {function_arn}")
        print(f"Lambda Function URL: {function_url}")
        print(f"MCP Server Endpoint: {function_url}mcp") # Append /mcp
        print("--------------------------")

    except Exception as e:
        print(f"\nDeployment failed: {e}")
        sys.exit(1) 