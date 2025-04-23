# Streamable HTTP in Action: Deploying MCP Servers on AWS Lambda and API Gateway

I'm excited to share a project that demonstrates the new **Streamable HTTP** enhancement to the Model Context Protocol (MCP), showcasing a powerful serverless deployment pattern for AI tools.

## What is this project?

This implementation deploys an MCP server as a containerized application on AWS Lambda, accessible via Amazon API Gateway. The server provides tools for analyzing Amazon Bedrock usage and spend, making it easy to monitor and understand your AI model consumption costs.

## Why is this significant?

The Model Context Protocol (MCP) is an open standard for communication between AI applications and tools. The new **Streamable HTTP** enhancement is a game-changer because:

1. It enables MCP servers to operate as independent processes handling multiple client connections
2. It implements session management via HTTP headers (`Mcp-Session-id`)
3. It allows for serverless deployments on AWS Lambda and API Gateway without requiring SSE support

## Technical Implementation

- **Server & Client**: Both written in TypeScript using the MCP SDK
- **Containerization**: Packaged as a Docker container for Lambda deployment
- **Session Management**: Uses `Mcp-Session-id` header for maintaining client state
- **Deployment**: Automated via Python script to set up ECR, Lambda, and API Gateway
- **Tools**: Provides Bedrock usage analysis tools that query CloudWatch logs

## Why this architecture matters

This pattern solves a critical challenge: As of April 2025, Lambda supports HTTP Streaming for Node.js, but API Gateway doesn't support Server-Sent Events (SSE). The Streamable HTTP enhancement bridges this gap, enabling robust MCP server deployments in serverless environments.

The architecture provides:
- Cost-effective serverless scaling
- No infrastructure management overhead
- Simplified deployment through containerization
- Secure API access with API key authentication

This example demonstrates how the MCP ecosystem continues to evolve, making AI tools more accessible and easier to deploy in production environments.

#MCP #AWS #Serverless #APIGateway #Lambda #AmazonBedrock #AI #CloudComputing #TypeScript