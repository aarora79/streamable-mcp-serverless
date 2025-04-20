# Simple MCP Server on Lambda (Container Image)

This project deploys a Model Context Protocol (MCP) server as a containerized application on AWS Lambda, accessible via a Lambda Function URL.

## Prerequisites

1.  **AWS Account:** You need an active AWS account.
2.  **AWS CLI:** Install and configure the AWS CLI with credentials that have permissions to manage ECR, Lambda, IAM, and CloudWatch Logs. ([Configuration Guide](https://docs.aws.amazon.com/cli/latest/userguide/cli-configure-quickstart.html))
3.  **Docker:** Install Docker Desktop or Docker Engine. Ensure the Docker daemon is running.
4.  **Python:** Install Python 3.x.
5.  **Boto3:** Install the AWS SDK for Python: `pip install boto3`
6.  **Node.js & npm:** Install Node.js (which includes npm) version 18.x or later. This is needed by the Docker build process.

## Deployment Approach

*   **Container Image:** The Node.js/Express application is packaged into a Docker container image.
*   **AWS ECR:** The Docker image is stored in Amazon Elastic Container Registry (ECR).
*   **AWS Lambda:** A Lambda function is created using the container image from ECR.
*   **Lambda Function URL:** An HTTPS endpoint (Function URL) is created directly for the Lambda function, allowing invocation without API Gateway. Streaming responses are enabled.
*   **`serverless-express`:** This library is used within the Node.js code (`server.ts`) to translate Lambda invocation events into a format that the Express application understands and to format the response correctly.
*   **Python Deployment Script:** The `deploy_mcp_lambda.py` script automates the creation and configuration of AWS resources (ECR repo, IAM role, Lambda function, Function URL) and handles the Docker build/push process.

## Deployment Steps

1.  **Review Configuration:**
    *   Open `deploy_mcp_lambda.py`.
    *   Verify the `AWS_REGION` variable matches your desired deployment region.
    *   Adjust resource names (`REPO_NAME`, `FUNCTION_NAME`, `ROLE_NAME`) if desired.
    *   Review the `IAM_POLICY_ARNS` list. Ensure the necessary permissions (CloudWatch Logs, S3, potentially Billing/Cost Explorer) are included for your specific use case.

2.  **Run the Deployment Script:**
    *   Open your terminal in the project root directory (where `Dockerfile`, `deploy_mcp_lambda.py`, and `src` are located).
    *   Execute the script:
        ```bash
        python deploy_mcp_lambda.py
        ```
    *   The script will:
        *   Build the Docker image for the correct Lambda architecture (`linux/amd64`).
        *   Create the ECR repository if it doesn't exist.
        *   Authenticate Docker with ECR.
        *   Push the image to ECR.
        *   Create the Lambda execution IAM role and attach policies if they don't exist.
        *   Create or update the Lambda function, configuring it to use the image from ECR.
        *   Create or update the Lambda Function URL with streaming enabled.

3.  **Deployment Output:**
    *   Upon successful completion, the script will print a summary including:
        *   ECR Image URI
        *   IAM Role ARN
        *   Lambda Function ARN
        *   **Lambda Function URL**
        *   **MCP Server Endpoint** (This is the Function URL with `/mcp` appended)

## Connecting to the Server

Use the **MCP Server Endpoint** URL provided in the deployment script's output summary.

*   **Base URL:** `https://<function-url-output>/mcp`
*   **Method:** Use standard MCP JSON-RPC requests (e.g., `initialize`, `tools/list`, `tools/call`).
*   **Headers:** Include `Content-Type: application/json`.
*   **Session Management:** The server uses session IDs. Send an `initialize` request first. The response will include an `mcp-session-id` header. Include this header in all subsequent requests for that session.

**Example using `curl`:**

1.  **Initialize:**
    ```bash
    FUNCTION_URL="<paste_function_url_here>" # e.g., https://abcdef123.lambda-url.us-east-1.on.aws/
    curl -XPOST "${FUNCTION_URL}mcp" \
    -H "Content-Type: application/json" \
    -H "Accept: application/json" \
    -d '{
      "jsonrpc": "2.0",
      "method": "initialize",
      "params": {
        "clientInfo": { "name": "curl-client", "version": "1.0" },
        "protocolVersion": "2025-03-26"
      },
      "id": "init-1"
    }'
    ```
    *(Look for the `mcp-session-id` header in the response)*

2.  **Subsequent Request (e.g., list tools):**
    ```bash
    SESSION_ID="<paste_session_id_from_init_response_here>"
    curl -XPOST "${FUNCTION_URL}mcp" \
    -H "Content-Type: application/json" \
    -H "Accept: application/json" \
    -H "mcp-session-id: ${SESSION_ID}" \
    -d '{
      "jsonrpc": "2.0",
      "method": "tools/list",
      "params": {},
      "id": "list-1"
    }'
    ```

## Updating the Deployment

1.  Make changes to your source code (`src/` directory) or `Dockerfile`.
2.  Re-run the deployment script:
    ```bash
    python deploy_mcp_lambda.py
    ```
    The script will rebuild and push the image if necessary and update the Lambda function's code.

## Cleaning Up Resources

To remove the deployed resources, you can manually delete them from the AWS console:

1.  Lambda Function (`mcp-server-function` or your custom name)
2.  Lambda Function URL (associated with the function)
3.  IAM Role (`mcp-lambda-execution-role` or your custom name)
4.  ECR Repository (`mcp-lambda-server` or your custom name) - Make sure to delete images first if needed.
5.  CloudWatch Log Group (usually `/aws/lambda/<function_name>`)

Alternatively, you could adapt the Python script or use Terraform to manage the teardown.

## Learn about mcp
[Intro](https://modelcontextprotocol.io/introduction)

[Protocol specification](https://modelcontextprotocol.io/specification/2025-03-26)
