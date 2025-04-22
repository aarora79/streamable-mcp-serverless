# Deploy a "Streamable-HTTP" MCP server on AWS Lambda and Amazon API Gateway for Amazon Bedrock spend analysis

This project deploys a Model Context Protocol (MCP) server as a containerized application on AWS Lambda and accessible to clients via an Amazon API Gateway. The MCP protocol now supports [`Streamable-HTTP`](https://modelcontextprotocol.io/specification/2025-03-26/basic/transports#streamable-http) which means that the server operates as an independent process that can handle multiple client connections. The server in this repo sends a `Mcp-Session-id` field to the client in the HTTP response header when accepting a new connection and the client then includes this header field in every subsequent request it sends to the server thus enabling session management.

The MCP server and client in this repo are both written in TypeScript. The server is built as a container and deployed on a Lambda and is available as an endpoint via an API Gateway. 

>Note: as of 4/22/2025 Lambda supports HTTP Streaming for Node.js managed runtime ([link](https://docs.aws.amazon.com/lambda/latest/dg/configuration-response-streaming.html)). API Gateway does not support Service Side Events (SSE) which is why Streamable HTTP comes in handy and we can now deploy an MCP server on Lambda and API Gateway.

The MCP server in this repo provides a tool to get a summary of the spend on Amazon Bedrock in a given AWS account.

## Architecture

The following diagram illustrates the architecture of the MCP server deployment:

![Architecture Diagram](architecture.png)

The architecture consists of:
1. **API Gateway**: Provides the HTTP API endpoint
2. **Lambda Function**: Runs the containerized MCP server
3. **ECR**: Stores the Docker container image
4. **CloudWatch Logs**: Collects and stores logs from both the server and Bedrock usage
5. **Bedrock**: The underlying model service that the MCP server interacts with

## Prerequisites

1.  **Node.js & npm:** Install Node.js version 18.x or later (which includes npm). This is required for running the server and client locally.
1.  **Python 3.11:** Required for the deployment script (`deploy.py`).
1.  **Docker:** Install Docker Desktop or Docker Engine. Required for building the container image for AWS Lambda deployment.
1.  **AWS Account & CLI:** Required for deployment:
    *   An active AWS account
    *   AWS CLI installed and configured with appropriate credentials
    *   Boto3 Python package

1. Setup [model invocation logs](https://docs.aws.amazon.com/bedrock/latest/userguide/model-invocation-logging.html#setup-cloudwatch-logs-destination) in Amazon CloudWatch.

1. Ensure that the IAM user/role being used has full read-only access to Amazon Cost Explorer and Amazon CloudWatch, this is required for the MCP server to retrieve data from these services.

See [here](https://docs.aws.amazon.com/awsaccountbilling/latest/aboutv2/billing-example-policies.html) and [here](https://docs.aws.amazon.com/aws-managed-policy/latest/reference/CloudWatchLogsReadOnlyAccess.html) for sample policy examples that you can use & modify as per your requirements. 

## Running Locally

You can run both the server and client locally for development and testing purposes.

### Running the Server Locally

1. Install dependencies:
   ```bash
   npm install
   ```

2. Start the server:
   ```bash
   npx tsx src/server.ts
   ```
   The server will start on `http://localhost:3000` by default.

### Running the Client Locally

1. The client can be run using the same command:
   ```bash
   npx tsx src/client.ts
   ```

Example:
```bash
# Initialize
curl -XPOST "http://localhost:3000/prod/mcp" \
-H "Content-Type: application/json" \
-H "Accept: application/json" \
-H "Accept: text/event-stream" \
-d '{
  "jsonrpc": "2.0",
  "method": "initialize",
  "params": {
    "clientInfo": { "name": "curl-client", "version": "1.0" },
    "protocolVersion": "2025-03-26",
    "capabilities": {}
  },
  "id": "init-1"
}'
```

If successful you should see an output similar to the following:

```bash
event: message
id: 2d11fbfc-f4e8-4738-8de8-60b59324459d_1745362335448_hj5mjalf
data: {"result":{"protocolVersion":"2024-11-05","capabilities":{"logging":{},"tools":{"listChanged":true},"prompts":{"listChanged":true},"resources":{"listChanged":true}},"serverInfo":{"name":"bedrock-usage-stats-http-server","version":"1.0.1"}},"jsonrpc":"2.0","id":"init-1"}
```

## Deployment Approach

*   **Container Image:** The Node.js/Express application is packaged into a Docker container image using Node.js 18.
*   **AWS ECR:** The Docker image is stored in Amazon Elastic Container Registry (ECR).
*   **AWS Lambda:** A Lambda function is created using the container image from ECR.
*   **API Gateway:** An HTTP API is created with API key authentication and usage plans.
*   **CloudWatch Logs:** The server integrates with CloudWatch Logs for monitoring and debugging.

## Available Tools

The server implements the following tools:

1. **greet**: A simple greeting tool that returns a personalized message
2. **multi-greet**: A tool that sends multiple greetings with delays between them
3. **bedrock-logs**: A tool for querying AWS Bedrock usage logs

## Deployment Steps

1. **Install `uv` and Python dependencies needed for deployment to Lambda**

    ```bash
    # Install uv if you don't have it
    curl -LsSf https://astral.sh/uv/install.sh | sh
    export PATH="$HOME/.local/bin:$PATH"

    # Create a virtual environment and install dependencies
    uv venv --python 3.11 && source .venv/bin/activate && uv pip install --requirement pyproject.toml
    ```

1.  **Run the Deployment Script:**
    ```bash
    python deploy.py \
      --function-name bedrock-spend-mcp-server \
      --role-arn <lambda-role-arn> \
      --region us-east-1 \
      --memory 2048 \
      --timeout 300 \
      --api-gateway \
      --api-name mcp-server-api \
      --stage-name prod
    ```

    The script will:
    *   Build the Docker image for the correct Lambda architecture (`linux/amd64`)
    *   Create the ECR repository if it doesn't exist
    *   Authenticate Docker with ECR
    *   Push the image to ECR
    *   Create the Lambda execution IAM role and attach policies
    *   Create or update the Lambda function
    *   Create or update the API Gateway with API key authentication
    *   Set up usage plans and throttling

2.  **Deployment Output:**
    *   Upon successful completion, the script will print a summary including:
        *   ECR Image URI
        *   IAM Role ARN
        *   Lambda Function ARN
        *   API Gateway URL
        *   API Key
    * Note the API URL as printed out in the output, you should see something similar to:
      ```bash
      API Gateway successfully deployed!
      API URL: https://<api-id>.execute-api.us-east-1.amazonaws.com/prod
      ```

## Connecting to the Server

After deployment, you can connect to the server using the `client.ts` script:

1. Set the required environment variables:
   ```bash
   # note the extra "/mcp" at the end of the API URL 
   export MCP_SERVER_URL="https://<api-id>.execute-api.<region>.amazonaws.com/prod/mcp"
   ```
1. Install dependencies:
    ```bash
    npm install
    ```

1. Run the client:
   ```bash
   npx tsx src/client.ts
   ```
The client will automatically:
- Initialize a connection with the server
- Handle session management
- Provide an interactive interface for using the available tools

1. To get a summary of the Amazon Bedrock spend over the last few days run the `bedrock-report` command on the client CLI.

    ```{.bash}
    >bedrock-report <region> <log-group-name> <number-of-days> <aws-account-id>
    ```

   The above command should produce an output similar to the following:

   ```{.bash}
   Tool result:
   Bedrock Daily Usage Report (Past 17 days - us-east-1)
   Total Requests: 13060
   Total Input Tokens: 2992387
   Total Completion Tokens: 254124
   Total Tokens: 3246511

   --- Daily Totals ---
   2025-04-06: Requests=8330, Input=1818253, Completion=171794, Total=1990047
   2025-04-07: Requests=4669, Input=936299, Completion=71744, Total=1008043
   2025-04-10: Requests=4, Input=4652, Completion=370, Total=5022
   2025-04-11: Requests=6, Input=17523, Completion=1201, Total=18724
   2025-04-13: Requests=27, Input=67524, Completion=4406, Total=71930
   2025-04-14: Requests=24, Input=148136, Completion=4609, Total=152745

   --- Region Summary ---
   us-east-1: Requests=13060, Input=2992387, Completion=254124, Total=3246511

   --- Model Summary ---
   nova-lite-v1:0: Requests=93, Input=177416, Completion=30331, Total=207747
   titan-embed-text-v1: Requests=62, Input=845, Completion=0, Total=845
   nova-micro-v1:0: Requests=27, Input=63396, Completion=10225, Total=73621
   llama3-3-70b-instruct-v1:0: Requests=3749, Input=780568, Completion=58978, Total=839546
   claude-3-5-sonnet-20241022-v2:0: Requests=5353, Input=846616, Completion=82570, Total=929186
   command-r-plus-v1:0: Requests=3644, Input=659689, Completion=40900, Total=700589
   nova-pro-v1:0: Requests=40, Input=116939, Completion=13144, Total=130083
   claude-3-5-haiku-20241022-v1:0: Requests=88, Input=342266, Completion=17606, Total=359872
   claude-3-haiku-20240307-v1:0: Requests=4, Input=4652, Completion=370, Total=5022

   --- User Summary ---
   arn:aws:sts::012345678091:assumed-role/role-name/i-0ed8662e2ec5052df: Requests=314, Input=705514, Completion=71676, Total=777190
   arn:aws:sts::012345678091:assumed-role/role-name/i-0e7fa4b21ef43662a: Requests=1422, Input=232289, Completion=20468, Total=252757
   arn:aws:sts::012345678091:assumed-role/role-name/i-0a0528a4884da8642: Requests=11324, Input=2054584, Completion=161980, Total=2216564

   ```

## Known issues:
- Client sometimes fails to call tools, this can be resolved by restarting the client or establishing connection again.

## Acknowledgments

This project was developed with the support of the following technologies and services:

- [AWS Lambda](https://aws.amazon.com/lambda/) for serverless computing
- [Amazon API Gateway](https://aws.amazon.com/api-gateway/) for API management
- [Amazon Bedrock](https://aws.amazon.com/bedrock/) for foundation models
- [Model Context Protocol](https://modelcontextprotocol.io/) for the communication protocol
- [Node.js](https://nodejs.org/) and [TypeScript](https://www.typescriptlang.org/) for the implementation
- [Express.js](https://expressjs.com/) for the web server framework

