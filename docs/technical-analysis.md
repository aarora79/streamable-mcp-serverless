# Technical Analysis: Streamable MCP Server on AWS Lambda

## Overview of the Model Context Protocol (MCP) and Streamable HTTP

The Model Context Protocol (MCP) is an open standard for communication between AI applications and tools. The new `Streamable-HTTP` enhancement (as of the 2025-03-26 specification) represents a significant advancement in how MCP servers can be deployed, particularly in serverless environments.

## Implementation Details

### Server Implementation (`server.ts`)

The server implementation showcases several key aspects of the Streamable HTTP enhancement:

1. **Session Management**:
   ```typescript
   // Map to store transports by session ID
   const transports: { [sessionId: string]: StreamableHTTPServerTransport } = {};
   
   // Check for existing session ID in request headers
   const sessionId = req.headers['mcp-session-id'] as string | undefined;
   ```

2. **Transport Creation and Management**:
   ```typescript
   transport = new StreamableHTTPServerTransport({
     sessionIdGenerator: () => randomUUID(),
     eventStore, // Enable resumability
     onsessioninitialized: (sessionId) => {
       // Store the transport by session ID when session is initialized
       console.log(`Session initialized with ID: ${sessionId}`);
       transports[sessionId] = transport;
     }
   });
   ```

3. **HTTP Endpoint Handling**:
   ```typescript
   app.post('/prod/mcp', async (req: Request, res: Response) => {
     // Handle POST requests for JSON-RPC messages
   });
   
   app.get('/prod/mcp', async (req: Request, res: Response) => {
     // Handle GET requests for SSE streams
   });
   
   app.delete('/prod/mcp', async (req: Request, res: Response) => {
     // Handle DELETE requests for session termination
   });
   ```

4. **Lambda Integration**:
   ```typescript
   const isLambda = !!process.env.LAMBDA_TASK_ROOT;
   
   if (isLambda) {
     // Start the server
     handler = serverlessExpress({ app });
   } 
   ```

### Client Implementation (`client.ts`)

The client implementation demonstrates how to interact with a Streamable HTTP MCP server:

1. **Transport Creation**:
   ```typescript
   transport = new StreamableHTTPClientTransport(
     new URL(serverUrl),
     {
       sessionId: sessionId,
       debug: true,
       onnotification: (rawNotification) => {
         console.log('RAW NOTIFICATION RECEIVED:', JSON.stringify(rawNotification, null, 2));
       }
     }
   );
   ```

2. **Session Management**:
   ```typescript
   // Connect the client
   await client.connect(transport);
   sessionId = transport.sessionId
   console.log('Transport created with session ID:', sessionId);
   ```

3. **Session Termination**:
   ```typescript
   async function terminateSession(): Promise<void> {
     // ...
     await transport.terminateSession();
     // ...
   }
   ```

## Technical Innovations

### 1. Stateful Sessions in a Stateless Environment

The implementation solves a fundamental challenge: maintaining stateful sessions in a stateless serverless environment. This is achieved through:

- Generating a unique session ID for each client connection
- Storing the transport instance in a server-side map keyed by session ID
- Including the session ID in HTTP headers for subsequent requests

### 2. Resumability

The implementation supports resumability, allowing clients to reconnect and continue from where they left off:

```typescript
// Check for Last-Event-ID header for resumability
const lastEventId = req.headers['last-event-id'] as string | undefined;
if (lastEventId) {
  console.log(`Client reconnecting with Last-Event-ID: ${lastEventId}`);
}
```

### 3. Lambda and API Gateway Integration

The project demonstrates how to deploy an MCP server on AWS Lambda and API Gateway, which traditionally has been challenging due to:

- Lambda's ephemeral nature
- API Gateway's lack of native support for Server-Sent Events (SSE)

The Streamable HTTP enhancement addresses these challenges by:

- Using standard HTTP methods (POST, GET, DELETE) for different aspects of the protocol
- Implementing session management via HTTP headers
- Leveraging Lambda's HTTP streaming capabilities for Node.js runtimes

## Deployment Architecture

The deployment architecture consists of:

1. **API Gateway**: Provides the HTTP API endpoint
2. **Lambda Function**: Runs the containerized MCP server
3. **ECR**: Stores the Docker container image
4. **CloudWatch Logs**: Collects and stores logs from both the server and Bedrock usage

This architecture provides several benefits:

- **Scalability**: Lambda automatically scales based on request volume
- **Cost-effectiveness**: Pay only for actual usage
- **Simplified Operations**: No server management required
- **Security**: API Gateway provides authentication and authorization

## Practical Application: Bedrock Usage Analysis

The implementation includes tools for analyzing Amazon Bedrock usage, demonstrating a practical application of the MCP server:

```typescript
server.tool(
  "get_bedrock_usage_report",
  "Get Bedrock daily usage report (non-streaming)",
  // Schema definition...
  async (args, extra): Promise<CallToolResult> => {
    // Implementation...
  }
);
```

This tool aggregates and analyzes Bedrock usage data, providing insights into:

- Total requests and token usage
- Daily usage patterns
- Usage by region, model, and user

## Conclusion

This implementation demonstrates how the Streamable HTTP enhancement to the MCP protocol enables new deployment patterns, particularly in serverless environments. By leveraging AWS Lambda and API Gateway, it provides a scalable, cost-effective solution for deploying MCP servers without the operational overhead of managing traditional server infrastructure.

The project serves as a reference implementation for developers looking to deploy their own MCP servers in serverless environments, showcasing best practices for session management, error handling, and integration with AWS services.