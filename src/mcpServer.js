import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import log4js from 'log4js';

const l = log4js.getLogger('mcpServer');

const mcpServer = new McpServer({
  name: "simple-mcp-server-on-lambda",
  version: "0.0.1"
}, {
  capabilities: {
    tools: {}
  }
});

mcpServer.tool("ping", ()=>{
  l.debug('Executing ping tool');
  return {
    content: [
      {
        type: "text",
        text: "pong"
      }
    ]
  }
});

mcpServer.tool(
  "echo",
  "Echo the input parameters",
  {days: z.any()},
  (params) => {
    l.debug('Executing echo tool with params:', params);
    return {
      content: [
        {
          type: "text",
          text: params
        }
      ]
    };
  }
);

export default mcpServer;
