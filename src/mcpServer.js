import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";

const mcpServer = new McpServer({
  name: "simple-mcp-server-on-lambda",
  version: "0.0.1"
}, {
  capabilities: {
    tools: {}
  }
});

mcpServer.tool("ping", ()=>{
  return {
    content: [
      {
        type: "text",
        text: "pong"
      }
    ]
  }
});

export default mcpServer;
