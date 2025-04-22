import express, { Request, Response } from 'express';
import { randomUUID } from 'node:crypto';
import { z } from 'zod';


import { CloudWatchLogsClient, FilterLogEventsCommand } from "@aws-sdk/client-cloudwatch-logs"; // Added import
import serverlessExpress from '@codegenie/serverless-express';

import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { InMemoryEventStore } from "@modelcontextprotocol/sdk/examples/shared/inMemoryEventStore.js";

import { CallToolResult, GetPromptResult, isInitializeRequest, ReadResourceResult } from "@modelcontextprotocol/sdk/types.js";

// Create an MCP server with implementation details
const server = new McpServer({
  name: 'bedrock-usage-stats-http-server',
  version: '1.0.1',
}, { capabilities: { logging: {} } });

// Register a simple tool that returns a greeting
server.tool(
  'greet',
  'A simple greeting tool',
  {
    name: z.string().describe('Name to greet'),
  },
  async ({ name }): Promise<CallToolResult> => {
    return {
      content: [
        {
          type: 'text',
          text: `Hello, ${name}!`,
        },
      ],
    };
  }
);

// Register a tool that sends multiple greetings with notifications
server.tool(
  'multi-greet',
  'A tool that sends different greetings with delays between them',
  {
    name: z.string().describe('Name to greet'),
  },
  async ({ name }, { sendNotification }): Promise<CallToolResult> => {
    const sleep = (ms: number) => new Promise(resolve => setTimeout(resolve, ms));

    await sendNotification({
      method: "notifications/message",
      params: { level: "debug", data: `Starting multi-greet for ${name}` }
    });

    await sleep(1000); // Wait 1 second before first greeting

    await sendNotification({
      method: "notifications/message",
      params: { level: "info", data: `Sending first greeting to ${name}` }
    });

    await sleep(1000); // Wait another second before second greeting

    await sendNotification({
      method: "notifications/message",
      params: { level: "info", data: `Sending second greeting to ${name}` }
    });

    return {
      content: [
        {
          type: 'text',
          text: `Good morning, ${name}!`,
        }
      ],
    };
  }
);

// Register a simple prompt
server.prompt(
  'greeting-template',
  'A simple greeting prompt template',
  {
    name: z.string().describe('Name to include in greeting'),
  },
  async ({ name }): Promise<GetPromptResult> => {
    return {
      messages: [
        {
          role: 'user',
          content: {
            type: 'text',
            text: `Please greet ${name} in a friendly manner.`,
          },
        },
      ],
    };
  }
);

////////////////

// --- Bedrock Logs Tool ---

// Assume getAwsServiceClient is defined elsewhere or add its definition if needed
// Example placeholder:
async function getAwsServiceClient(clientConstructor: any, region: string, accountId?: string) {
    console.log(`Placeholder: Creating AWS client ${clientConstructor.name} for region ${region} (Account: ${accountId || 'default'})`);
    // Replace with actual AWS SDK client creation logic (e.g., using credentials)
    return new clientConstructor({ region });
}


const BedrockLogsParamsSchema = z.object({
    region: z.string().describe("AWS region for CloudWatch Logs"),
    log_group_name: z.string().describe("Name of the CloudWatch log group containing Bedrock logs"),
    days: z.number().int().positive().describe("Number of past days to fetch logs for"),
    aws_account_id: z.string().optional().describe("AWS Account ID if using cross-account access"),
});

// Helper: Get Bedrock Logs (Simplified version of Python's get_bedrock_logs)
// Note: Does not replicate pandas DataFrame creation/manipulation. Returns array of log objects.
const getBedrockLogs = async (params: z.infer<typeof BedrockLogsParamsSchema>) => {
  console.log("getBedrockLogs, params=", params);
  const client = await getAwsServiceClient(CloudWatchLogsClient, params.region, params.aws_account_id);

  const endTime = new Date();
  const startTime = new Date();
  startTime.setDate(endTime.getDate() - params.days);

  const startTimeMs = startTime.getTime();
  const endTimeMs = endTime.getTime();

  let filteredLogs: any[] = []; // Using any for simplicity here, define a specific type if preferred
  let nextToken: string | undefined;

  try {
    do {
      const command = new FilterLogEventsCommand({
        logGroupName: params.log_group_name,
        startTime: startTimeMs,
        endTime: endTimeMs,
        nextToken: nextToken,
      });

      const response = await client.send(command);
      const events = response.events || [];

      for (const event of events) {
        try {
          const message = JSON.parse(event.message);
          const inputTokens = message.input?.inputTokenCount ?? 0;
          const outputTokens = message.output?.outputTokenCount ?? 0;
          filteredLogs.push({
            timestamp: message.timestamp,
            region: message.region,
            modelId: message.modelId,
            userId: message.identity?.arn,
            inputTokens: inputTokens,
            completionTokens: outputTokens,
            totalTokens: inputTokens + outputTokens,
          });
        } catch (jsonError) {
          console.warn("Skipping non-JSON log message:", event.message);
        }
      }
      nextToken = response.nextToken;
    } while (nextToken);

    console.log(`Found ${filteredLogs.length} Bedrock log events.`);
    return filteredLogs;

  } catch (error: any) {
      if (error.name === 'ResourceNotFoundException') {
          console.error(`Log group '${params.log_group_name}' not found in region ${params.region}.`);
          return [];
      }
      console.error("Error retrieving Bedrock logs:", error);
      throw new Error(`Failed to retrieve Bedrock logs: ${error.message}`);
  }
};

// Tool: Bedrock Daily Usage Report (Non-Streaming Version)
server.tool(
    "get_bedrock_usage_report",
    "Get Bedrock daily usage report (non-streaming)",
    // Define schema directly as an object literal
    {
        region: z.string().describe("AWS region for CloudWatch Logs"),
        log_group_name: z.string().describe("Name of the CloudWatch log group containing Bedrock logs"),
        days: z.number().int().positive().describe("Number of past days to fetch logs for"),
        aws_account_id: z.string().optional().describe("AWS Account ID if using cross-account access"),
    },
    // Standard async function returning the full report
    async (args, extra): Promise<CallToolResult> => {
        console.log("Executing get_bedrock_report (non-streaming) with args:", args);
        try {
            const logs = await getBedrockLogs(args);

            if (!logs || logs.length === 0) {
                return { content: [{ type: "text", text: "No Bedrock usage data found for the specified period." }] };
            }

            // --- Data Aggregation (Same as before) ---
            const dailyStats: { [date: string]: { regions: any, models: any, users: any, requests: number, inputTokens: number, completionTokens: number, totalTokens: number } } = {};
            let totalRequests = 0;
            let totalInputTokens = 0;
            let totalCompletionTokens = 0;
            let totalTokens = 0;
            const regionSummary: { [region: string]: { requests: number, input: number, completion: number, total: number } } = {};
            const modelSummary: { [modelId: string]: { requests: number, input: number, completion: number, total: number } } = {};
            const userSummary: { [userId: string]: { requests: number, input: number, completion: number, total: number } } = {};

            logs.forEach(log => {
                totalRequests++;
                totalInputTokens += log.inputTokens || 0;
                totalCompletionTokens += log.completionTokens || 0;
                totalTokens += log.totalTokens || 0;
                const date = new Date(log.timestamp).toISOString().split('T')[0];
                if (!dailyStats[date]) {
                    dailyStats[date] = { regions: {}, models: {}, users: {}, requests: 0, inputTokens: 0, completionTokens: 0, totalTokens: 0 };
                }
                dailyStats[date].requests++;
                dailyStats[date].inputTokens += log.inputTokens || 0;
                dailyStats[date].completionTokens += log.completionTokens || 0;
                dailyStats[date].totalTokens += log.totalTokens || 0;
                if (!regionSummary[log.region]) regionSummary[log.region] = { requests: 0, input: 0, completion: 0, total: 0 };
                regionSummary[log.region].requests++;
                regionSummary[log.region].input += log.inputTokens || 0;
                regionSummary[log.region].completion += log.completionTokens || 0;
                regionSummary[log.region].total += log.totalTokens || 0;
                const simpleModelId = log.modelId?.includes('.') ? log.modelId.split('.').pop()! : log.modelId?.split('/').pop() || 'unknown';
                if (!modelSummary[simpleModelId]) modelSummary[simpleModelId] = { requests: 0, input: 0, completion: 0, total: 0 };
                modelSummary[simpleModelId].requests++;
                modelSummary[simpleModelId].input += log.inputTokens || 0;
                modelSummary[simpleModelId].completion += log.completionTokens || 0;
                modelSummary[simpleModelId].total += log.totalTokens || 0;
                 if (log.userId) {
                     if (!userSummary[log.userId]) userSummary[log.userId] = { requests: 0, input: 0, completion: 0, total: 0 };
                     userSummary[log.userId].requests++;
                     userSummary[log.userId].input += log.inputTokens || 0;
                     userSummary[log.userId].completion += log.completionTokens || 0;
                     userSummary[log.userId].total += log.totalTokens || 0;
                 }
            });

            // --- Formatting Output (Single String) ---
            let output = `Bedrock Daily Usage Report (Past ${args.days} days - ${args.region})\n`;
            output += `Total Requests: ${totalRequests}\n`;
            output += `Total Input Tokens: ${totalInputTokens}\n`;
            output += `Total Completion Tokens: ${totalCompletionTokens}\n`;
            output += `Total Tokens: ${totalTokens}\n`;

            output += "\n--- Daily Totals ---\n";
            Object.entries(dailyStats).sort(([dateA], [dateB]) => dateA.localeCompare(dateB)).forEach(([date, stats]) => {
                output += `${date}: Requests=${stats.requests}, Input=${stats.inputTokens}, Completion=${stats.completionTokens}, Total=${stats.totalTokens}\n`;
            });

            output += "\n--- Region Summary ---\n";
            Object.entries(regionSummary).forEach(([region, stats]) => {
                output += `${region}: Requests=${stats.requests}, Input=${stats.input}, Completion=${stats.completion}, Total=${stats.total}\n`;
            });

            output += "\n--- Model Summary ---\n";
            Object.entries(modelSummary).forEach(([model, stats]) => {
                output += `${model}: Requests=${stats.requests}, Input=${stats.input}, Completion=${stats.completion}, Total=${stats.total}\n`;
            });

            if (Object.keys(userSummary).length > 0) {
                output += "\n--- User Summary ---\n";
                Object.entries(userSummary).forEach(([user, stats]) => {
                    output += `${user}: Requests=${stats.requests}, Input=${stats.input}, Completion=${stats.completion}, Total=${stats.total}\n`;
                });
            }

            // Return the full report string
            return { content: [{ type: "text", text: output.trimEnd() }] };

        } catch (error: any) {
            console.error("Error in get_bedrock_report tool:", error);
            // Return an error result
            return { content: [{ type: "text", text: `Error getting Bedrock report: ${error.message}` }], isError: true };
        }
    }
);

////////////////

// Create a simple resource at a fixed URI
server.resource(
  'greeting-resource',
  'https://example.com/greetings/default',
  { mimeType: 'text/plain' },
  async (): Promise<ReadResourceResult> => {
    return {
      contents: [
        {
          uri: 'https://example.com/greetings/default',
          text: 'Hello, world!',
        },
      ],
    };
  }
);

const app = express();
app.use(express.json());

// Map to store transports by session ID
// TODO: Use a more efficient transport, like a Redis-based transport or maybe DynamoDB-based transport
const transports: { [sessionId: string]: StreamableHTTPServerTransport } = {};

app.post('/prod/mcp', async (req: Request, res: Response) => {
  console.log('Received MCP request:', req.body);
  try {
    // Check for existing session ID
    const sessionId = req.headers['mcp-session-id'] as string | undefined;
    let transport: StreamableHTTPServerTransport;

    if (sessionId && transports[sessionId]) {
      // Reuse existing transport
      transport = transports[sessionId];
    } else if (!sessionId && isInitializeRequest(req.body)) {
      // New initialization request
      const eventStore = new InMemoryEventStore();
      transport = new StreamableHTTPServerTransport({
        sessionIdGenerator: () => randomUUID(),
        eventStore, // Enable resumability
        onsessioninitialized: (sessionId) => {
          // Store the transport by session ID when session is initialized
          // This avoids race conditions where requests might come in before the session is stored
          console.log(`Session initialized with ID: ${sessionId}`);
          transports[sessionId] = transport;
        }
      });

      // Set up onclose handler to clean up transport when closed
      transport.onclose = () => {
        const sid = transport.sessionId;
        if (sid && transports[sid]) {
          console.log(`Transport closed for session ${sid}, removing from transports map`);
          delete transports[sid];
        }
      };

      // Connect the transport to the MCP server BEFORE handling the request
      // so responses can flow back through the same transport
      await server.connect(transport);

      await transport.handleRequest(req, res, req.body);
      return; // Already handled
    } else {
      // Invalid request - no session ID or not initialization request
      res.status(400).json({
        jsonrpc: '2.0',
        error: {
          code: -32000,
          message: 'Bad Request: No valid session ID provided',
        },
        id: null,
      });
      return;
    }

    // Handle the request with existing transport - no need to reconnect
    // The existing transport is already connected to the server
    await transport.handleRequest(req, res, req.body);
  } catch (error) {
    console.error('Error handling MCP request:', error);
    if (!res.headersSent) {
      res.status(500).json({
        jsonrpc: '2.0',
        error: {
          code: -32603,
          message: 'Internal server error',
        },
        id: null,
      });
    }
  }
});

// Handle GET requests for SSE streams (using built-in support from StreamableHTTP)
app.get('/prod/mcp', async (req: Request, res: Response) => {
  const sessionId = req.headers['mcp-session-id'] as string | undefined;
  if (!sessionId || !transports[sessionId]) {
    res.status(400).send('Invalid or missing session ID');
    return;
  }

  // Check for Last-Event-ID header for resumability
  const lastEventId = req.headers['last-event-id'] as string | undefined;
  if (lastEventId) {
    console.log(`Client reconnecting with Last-Event-ID: ${lastEventId}`);
  } else {
    console.log(`Establishing new SSE stream for session ${sessionId}`);
  }

  const transport = transports[sessionId];
  await transport.handleRequest(req, res);
});

// Handle DELETE requests for session termination (according to MCP spec)
app.delete('/prod/mcp', async (req: Request, res: Response) => {
  const sessionId = req.headers['mcp-session-id'] as string | undefined;
  if (!sessionId || !transports[sessionId]) {
    res.status(400).send('Invalid or missing session ID');
    return;
  }

  console.log(`Received session termination request for session ${sessionId}`);

  try {
    const transport = transports[sessionId];
    await transport.handleRequest(req, res);
  } catch (error) {
    console.error('Error handling session termination:', error);
    if (!res.headersSent) {
      res.status(500).send('Error processing session termination');
    }
  }
});

const isLambda = !!process.env.LAMBDA_TASK_ROOT;

let handler: any; // Declare handler outside the if block

if (isLambda) {
  // Start the server
  handler = serverlessExpress({ app });
  
} 
else {
  const PORT = 3000;
  app.listen(PORT, () => {
    console.log(`MCP Streamable HTTP Server listening on port ${PORT}`);
  });

  // Handle server shutdown
  process.on('SIGINT', async () => {
    console.log('Shutting down server...');

    // Close all active transports to properly clean up resources
    for (const sessionId in transports) {
      try {
        console.log(`Closing transport for session ${sessionId}`);
        await transports[sessionId].close();
        delete transports[sessionId];
      } catch (error) {
        console.error(`Error closing transport for session ${sessionId}:`, error);
      }
    }
    await server.close();
    console.log('Server shutdown complete');
    process.exit(0);
  });
}

// Export handler at the top level if it was assigned
if (handler) {
  exports.handler = handler;
}

