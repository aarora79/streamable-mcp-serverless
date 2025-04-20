import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import log4js from 'log4js';
import type { TextContent } from "@modelcontextprotocol/sdk/types.js"; // Import necessary types
import express, { Request, Response } from 'express';
import { randomUUID } from 'node:crypto';
import { CallToolResult } from '@modelcontextprotocol/sdk/types.js';
import { CloudWatchLogsClient, FilterLogEventsCommand } from "@aws-sdk/client-cloudwatch-logs"; // Added import

// Define an interface for the tool handler return type for clarity
interface ToolHandlerResult {
  content: TextContent[]; // Assuming only TextContent for now, adjust if other types are needed
  isError?: boolean;
}

const l = log4js.getLogger('mcpServer');

const server = new McpServer({
  name: 'simple-streamable-http-server',
  version: '1.0.0',
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

// Tool: Bedrock Daily Usage Stats (Notification Streaming Version)
server.tool(
    "get_bedrock_daily_usage_stats",
    "Get Bedrock daily usage stats",
    // Define schema directly as an object literal
    {
        region: z.string().describe("AWS region for CloudWatch Logs"),
        log_group_name: z.string().describe("Name of the CloudWatch log group containing Bedrock logs"),
        days: z.number().int().positive().describe("Number of past days to fetch logs for"),
        aws_account_id: z.string().optional().describe("AWS Account ID if using cross-account access"),
    },
    // Change to regular async function, use sendNotification
    async (args, { sendNotification }): Promise<CallToolResult> => {
        console.log("Executing get_bedrock_daily_usage_stats (notification streaming) with args:", args);
        try {
            // Send initial message via notification
            await sendNotification({
                method: "notifications/message",
                params: { level: "info", data: `Fetching Bedrock logs for the past ${args.days} days from ${args.log_group_name} in ${args.region}...` }
            });

            const logs = await getBedrockLogs(args);

            if (!logs || logs.length === 0) {
                 await sendNotification({
                    method: "notifications/message",
                    params: { level: "warning", data: "No Bedrock usage data found for the specified period." }
                });
                return { content: [{ type: "text", text: "No Bedrock usage data found." }] }; // Return simple final message
            }

            await sendNotification({
                method: "notifications/message",
                params: { level: "info", data: `Processing ${logs.length} log events...` }
            });

            // --- Data Aggregation (remains the same) ---
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

            // --- Formatting Output (via Notifications) ---
            let header = `Bedrock Usage Statistics (Past ${args.days} days - ${args.region})\n`;
            header += `Total Requests: ${totalRequests}\n`;
            header += `Total Input Tokens: ${totalInputTokens}\n`;
            header += `Total Completion Tokens: ${totalCompletionTokens}\n`;
            header += `Total Tokens: ${totalTokens}`;
            await sendNotification({ method: "notifications/message", params: { level: "info", data: header } });

            let dailyOutput = "\n--- Daily Totals ---\n";
            Object.entries(dailyStats).sort(([dateA], [dateB]) => dateA.localeCompare(dateB)).forEach(([date, stats]) => {
                dailyOutput += `${date}: Requests=${stats.requests}, Input=${stats.inputTokens}, Completion=${stats.completionTokens}, Total=${stats.totalTokens}\n`;
            });
            await sendNotification({ method: "notifications/message", params: { level: "info", data: dailyOutput.trimEnd() } });

            let regionOutput = "\n--- Region Summary ---\n";
            Object.entries(regionSummary).forEach(([region, stats]) => {
                regionOutput += `${region}: Requests=${stats.requests}, Input=${stats.input}, Completion=${stats.completion}, Total=${stats.total}\n`;
            });
            await sendNotification({ method: "notifications/message", params: { level: "info", data: regionOutput.trimEnd() } });

            let modelOutput = "\n--- Model Summary ---\n";
            Object.entries(modelSummary).forEach(([model, stats]) => {
                modelOutput += `${model}: Requests=${stats.requests}, Input=${stats.input}, Completion=${stats.completion}, Total=${stats.total}\n`;
            });
             await sendNotification({ method: "notifications/message", params: { level: "info", data: modelOutput.trimEnd() } });

            if (Object.keys(userSummary).length > 0) {
                 let userOutput = "\n--- User Summary ---\n";
                 Object.entries(userSummary).forEach(([user, stats]) => {
                     userOutput += `${user}: Requests=${stats.requests}, Input=${stats.input}, Completion=${stats.completion}, Total=${stats.total}\n`;
                 });
                 await sendNotification({ method: "notifications/message", params: { level: "info", data: userOutput.trimEnd() } });
            }

            await sendNotification({ method: "notifications/message", params: { level: "info", data: "\nAnalysis complete." } });

            // Return a final simple result
            return { content: [{ type: "text", text: "Bedrock usage analysis finished. See notifications for details." }] };

        } catch (error: any) {
            console.error("Error in get_bedrock_daily_usage_stats tool:", error);
             await sendNotification({
                method: "notifications/message",
                params: { level: "error", data: `Error getting Bedrock daily stats: ${error.message}` }
            });
            // Return an error result with type 'text'
            return { content: [{ type: "text", text: `Error getting Bedrock daily stats: ${error.message}` }], isError: true };
        }
    }
);

// Tool: Bedrock Daily Usage Report (Non-Streaming Version)
server.tool(
    "get_bedrock_report",
    "Get Bedrock daily usage report",
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

export default server; 